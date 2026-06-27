import { randomUUID } from 'node:crypto';

import { SignJWT, generateKeyPair, type KeyLike } from 'jose';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * End-to-end auth lifecycle (Sprint 1 STEP 9). Runs against REAL Postgres +
 * Redis through the REAL buildApp() — only the two external boundaries are
 * mocked: Supabase (no real auth backend in CI) and the JWKS fetch (we mint our
 * own RS256 tokens against a locally generated keypair, exactly as
 * auth.plugin.test does). Everything in between — route wiring, the auth plugin,
 * services, the DB, the cache — is the production code path.
 */

const h = vi.hoisted(() => ({
  keyHolder: { publicKey: undefined as unknown as KeyLike },
  inviteUserByEmail: vi.fn(),
  updateUserById: vi.fn(),
  generateLink: vi.fn(),
  adminSignOut: vi.fn(),
  enrollFactor: vi.fn(),
  refreshSession: vi.fn(),
}));

// Resolve the JWKS to our local public key instead of fetching Supabase's.
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createRemoteJWKSet: () => async () => h.keyHolder.publicKey };
});

// Fake Supabase admin client — only the methods the lifecycle touches.
vi.mock('../../src/lib/supabase.js', () => ({
  supabaseAdmin: {
    auth: {
      refreshSession: h.refreshSession,
      admin: {
        inviteUserByEmail: h.inviteUserByEmail,
        updateUserById: h.updateUserById,
        generateLink: h.generateLink,
        signOut: h.adminSignOut,
        // No verifyFactor: matches the installed admin SDK, so verifyMfa trusts
        // the client's own Supabase verification (see AuthService.verifyMfa).
        mfa: { enrollFactor: h.enrollFactor },
      },
    },
  },
}));

// Imported AFTER the mocks above are declared (vitest hoists vi.mock).
import { buildApp } from '../../src/app.js';
import { db, pool } from '../../src/lib/db.js';
import { env } from '../../src/lib/env.js';
import { redis } from '../../src/lib/redis.js';

const USER_EMAIL = 'lifecycle@example.com';
const ADMIN_EMAIL = `lifecycle-admin-${Date.now()}@lifecycle.itest`;
const ISSUER = `${env.SUPABASE_URL}/auth/v1`;

let app: Awaited<ReturnType<typeof buildApp>>;
let privateKey: KeyLike;
let adminUid: string;

function signToken(sub: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setExpirationTime('1h')
    .sign(privateKey);
}

const fixtures = {
  async createAdminAndGetToken(): Promise<string> {
    adminUid = randomUUID();
    await db
      .insertInto('staff')
      .values({
        name: 'Lifecycle Admin',
        email: ADMIN_EMAIL,
        role: 'admin',
        active: true,
        mfa_enrolled: false,
        supabase_uid: adminUid,
      })
      .execute();
    return signToken(adminUid);
  },
  /** "Sign in" = mint a token for the user's Supabase UID (Supabase is mocked). */
  async signInAndGetToken(email: string, _password?: string): Promise<string> {
    const row = await db
      .selectFrom('staff')
      .select('supabase_uid')
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    return signToken(row.supabase_uid!);
  },
  async invalidateCache(supabaseUid: string): Promise<void> {
    await redis.del(`staff_lookup:${supabaseUid}`);
  },
};

