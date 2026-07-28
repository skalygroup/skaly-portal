import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { Redis } from 'ioredis';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

import { sessionMfaRoutes } from '../../src/routes/auth/session-mfa.js';
import staffRoutes from '../../src/routes/staff/index.js';
import { AuthService } from '../../src/services/AuthService.js';

import type { AuthUser } from '../../src/middleware/auth.plugin.js';
import type { DB } from '@skaly/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from 'pino';

/**
 * The recovery ROUTE tests below register the real `sessionMfaRoutes`, which
 * builds its own AuthService from the module-level singletons. Those construct a
 * live Supabase client and an R2 client from env at import time, so both are
 * replaced here. Everything else in this file drives `service` directly and uses
 * the local mock instead.
 */
vi.mock('../../src/lib/supabase.js', () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        mfa: {
          listFactors: vi.fn(async () => ({ data: { factors: [] }, error: null })),
          deleteFactor: vi.fn(async () => ({ data: null, error: null })),
        },
      },
    },
  },
}));
vi.mock('../../src/lib/r2.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getR2Client: () => ({}) as never,
  getR2Bucket: () => 'test-bucket',
}));

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
const resetPasswordForEmail = vi.fn(async () => ({ data: {}, error: null }));
const updateUserById = vi.fn(async () => ({ data: { user: { id: 'user-abc' } }, error: null }));
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
    resetPasswordForEmail,
    admin: {
      generateLink,
      updateUserById,
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
  // ON DELETE CASCADE clears mfa_recovery_codes when the staff row goes, but
  // audit_log has a plain FK on staff_id — clear those rows first.
  const ids = (
    await db.selectFrom('staff').select('id').where('email', 'like', `%${DOMAIN}`).execute()
  ).map((r) => r.id);
  if (ids.length) {
    await db.deleteFrom('audit_log').where('staff_id', 'in', ids).execute();
    await db.deleteFrom('staff').where('id', 'in', ids).execute();
  }
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
  test('known active email → 200-shaped result, recovery email sent', async () => {
    const staff = await insertStaff();
    const res = await service.requestPasswordReset(staff.email);
    expect(res).toEqual({ status: 'sent' });
    expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);
    expect(resetPasswordForEmail).toHaveBeenCalledWith(
      staff.email,
      expect.objectContaining({ redirectTo: expect.any(String) }),
    );
  });

  test('unknown email → same result, no email sent (anti-enumeration)', async () => {
    const res = await service.requestPasswordReset(email('ghost'));
    expect(res).toEqual({ status: 'sent' });
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  test('inactive staff is treated as unknown (no email)', async () => {
    const staff = await insertStaff({ active: false });
    await service.requestPasswordReset(staff.email);
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  test('timing: unknown-email latency mimics known-email latency (anti-enumeration)', async () => {
    const staff = await insertStaff();
    const SAMPLES = 10;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

    // Warm + measure the matched path (this also populates the rolling average
    // the unmatched path will mimic).
    const knownDurations: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = performance.now();
      await service.requestPasswordReset(staff.email);
      knownDurations.push(performance.now() - t0);
    }

    // Measure the unmatched path — it should now sleep ~avg(known) ± jitter.
    const unknownDurations: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = performance.now();
      await service.requestPasswordReset(email('ghost-timing'));
      unknownDurations.push(performance.now() - t0);
    }

    // Statistical overlap, not exact equality: the two means sit within a 200ms
    // window (generous for setTimeout granularity + the ±20ms jitter). The point
    // is that the unmatched path is NOT dramatically faster — that gap is the
    // enumeration leak this calibration closes.
    expect(Math.abs(mean(unknownDurations) - mean(knownDurations))).toBeLessThan(200);
  });
});

