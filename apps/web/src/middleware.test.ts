// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the route-guard middleware. We mock @supabase/ssr (so no real
 * auth server is hit) and global fetch (the /v1/staff/me authorization call),
 * then drive the middleware with constructed NextRequests and assert the
 * redirect target — the behaviour the portal's security depends on.
 */

const auth = {
  getUser: vi.fn(),
  getSession: vi.fn(),
  signOut: vi.fn(),
};

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth })),
}));

// Imported after the mock is registered.
import { middleware } from './middleware';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  NEXT_PUBLIC_API_URL: 'http://api.test',
};

function req(path: string) {
  return new NextRequest(new URL(path, 'http://localhost:3000'));
}

/** Same, but carrying a Supabase session cookie — a session worth preserving. */
function reqWithSession(path: string) {
  return new NextRequest(new URL(path, 'http://localhost:3000'), {
    headers: { cookie: 'sb-testproject-auth-token=base64-abc' },
  });
}

/** What auth-js hands back when the auth host never answered. */
function transportFailure() {
  const err = new Error('Failed to fetch');
  err.name = 'AuthRetryableFetchError';
  return err;
}

/** A minimal unsigned JWT carrying just the `aal` claim — the middleware reads
 *  the claim without verifying the signature. */
function jwtWithAal(aal: string): string {
  const payload = Buffer.from(JSON.stringify({ aal })).toString('base64url');
  return `header.${payload}.sig`;
}
function sessionWith(token: string) {
  return { data: { session: { access_token: token } } };
}

function meResponse(status: number, body?: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body ?? {},
  } as Response;
}

beforeEach(() => {
  Object.assign(process.env, ENV);
  auth.getUser.mockReset();
  auth.getSession.mockReset();
  auth.signOut.mockReset().mockResolvedValue(undefined);
  auth.getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('middleware', () => {
  it('redirects an unauthenticated request to /login', async () => {
    auth.getUser.mockResolvedValue({ data: { user: null } });

    const res = await middleware(req('/'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
    // No session → never reaches the /me authorization fetch.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('redirects an admin without MFA to /mfa-setup', async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      meResponse(200, { role: 'admin', mfaEnrolled: false }),
    );

    const res = await middleware(req('/'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/mfa-setup');
  });

  it('does NOT redirect when an unenrolled admin is already on /mfa-setup', async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      meResponse(200, { role: 'admin', mfaEnrolled: false }),
    );

    const res = await middleware(req('/mfa-setup'));

    // Passes through (NextResponse.next), no redirect.
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('signs out and redirects a deactivated account to /login?error=deactivated', async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      meResponse(401, { error: { code: 'ACCOUNT_DEACTIVATED' } }),
    );

    const res = await middleware(req('/'));

    expect(auth.signOut).toHaveBeenCalledOnce();
    expect(res.status).toBe(307);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/login');
    expect(location).toContain('error=deactivated');
  });

  it('signs out and redirects a NO_STAFF_ROW (401) account the same way', async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      meResponse(401, { error: { code: 'NO_STAFF_ROW' } }),
    );

    const res = await middleware(req('/'));

    expect(auth.signOut).toHaveBeenCalledOnce();
    expect(res.headers.get('location')).toContain('error=deactivated');
  });

  it('redirects an enrolled admin whose session is still aal1 to /mfa-challenge', async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    auth.getSession.mockResolvedValue(sessionWith(jwtWithAal('aal1')));
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      meResponse(200, { role: 'admin', mfaEnrolled: true }),
    );

    const res = await middleware(req('/'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/mfa-challenge');
  });

  it('lets an enrolled admin with an aal2 session through', async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    auth.getSession.mockResolvedValue(sessionWith(jwtWithAal('aal2')));
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      meResponse(200, { role: 'admin', mfaEnrolled: true }),
    );

    const res = await middleware(req('/'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('does NOT redirect when an aal1 enrolled admin is already on /mfa-challenge (no loop)', async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    auth.getSession.mockResolvedValue(sessionWith(jwtWithAal('aal1')));
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      meResponse(200, { role: 'admin', mfaEnrolled: true }),
    );

    const res = await middleware(req('/mfa-challenge'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('fails closed: an enrolled admin whose token has no aal claim is challenged', async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    auth.getSession.mockResolvedValue(sessionWith('opaque-no-jwt'));
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      meResponse(200, { role: 'admin', mfaEnrolled: true }),
    );

    const res = await middleware(req('/'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/mfa-challenge');
  });

  /**
   * ── A third-party blip must not read as a logout ──────────────────────
   *
   * The reported bug: enter the TOTP code, get sent back to /login. Two
   * independent paths did that, and both mistook "could not reach the auth
   * server" for "this user is not allowed in".
   */
  describe('an unreachable auth server is not a logout', () => {
    it('does NOT bounce a cookie-carrying session to /login when getUser() fails in transit', async () => {
      auth.getUser.mockResolvedValue({ data: { user: null }, error: transportFailure() });

      const res = await middleware(reqWithSession('/'));

      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      expect(auth.signOut).not.toHaveBeenCalled();
    });

    it('still sends a request with NO session cookie to /login on the same failure', async () => {
      auth.getUser.mockResolvedValue({ data: { user: null }, error: transportFailure() });

      const res = await middleware(req('/'));

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('/login');
    });

    it('still sends a genuinely session-less request to /login (no error at all)', async () => {
      auth.getUser.mockResolvedValue({ data: { user: null }, error: null });

      const res = await middleware(reqWithSession('/'));

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('/login');
    });

    it('does NOT sign out on a 401 INVALID_TOKEN — the API could not verify, that is not a verdict', async () => {
      auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        meResponse(401, { error: { code: 'INVALID_TOKEN' } }),
      );

      const res = await middleware(req('/'));

      expect(auth.signOut).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
    });

    it('does NOT sign out on a 503 AUTH_UNAVAILABLE from the API', async () => {
      auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        meResponse(503, { error: { code: 'AUTH_UNAVAILABLE' } }),
      );

      const res = await middleware(req('/'));

      expect(auth.signOut).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
    });

    /**
     * The exact reported symptom: an aal2 session, freshly stepped up by a
     * correct TOTP code, must never land back on /login because /me blipped.
     */
    it('keeps a just-verified aal2 admin in the portal when /me answers 503', async () => {
      auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
      auth.getSession.mockResolvedValue(sessionWith(jwtWithAal('aal2')));
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        meResponse(503, { error: { code: 'AUTH_UNAVAILABLE' } }),
      );

      const res = await middleware(reqWithSession('/'));

      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      expect(auth.signOut).not.toHaveBeenCalled();
    });
  });

  it('lets an enrolled member through', async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      meResponse(200, { role: 'team_member', mfaEnrolled: false }),
    );

    const res = await middleware(req('/'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });
});
