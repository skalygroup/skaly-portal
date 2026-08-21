import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import type { StaffMeResponse } from '@skaly/shared/schemas/auth';

import { isAuthTransportError } from '@/lib/auth-errors';

/**
 * Edge middleware — the server-side gate for every protected route (Sprint 1
 * STEP 14, IMPL-PLAN §4.2). Client-side guards are belt-and-suspenders; this is
 * the source of truth.
 *
 * On each protected request it:
 *   a. reads the session from cookies and refreshes it via getUser() (Supabase
 *      SSR docs), writing any rotated tokens onto the response Set-Cookie;
 *   b. no session → /login;
 *   c. fetches /v1/staff/me (cached API-side by Redis staff_lookup:{uid}, 5-min
 *      TTL — we forward the same bearer so the API hits cache). 401
 *      ACCOUNT_DEACTIVATED or 401 NO_STAFF_ROW → sign out + /login?error=deactivated;
 *   d. admin/manager without MFA, not already on /mfa-setup → /mfa-setup;
 *   e. admin/manager WITH MFA but a session that hasn't cleared the TOTP step
 *      (aal ≠ aal2), not already on /mfa-challenge → /mfa-challenge;
 *   f. otherwise pass.
 *
 * Unexpected /me failures (network, 5xx) fail open — a transient API hiccup
 * shouldn't lock everyone out, and the API re-checks on every real call.
 */
export async function middleware(request: NextRequest) {
  // The response we mutate cookies onto. Recreated by setAll so refreshed tokens
  // ride back to the browser even when we ultimately pass the request through.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // a. Refresh + validate the session against the auth server.
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  /**
   * b. No session → login.
   *
   * ⚠️ "The auth host never answered" is NOT "you have no session". getUser()
   * reports both as `user === null`, so a blip used to bounce a signed-in user
   * to /login — most visibly right after the TOTP challenge, where clearing MFA
   * correctly and landing back on the login page looks like the code was
   * rejected.
   *
   * Fail open ONLY when the request actually carries a session cookie to
   * preserve, and only for a transport failure. This grants no data: the API
   * verifies the JWT on every call and the server-side fetchers forward the same
   * bearer, so an unverifiable cookie renders a shell with nothing in it. The
   * alternative — discarding a valid session because a third party was briefly
   * unreachable — is the worse failure, and it is the one users actually hit.
   */
  if (!user) {
    if (userError && isAuthTransportError(userError) && hasSessionCookie(request)) {
      return response;
    }
    return redirectTo(request, response, '/login');
  }

  const path = request.nextUrl.pathname;

  // c. Authorise via /v1/staff/me (forward the bearer so the API hits its cache).
  const {
    data: { session },
  } = await supabase.auth.getSession();

  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/v1/staff/me`, {
      headers: { authorization: `Bearer ${session?.access_token ?? ''}` },
      cache: 'no-store',
    });

    if (res.status === 401) {
      /**
       * Only a real authorisation VERDICT may destroy the session.
       *
       * This used to sign out on any 401 — but the API also answers 401 with
       * INVALID_TOKEN when IT could not verify the token, which during a
       * Supabase outage meant every request. A third-party blip therefore
       * revoked good sessions and told people their account was deactivated.
       * (The API now answers 503 for that case — see auth-verify.ts — so this is
       * also the client half of the same fix, and it keeps an older API safe.)
       */
      const code = await res
        .json()
        .then((b) => b?.error?.code as string | undefined)
        .catch(() => undefined);

      if (code === 'ACCOUNT_DEACTIVATED' || code === 'NO_STAFF_ROW') {
        await supabase.auth.signOut();
        return redirectTo(request, response, '/login', 'error=deactivated');
      }
      // Not attributable to this user's standing — fail open like a 5xx.
      return response;
    }

    if (res.ok) {
      const me = (await res.json()) as StaffMeResponse;
      const privileged = me.role === 'admin' || me.role === 'manager';
      // d. Admin/manager must finish MFA enrollment before entering the portal.
      if (privileged && me.mfaEnrolled === false && path !== '/mfa-setup') {
        return redirectTo(request, response, '/mfa-setup');
      }
      // e. An enrolled admin/manager must have stepped the session up to aal2 (the
      // TOTP challenge). A bare password login is aal1 — bounce to /mfa-challenge.
      // Fail closed: an unreadable/absent aal is treated as not-aal2. No loop —
      // /mfa-challenge is outside the matcher and guarded here too.
      if (
        privileged &&
        me.mfaEnrolled === true &&
        path !== '/mfa-challenge' &&
        readAal(session?.access_token) !== 'aal2'
      ) {
        return redirectTo(request, response, '/mfa-challenge');
      }
    }
    // Any other status (e.g. 5xx) falls through and passes — fail open.
  } catch {
    // Network error reaching the API — pass through rather than brick the portal.
  }

  // e. Pass, carrying any refreshed Set-Cookie headers.
  return response;
}

/**
 * Does the request carry a Supabase session cookie? @supabase/ssr names them
 * `sb-<project-ref>-auth-token`, chunked as `.0`, `.1`, … past 4KB.
 *
 * Used only to decide whether there is a session worth preserving through an
 * auth-server outage — never as proof of one. The API is the boundary.
 */
function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some((c) => c.name.startsWith('sb-') && c.name.includes('-auth-token'));
}

/**
 * Read the `aal` (authenticator assurance level) claim from a Supabase access
 * token, without verifying the signature — getUser() already validated the
 * session; we only need the claim to decide whether the TOTP step is done.
 * Edge-runtime safe (atob + TextDecoder, no Buffer). Any decode failure returns
 * undefined, which the caller treats as "not aal2" (fail closed).
 */
function readAal(token: string | undefined): string | undefined {
  const segment = token?.split('.')[1];
  if (!segment) return undefined;
  try {
    const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return typeof payload.aal === 'string' ? payload.aal : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a redirect that preserves the cookies Supabase may have just rotated
 * onto `source` (otherwise a token refresh during a redirect would be lost).
 */
function redirectTo(
  request: NextRequest,
  source: NextResponse,
  pathname: string,
  search = '',
): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = search;
  const redirect = NextResponse.redirect(url);
  source.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  return redirect;
}

export const config = {
  /**
   * Run on the protected surface — (portal) routes, /settings, and / — but not
   * the public auth pages, Next internals, the API proxy, or static files.
   *
   * /mfa-setup and /mfa-challenge are excluded: they're (auth)-group pages reached
   * via the (d)/(e) redirects, and they self-protect (their Supabase calls need a
   * session). The path !== guards in (d)/(e) are the belt-and-suspenders
   * counterpart — they keep each redirect idempotent even if this matcher widens.
   */
  matcher: [
    '/((?!login|signup|forgot-password|reset-password|mfa-setup|mfa-challenge|auth|api|_next/static|_next/image|favicon.ico|brand|.*\\.).*)',
  ],
};
