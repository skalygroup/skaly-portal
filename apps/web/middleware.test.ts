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
