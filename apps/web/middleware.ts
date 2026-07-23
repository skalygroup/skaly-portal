import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import type { StaffMeResponse } from '@skaly/shared/schemas/auth';

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
  } = await supabase.auth.getUser();

  // b. No session → login.
  if (!user) {
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
      // ACCOUNT_DEACTIVATED / NO_STAFF_ROW (both 401) — revoke and bounce out.
      await supabase.auth.signOut();
      return redirectTo(request, response, '/login', 'error=deactivated');
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
