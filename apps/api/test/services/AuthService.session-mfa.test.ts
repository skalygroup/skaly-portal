import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { Redis } from 'ioredis';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

import staffRoutes from '../../src/routes/staff/index.js';
import { AuthService } from '../../src/services/AuthService.js';

import type { AuthUser } from '../../src/middleware/auth.plugin.js';
import type { DB } from '@skaly/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';

// Integration test: real local Postgres + Redis (docker), Supabase mocked.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const DOMAIN = '@session-mfa.itest';
const email = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${DOMAIN}`;

const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
redis.on('error', () => {}); // silence connection noise in CI

// ── Supabase mock ────────────────────────────────────────────────────────
// generateLink already covered by approve-reject; here we exercise the
// recovery + session + MFA surfaces. verifyFactor is intentionally OMITTED to
// match the installed admin SDK (2.108.2 has no admin verify) — verifyMfa must
// then trust the client's own Supabase verification and just flip the flag.
const generateLink = vi.fn(async () => ({
  data: { properties: { action_link: 'https://reset.example/abc' } },
  error: null,
}));
const refreshSession = vi.fn();
const adminSignOut = vi.fn(async () => ({ data: null, error: null }));
const enrollFactor = vi.fn(async () => ({
  data: {
    id: 'factor-abc',
    totp: {
      qr_code: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQ==',
      secret: 'JBSWY3DPEHPK3PXP',
      uri: 'otpauth://totp/Scaly?secret=JBSWY3DPEHPK3PXP',
    },
  },
  error: null,
}));
const listFactors = vi.fn(async () => ({ data: { factors: [{ id: 'factor-xyz' }] }, error: null }));
const deleteFactor = vi.fn(async () => ({ data: { id: 'factor-xyz' }, error: null }));

const supabaseAdmin = {
  auth: {
    refreshSession,
    admin: {
      generateLink,
      signOut: adminSignOut,
      mfa: { enrollFactor, listFactors, deleteFactor },
    },
  },
} as unknown as SupabaseClient;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const service = new AuthService(db, redis, supabaseAdmin, logger, {} as never, 'test-bucket');
const cacheKey = (uid: string) => `staff_lookup:${uid}`;

async function insertStaff(over: Record<string, unknown> = {}) {
  return db
    .insertInto('staff')
    .values({
      name: 'Session User',
      email: email('user'),
      role: 'team_member',
      active: true,
      mfa_enrolled: false,
      supabase_uid: randomUUID(),
      ...over,
    })
    .returning(['id', 'email', 'supabase_uid', 'role'])
    .executeTakeFirstOrThrow();
}

async function cleanup() {
  // ON DELETE CASCADE clears mfa_recovery_codes when the staff row goes.
  await db.deleteFrom('staff').where('email', 'like', `%${DOMAIN}`).execute();
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await db.destroy();
  redis.disconnect();
});
beforeEach(() => vi.clearAllMocks());

// ── Password reset (anti-enumeration) ────────────────────────────────────
describe('AuthService.requestPasswordReset', () => {
  test('known active email → 200-shaped result, generateLink called', async () => {
    const staff = await insertStaff();
    const res = await service.requestPasswordReset(staff.email);
    expect(res).toEqual({ status: 'sent' });
    expect(generateLink).toHaveBeenCalledTimes(1);
    expect(generateLink).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery', email: staff.email }),
    );
  });

  test('unknown email → same result, generateLink NOT called (anti-enumeration)', async () => {
    const res = await service.requestPasswordReset(email('ghost'));
    expect(res).toEqual({ status: 'sent' });
    expect(generateLink).not.toHaveBeenCalled();
  });

  test('inactive staff is treated as unknown (no link)', async () => {
    const staff = await insertStaff({ active: false });
    await service.requestPasswordReset(staff.email);
    expect(generateLink).not.toHaveBeenCalled();
  });
});

// ── Session refresh ──────────────────────────────────────────────────────
describe('AuthService.refreshSession', () => {
  test('valid refresh token → new session', async () => {
    refreshSession.mockResolvedValueOnce({
      data: {
        session: { access_token: 'new-access', refresh_token: 'new-refresh', expires_at: 1893456000 },
      },
      error: null,
    });
    const out = await service.refreshSession('good-token');
    expect(out).toEqual({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: 1893456000,
    });
  });

  test('invalid refresh token → 401 INVALID_REFRESH_TOKEN', async () => {
    refreshSession.mockResolvedValueOnce({
      data: { session: null },
      error: { message: 'invalid token' },
    });
    await expect(service.refreshSession('bad-token')).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
      statusCode: 401,
    });
  });
});

// ── Sign out ─────────────────────────────────────────────────────────────
describe('AuthService.signOut', () => {
  test('revokes the JWT and clears staff_lookup:{uid} from Redis', async () => {
    const uid = randomUUID();
    await redis.set(cacheKey(uid), JSON.stringify({ id: 'x' }), 'EX', 300);
    expect(await redis.get(cacheKey(uid))).not.toBeNull();

    await service.signOut(uid, 'the-jwt');

    expect(adminSignOut).toHaveBeenCalledWith('the-jwt');
    expect(await redis.get(cacheKey(uid))).toBeNull();
  });
});

// ── MFA enroll / verify / reset ──────────────────────────────────────────
describe('AuthService MFA lifecycle', () => {
  test('enroll → QR data URL + factorId + 10 codes; mfa_enrolled STAYS false', async () => {
    const staff = await insertStaff();
    const out = await service.enrollMfa(staff.id, staff.supabase_uid!);

    expect(out.factorId).toBe('factor-abc');
    expect(out.qrCodeDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(out.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(out.recoveryCodes).toHaveLength(10);

    // Flag must NOT flip on enroll — only verify confirms it.
    const row = await db
      .selectFrom('staff')
      .select('mfa_enrolled')
      .where('id', '=', staff.id)
      .executeTakeFirstOrThrow();
    expect(row.mfa_enrolled).toBe(false);

    // Codes are persisted only as hashes, never as plaintext.
    const stored = await db
      .selectFrom('mfa_recovery_codes')
      .select('code_hash')
      .where('staff_id', '=', staff.id)
      .execute();
    expect(stored).toHaveLength(10);
    const hashes = stored.map((s) => s.code_hash);
    for (const code of out.recoveryCodes) {
      expect(hashes).not.toContain(code); // plaintext never stored
    }
  });

  test('re-enroll replaces the prior recovery-code set (still 10)', async () => {
    const staff = await insertStaff();
    await service.enrollMfa(staff.id, staff.supabase_uid!);
    await service.enrollMfa(staff.id, staff.supabase_uid!);
    const stored = await db
      .selectFrom('mfa_recovery_codes')
      .select('id')
      .where('staff_id', '=', staff.id)
      .execute();
    expect(stored).toHaveLength(10);
  });

  test('verify → mfa_enrolled becomes true and cache is evicted', async () => {
    const staff = await insertStaff();
    await redis.set(cacheKey(staff.supabase_uid!), JSON.stringify({ id: staff.id }), 'EX', 300);

    await service.verifyMfa(staff.id, staff.supabase_uid!, 'factor-abc', '123456');

    const row = await db
      .selectFrom('staff')
      .select('mfa_enrolled')
      .where('id', '=', staff.id)
      .executeTakeFirstOrThrow();
    expect(row.mfa_enrolled).toBe(true);
    expect(await redis.get(cacheKey(staff.supabase_uid!))).toBeNull();
  });

  test('reset (admin) → flag back to false, Supabase factor deleted, codes cleared', async () => {
    const admin = await insertStaff({ role: 'admin' });
    const target = await insertStaff({ mfa_enrolled: true });
    await service.enrollMfa(target.id, target.supabase_uid!); // give them codes to clear

    await service.resetMfa(target.id, admin.id);

    expect(listFactors).toHaveBeenCalledWith({ userId: target.supabase_uid });
    expect(deleteFactor).toHaveBeenCalledWith({ id: 'factor-xyz', userId: target.supabase_uid });

    const row = await db
      .selectFrom('staff')
      .select('mfa_enrolled')
      .where('id', '=', target.id)
      .executeTakeFirstOrThrow();
    expect(row.mfa_enrolled).toBe(false);

    const codes = await db
      .selectFrom('mfa_recovery_codes')
      .select('id')
      .where('staff_id', '=', target.id)
      .execute();
    expect(codes).toHaveLength(0);
  });

  test('reset on a missing staff id → 404 NOT_FOUND', async () => {
    await expect(service.resetMfa(randomUUID(), randomUUID())).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });
});

// ── GET /v1/staff/me (role + permissions baseline) ───────────────────────
describe('GET /v1/staff/me', () => {
  // Mount the real route with a stubbed verifyJwt that injects request.user, so
  // we exercise the handler + schema serialization without minting a real JWT.
  let asUser: AuthUser;
  async function buildApp() {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db);
    app.decorate('redis', redis);
    app.decorate('verifyJwt', async (req: { user?: AuthUser }) => {
      req.user = asUser;
    });
    app.decorate('requireRole', () => async () => {});
    await app.register(staffRoutes, { prefix: '/v1' });
    await app.ready();
    return app;
  }

  function authUser(over: Partial<AuthUser>): AuthUser {
    return {
      id: randomUUID(),
      supabase_uid: randomUUID(),
      name: 'Me',
      email: email('me'),
      role: 'team_member',
      active: true,
      mfa_enrolled: false,
      avatar_url: null,
      ...over,
    };
  }

  test('admin sees admin-only permissions in the baseline', async () => {
    const staff = await insertStaff({ role: 'admin' });
    asUser = authUser({ id: staff.id, role: 'admin', email: staff.email });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/staff/me' });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.role).toBe('admin');
    expect(body.permissions['module.settings_audit_log.read']).toBe(true);
    expect(body.permissions['module.settings_permissions.write']).toBe(true);
    expect(body.permissions['months.unlock']).toBe(true);
  });

  test('freelancer baseline withholds admin/staff modules and chat', async () => {
    const staff = await insertStaff({ role: 'freelancer' });
    asUser = authUser({ id: staff.id, role: 'freelancer', email: staff.email });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/staff/me' });
    await app.close();

    const body = JSON.parse(res.payload);
    expect(body.role).toBe('freelancer');
    expect(body.permissions['module.settings_audit_log.read']).toBe(false);
    expect(body.permissions['module.attendance.read']).toBe(false);
    expect(body.permissions['chat.access']).toBe(false);
    // Freelancers still get their own shoot rows.
    expect(body.permissions['module.shoot_planner.read']).toBe(true);
  });
});