/** Minimal multipart/form-data body the signup route can parse. */
function multipart(fields: Record<string, string>) {
  const boundary = `----lifecycle${Math.random().toString(36).slice(2)}`;
  const body =
    Object.entries(fields)
      .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
      .join('') + `--${boundary}--\r\n`;
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function cleanup() {
  // FK order: invite_links.created_by / signup_requests.reviewed_by → staff.id.
  await db.deleteFrom('invite_links').where('email', '=', USER_EMAIL).execute();
  await db.deleteFrom('signup_requests').where('email', '=', USER_EMAIL).execute();
  await db.deleteFrom('staff').where('email', 'in', [ADMIN_EMAIL, USER_EMAIL]).execute();
}

beforeAll(async () => {
  const { publicKey, privateKey: priv } = await generateKeyPair('RS256');
  h.keyHolder.publicKey = publicKey;
  privateKey = priv;

  h.inviteUserByEmail.mockImplementation(async () => ({
    data: { user: { id: randomUUID() } },
    error: null,
  }));
  h.updateUserById.mockImplementation(async (id: string) => ({
    data: { user: { id } },
    error: null,
  }));
  h.generateLink.mockResolvedValue({ data: { properties: { action_link: 'x' } }, error: null });
  h.adminSignOut.mockResolvedValue({ data: null, error: null });
  h.enrollFactor.mockResolvedValue({
    data: {
      id: 'factor-life',
      totp: {
        qr_code: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQ==',
        secret: 'JBSWY3DPEHPK3PXP',
        uri: 'otpauth://totp/Scaly?secret=JBSWY3DPEHPK3PXP',
      },
    },
    error: null,
  });

  await cleanup();
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await cleanup();
  await app.close();
  await pool.end();
  redis.disconnect();
});

describe('Auth lifecycle', () => {
  it('walks invite → signup → login → mfa enroll/verify → sign out → password reset → re-login → deactivation', async () => {
    const adminToken = await fixtures.createAdminAndGetToken();

    // 1. Admin invites a new team member.
    const inviteRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/invite',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { email: USER_EMAIL, role: 'team_member' },
    });
    expect(inviteRes.statusCode).toBe(201);
    const { token: inviteToken } = JSON.parse(inviteRes.payload);

    // 2. New user consumes the invite (sets password, creates the staff row).
    const signupRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup/invite',
      payload: {
        token: inviteToken,
        password: 'TestPass123!',
        name: 'Lifecycle Tester',
        dateOfBirth: '1995-01-01',
        mobileNumber: '+919876543210',
      },
    });
    expect(signupRes.statusCode).toBe(201);

    const userUid = (
      await db
        .selectFrom('staff')
        .select('supabase_uid')
        .where('email', '=', USER_EMAIL)
        .executeTakeFirstOrThrow()
    ).supabase_uid!;

    // 3. User "logs in" (Supabase mocked — we mint a token for their UID).
    let userToken = await fixtures.signInAndGetToken(USER_EMAIL, 'TestPass123!');

    // 4. GET /v1/staff/me returns the right shape.
    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/staff/me',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    const me = JSON.parse(meRes.payload);
    expect(me.role).toBe('team_member');
    expect(me.mfaEnrolled).toBe(false);
    expect(me.permissions['module.settings_audit_log.read']).toBe(false); // not an admin

    // 5. Admin CAN list signup-requests (settings area, admin-only).
    const adminListRes = await app.inject({
      method: 'GET',
      url: '/v1/settings/signup-requests',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminListRes.statusCode).toBe(200);

    // 6. Team member hitting an admin-only endpoint → 403. (Email must be valid
    //    so the request clears body validation and actually reaches requireRole,
    //    which runs in a preHandler — Fastify validates the body first.)
    const forbiddenRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/invite',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { email: 'newhire@example.com', role: 'team_member' },
    });
    expect(forbiddenRes.statusCode).toBe(403);
    expect(JSON.parse(forbiddenRes.payload).error.code).toBe('PERMISSION_DENIED');

    // 7. Self-signup with the same email → H-04 ALREADY_PROCESSED.
    const dupRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup/request',
      ...multipart({
        name: 'Dup User',
        email: USER_EMAIL,
        dateOfBirth: '1995-01-01',
        mobileNumber: '+919876543210',
        roleRequested: 'team_member',
      }),
    });
    expect(dupRes.statusCode).toBe(409);
    expect(JSON.parse(dupRes.payload).error.code).toBe('ALREADY_PROCESSED');

    // 8. MFA enroll → QR data URL + 10 recovery codes; flag stays false.
    const enrollRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enroll',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(enrollRes.statusCode).toBe(200);
    const enroll = JSON.parse(enrollRes.payload);
    expect(enroll.qrCodeDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(enroll.recoveryCodes).toHaveLength(10);

    // 9. MFA verify → 204, flag flips, cache evicted.
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { factorId: enroll.factorId, code: '123456' },
    });
    expect(verifyRes.statusCode).toBe(204);

    // 10. /me now reflects mfaEnrolled = true (re-read from DB after eviction).
    const me2 = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/staff/me',
          headers: { authorization: `Bearer ${userToken}` },
        })
      ).payload,
    );
    expect(me2.mfaEnrolled).toBe(true);

    // 11. Sign out → 204.
    const signOutRes = await app.inject({
      method: 'DELETE',
      url: '/v1/auth/session',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(signOutRes.statusCode).toBe(204);
    expect(h.adminSignOut).toHaveBeenCalled();

    // 12. Password reset for the known email → always 200, link generated.
    const resetRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset',
      payload: { email: USER_EMAIL },
    });
    expect(resetRes.statusCode).toBe(200);
    expect(h.generateLink).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery', email: USER_EMAIL }),
    );

    // 13. Sign in again (fresh token) still resolves the same user.
    userToken = await fixtures.signInAndGetToken(USER_EMAIL, 'NewPass456!');
    const meAgain = await app.inject({
      method: 'GET',
      url: '/v1/staff/me',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(meAgain.statusCode).toBe(200);

    // 14. Deactivate (admin path is Sprint 11 — stub via direct DB update), then
    //     the next request is rejected with ACCOUNT_DEACTIVATED.
    await db.updateTable('staff').set({ active: false }).where('email', '=', USER_EMAIL).execute();
    await fixtures.invalidateCache(userUid);
    const deactRes = await app.inject({
      method: 'GET',
      url: '/v1/staff/me',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(deactRes.statusCode).toBe(403);
    expect(JSON.parse(deactRes.payload).error.code).toBe('ACCOUNT_DEACTIVATED');
  });

  it('exposes every Sprint 1 auth route on the OpenAPI spec (/docs, M-12)', () => {
    const spec = (app as unknown as { swagger: () => { paths: Record<string, unknown> } }).swagger();
    const paths = Object.keys(spec.paths);
    for (const expected of [
      '/v1/auth/invite',
      '/v1/auth/signup/invite',
      '/v1/auth/signup/request',
      '/v1/auth/password-reset',
      '/v1/auth/refresh',
      '/v1/auth/session',
      '/v1/auth/mfa/enroll',
      '/v1/auth/mfa/verify',
      '/v1/auth/signup-requests/me/status',
      '/v1/auth/signup-requests/{id}/approve',
      '/v1/auth/signup-requests/{id}/reject',
      '/v1/settings/signup-requests',
      '/v1/staff/me',
      '/v1/staff/{id}/mfa/reset',
    ]) {
      expect(paths, `missing ${expected} in OpenAPI spec`).toContain(expected);
    }
  });
});