// ── Password update (admin API, bypasses "Secure password change") ────────
describe('AuthService.updateOwnPassword', () => {
  test('writes the new password via the admin API', async () => {
    const staff = await insertStaff();
    await service.updateOwnPassword(staff.id, staff.supabase_uid!, 'NewPassw0rd!');
    expect(updateUserById).toHaveBeenCalledTimes(1);
    expect(updateUserById).toHaveBeenCalledWith(staff.supabase_uid, { password: 'NewPassw0rd!' });
  });

  test('admin API error → PASSWORD_UPDATE_FAILED', async () => {
    const staff = await insertStaff();
    updateUserById.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'boom' },
    } as never);
    await expect(
      service.updateOwnPassword(staff.id, staff.supabase_uid!, 'NewPassw0rd!'),
    ).rejects.toMatchObject({ code: 'PASSWORD_UPDATE_FAILED', statusCode: 400 });
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

// ── Recovery-code redeem (Sprint 11 STEP 8) ──────────────────────────────
/**
 * The availability hole carried since Sprint 8 STEP 8.4: codes have been
 * generated and stored with no way to spend them, while MFA is mandatory for
 * admin and manager. The documented fallback is another admin's `mfa/reset`,
 * which cannot help when the locked-out person IS the only admin.
 */
describe('AuthService.redeemRecoveryCode', () => {
  /** Enrol, then hand back the plaintext codes the user would have printed. */
  async function enrolled(over: Record<string, unknown> = {}) {
    const staff = await insertStaff({ mfa_enrolled: true, ...over });
    const { recoveryCodes } = await service.enrollMfa(staff.id, staff.supabase_uid!);
    await db
      .updateTable('staff')
      .set({ mfa_enrolled: true })
      .where('id', '=', staff.id)
      .execute();
    await redis.del(`mfa:fail:${staff.id}`);
    return { staff, recoveryCodes };
  }

  const remaining = (staffId: string) =>
    db
      .selectFrom('mfa_recovery_codes')
      .select('id')
      .where('staff_id', '=', staffId)
      .where('used_at', 'is', null)
      .execute();

  test('⭐ a valid code is spent once, clears the factor, and leaves the others usable', async () => {
    const { staff, recoveryCodes } = await enrolled();
    await redis.set(cacheKey(staff.supabase_uid!), JSON.stringify({ id: staff.id }), 'EX', 300);

    const out = await service.redeemRecoveryCode(staff.id, staff.supabase_uid!, recoveryCodes[0]!);

    expect(out.remainingCodes).toBe(9);

    // The redeemed row is consumed and ONLY that row. resetMfa drops the whole
    // set, which is right for an admin reset and wrong here — someone who
    // abandons /mfa-setup halfway would have spent their one way back in.
    expect(await remaining(staff.id)).toHaveLength(9);

    // Unenrolled + factor gone, so the middleware routes them to /mfa-setup.
    const row = await db
      .selectFrom('staff')
      .select('mfa_enrolled')
      .where('id', '=', staff.id)
      .executeTakeFirstOrThrow();
    expect(row.mfa_enrolled).toBe(false);
    expect(deleteFactor).toHaveBeenCalledWith({ id: 'factor-xyz', userId: staff.supabase_uid });
    expect(await redis.get(cacheKey(staff.supabase_uid!))).toBeNull();
  });

  test('⭐ the same code a second time → MFA_FAILED (single use, enforced in the DB)', async () => {
    const { staff, recoveryCodes } = await enrolled();
    await service.redeemRecoveryCode(staff.id, staff.supabase_uid!, recoveryCodes[0]!);

    await expect(
      service.redeemRecoveryCode(staff.id, staff.supabase_uid!, recoveryCodes[0]!),
    ).rejects.toMatchObject({ code: 'MFA_FAILED', statusCode: 403 });
  });

  test('spacing and case a user adds are theirs, not the secret’s', async () => {
    const { staff, recoveryCodes } = await enrolled();
    const typed = ` ${recoveryCodes[0]!.toUpperCase().slice(0, 5)}-${recoveryCodes[0]!.slice(5)} `;
    const out = await service.redeemRecoveryCode(staff.id, staff.supabase_uid!, typed);
    expect(out.remainingCodes).toBe(9);
  });

  test('a code belonging to SOMEONE ELSE is not a match', async () => {
    const mine = await enrolled();
    const theirs = await enrolled();

    await expect(
      service.redeemRecoveryCode(mine.staff.id, mine.staff.supabase_uid!, theirs.recoveryCodes[0]!),
    ).rejects.toMatchObject({ code: 'MFA_FAILED' });
    // ...and theirs is still unspent.
    expect(await remaining(theirs.staff.id)).toHaveLength(10);
  });

  test('⭐ three failed codes → MFA_LOCKED, and a VALID code is refused while locked', async () => {
    const { staff, recoveryCodes } = await enrolled();

    for (let i = 0; i < 3; i++) {
      await expect(
        service.redeemRecoveryCode(staff.id, staff.supabase_uid!, 'ffffffffff'),
      ).rejects.toMatchObject({ code: 'MFA_FAILED' });
    }

    // The 4th attempt is refused before the compare — a good code included, or
    // the lockout would only slow down people who guess wrong.
    await expect(
      service.redeemRecoveryCode(staff.id, staff.supabase_uid!, recoveryCodes[0]!),
    ).rejects.toMatchObject({ code: 'MFA_LOCKED', statusCode: 403 });
    expect(await remaining(staff.id)).toHaveLength(10);
  });

  test('⭐ TOTP and recovery failures share ONE budget — 2 bad TOTP + 1 bad code = locked', async () => {
    const { staff, recoveryCodes } = await enrolled();

    // The login challenge runs client-side against Supabase, so a failed TOTP
    // reaches the server through recordMfaFailure (POST /v1/auth/mfa/failure).
    await service.recordMfaFailure(staff.id);
    await service.recordMfaFailure(staff.id);

    await expect(
      service.redeemRecoveryCode(staff.id, staff.supabase_uid!, 'ffffffffff'),
    ).rejects.toMatchObject({ code: 'MFA_FAILED' });

    // Separate counters would have left 2 recovery attempts here. One budget
    // means the gate is shut. That is the whole reason it is one key.
    await expect(
      service.redeemRecoveryCode(staff.id, staff.supabase_uid!, recoveryCodes[0]!),
    ).rejects.toMatchObject({ code: 'MFA_LOCKED' });
  });

  test('a successful redeem clears the budget', async () => {
    const { staff, recoveryCodes } = await enrolled();
    await service.recordMfaFailure(staff.id);
    await service.recordMfaFailure(staff.id);

    await service.redeemRecoveryCode(staff.id, staff.supabase_uid!, recoveryCodes[0]!);

    expect(await redis.get(`mfa:fail:${staff.id}`)).toBeNull();
  });

  test('the lockout window is 15 minutes from the FIRST failure, not rolling', async () => {
    const { staff } = await enrolled();
    await service.recordMfaFailure(staff.id);
    const first = await redis.ttl(`mfa:fail:${staff.id}`);
    await service.recordMfaFailure(staff.id);
    const second = await redis.ttl(`mfa:fail:${staff.id}`);

    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(900);
    // Not extended — otherwise a persistent attacker holds the lock open forever.
    expect(second).toBeLessThanOrEqual(first);
  });

  test('⭐ the audit row names it a recovery redeem, distinctly from a TOTP login', async () => {
    const { staff, recoveryCodes } = await enrolled();
    await service.redeemRecoveryCode(staff.id, staff.supabase_uid!, recoveryCodes[0]!);

    const row = await db
      .selectFrom('audit_log')
      .select(['new_value', 'changed_by_source', 'action'])
      .where('staff_id', '=', staff.id)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();

    expect(row.changed_by_source).toBe('user');
    expect(row.action).toBe('UPDATE');
    const after = row.new_value as Record<string, unknown>;
    expect(after.event).toBe('mfa_recovery_code_redeemed');
    expect(after.remainingCodes).toBe(9);
    // The code itself is never written anywhere, in any form.
    expect(JSON.stringify(row.new_value)).not.toContain(recoveryCodes[0]!);
  });

  test('remainingRecoveryCodes counts unconsumed rows only', async () => {
    const { staff, recoveryCodes } = await enrolled();
    expect(await service.remainingRecoveryCodes(staff.id)).toBe(10);
    await service.redeemRecoveryCode(staff.id, staff.supabase_uid!, recoveryCodes[0]!);
    expect(await service.remainingRecoveryCodes(staff.id)).toBe(9);
  });

  test('regenerate invalidates the old set and issues 10 fresh ones', async () => {
    const { staff, recoveryCodes } = await enrolled();
    const { recoveryCodes: fresh } = await service.regenerateRecoveryCodes(staff.id);

    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(recoveryCodes[0]);
    expect(await service.remainingRecoveryCodes(staff.id)).toBe(10);

    // An old code is now worthless — the set was replaced, not appended to.
    await expect(
      service.redeemRecoveryCode(staff.id, staff.supabase_uid!, recoveryCodes[0]!),
    ).rejects.toMatchObject({ code: 'MFA_FAILED' });
    // ...and a fresh one works.
    await expect(
      service.redeemRecoveryCode(staff.id, staff.supabase_uid!, fresh[0]!),
    ).resolves.toMatchObject({ remainingCodes: 9 });
  });

  test('a user with no codes at all cannot be let in by an empty candidate list', async () => {
    const staff = await insertStaff({ mfa_enrolled: true });
    await redis.del(`mfa:fail:${staff.id}`);
    // Zero rows means zero comparisons — the loop must fall through to MFA_FAILED
    // rather than "no mismatch found, therefore a match".
    await expect(
      service.redeemRecoveryCode(staff.id, staff.supabase_uid!, 'ffffffffff'),
    ).rejects.toMatchObject({ code: 'MFA_FAILED' });
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

// ── The recovery ROUTES: who may reach them, and with what assurance ─────
describe('/v1/auth/mfa/recovery — the gate around the gate', () => {
  let asUser: AuthUser | undefined;
  let app: FastifyInstance;

  /** An unsigned JWT carrying just the `aal` claim — the route only reads it. */
  const bearer = (aal: string) =>
    `Bearer x.${Buffer.from(JSON.stringify({ aal })).toString('base64url')}.y`;

  beforeAll(async () => {
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error: FastifyError, _req, reply) =>
      reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: error.message } }),
    );
    app.decorate('db', db);
    app.decorate('redis', redis);
    app.decorate('verifyJwt', async (req: { user?: AuthUser }, reply: FastifyReply) => {
      if (!asUser) {
        return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'No session.' } });
      }
      req.user = asUser;
    });
    await app.register(sessionMfaRoutes, { prefix: '/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test('⭐ an unauthenticated caller cannot enumerate or spend codes', async () => {
    asUser = undefined;
    for (const [method, url] of [
      ['GET', '/v1/auth/mfa/recovery'],
      ['POST', '/v1/auth/mfa/recovery'],
      ['POST', '/v1/auth/mfa/recovery/regenerate'],
    ] as const) {
      const res = await app.inject({ method, url, payload: { code: 'ffffffffff' } });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  test('the count endpoint returns a NUMBER and never the codes themselves', async () => {
    const staff = await insertStaff({ mfa_enrolled: true });
    await service.enrollMfa(staff.id, staff.supabase_uid!);
    asUser = {
      id: staff.id,
      supabase_uid: staff.supabase_uid!,
      name: 'Me',
      email: staff.email,
      role: 'admin',
      active: true,
      mfa_enrolled: true,
      avatar_url: null,
    };

    const res = await app.inject({ method: 'GET', url: '/v1/auth/mfa/recovery' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ remainingCodes: 10 });
    // The serializer strips anything not in the schema; assert on the wire bytes
    // so a future field carrying a hash cannot slip through unnoticed.
    expect(res.payload).not.toMatch(/code_hash|codeHash|recoveryCodes/);
  });

  test('⭐ redeem does NOT require aal2 — that is the point of it', async () => {
    const staff = await insertStaff({ mfa_enrolled: true });
    const { recoveryCodes } = await service.enrollMfa(staff.id, staff.supabase_uid!);
    await redis.del(`mfa:fail:${staff.id}`);
    asUser = {
      id: staff.id,
      supabase_uid: staff.supabase_uid!,
      name: 'Me',
      email: staff.email,
      role: 'admin',
      active: true,
      mfa_enrolled: true,
      avatar_url: null,
    };

    // aal1: password done, authenticator not. Exactly the caller this is for.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/recovery',
      headers: { authorization: bearer('aal1') },
      payload: { code: recoveryCodes[0] },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ remainingCodes: 9 });
  });

  test('⭐ regenerate DOES require aal2 — a stolen password must not mint codes', async () => {
    const staff = await insertStaff({ mfa_enrolled: true });
    await service.enrollMfa(staff.id, staff.supabase_uid!);
    asUser = {
      id: staff.id,
      supabase_uid: staff.supabase_uid!,
      name: 'Me',
      email: staff.email,
      role: 'admin',
      active: true,
      mfa_enrolled: true,
      avatar_url: null,
    };

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/recovery/regenerate',
      headers: { authorization: bearer('aal1') },
    });
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.payload).error.code).toBe('MFA_REQUIRED');

    const allowed = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/recovery/regenerate',
      headers: { authorization: bearer('aal2') },
    });
    expect(allowed.statusCode).toBe(200);
    expect(JSON.parse(allowed.payload).recoveryCodes).toHaveLength(10);
  });
});
