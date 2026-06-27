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
 *      TTL — we forward the same bearer so the API hits cache). 403
 *      ACCOUNT_DEACTIVATED or 401 NO_STAFF_ROW → sign out + /login?error=deactivated;
 *   d. admin/manager without MFA, not already on /mfa-setup → /mfa-setup;
 *   e. otherwise pass.
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

    if (res.status === 403 || res.status === 401) {
      // ACCOUNT_DEACTIVATED (403) / NO_STAFF_ROW (401) — revoke and bounce out.
      await supabase.auth.signOut();
      return redirectTo(request, response, '/login', 'error=deactivated');
    }

    if (res.ok) {
      const me = (await res.json()) as StaffMeResponse;
      // d. Admin/manager must finish MFA enrollment before entering the portal.
      if (
        (me.role === 'admin' || me.role === 'manager') &&
        me.mfaEnrolled === false &&
        path !== '/mfa-setup'
      ) {
        return redirectTo(request, response, '/mfa-setup');
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
   * /mfa-setup is excluded: it's an (auth)-group page reached via the (d)
   * redirect, and it self-protects (its enroll call 401s without a session). The
   * path !== '/mfa-setup' guard in (d) is the belt-and-suspenders counterpart —
   * it keeps the redirect idempotent even if this matcher ever widens.
   */
  matcher: [
    '/((?!login|signup|forgot-password|reset-password|mfa-setup|auth|api|_next/static|_next/image|favicon.ico|brand|.*\\.).*)',
  ],
};
