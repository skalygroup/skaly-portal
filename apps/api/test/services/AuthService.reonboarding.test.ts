import { randomUUID } from 'node:crypto';

import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

import { AuthService } from '../../src/services/AuthService.js';
import { currentIstPeriod } from '../../src/services/BaseService.js';

import type { DB } from '@skaly/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

/**
 * ADR-026 — re-onboarding, and the audit A4 regression.
 *
 * A4 in one sentence: an offboarded employee could never be re-hired. The
 * approval path pre-checked `staff` by email with no `deleted_at` filter, found
 * the tombstone, and marked the request `rejected` with "Account already exists
 * at approval time" — a sentence that is false about a deleted row. It did not
 * crash, which is why it survived: the failure mode was a plausible-looking
 * rejection, not a stack trace.
 *
 * The fix is two halves and BOTH are asserted here, because either alone leaves
 * the bug: migration 031's partial index (a new row becomes possible) and the
 * approval path's detect-and-offer-reinstate (the false rejection is gone and the
 * person keeps their history).
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const DOMAIN = '@reonboard.itest';
const email = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${DOMAIN}`;
const ADMIN_ID = '11111111-1111-1111-1111-111111111111'; // seeded admin

const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const createUser = vi.fn(async () => ({ data: { user: { id: randomUUID() } }, error: null }));
const generateLink = vi.fn(async () => ({
  data: { properties: { action_link: 'https://reset.example/abc' } },
  error: null,
}));
const signOut = vi.fn(async () => ({ error: null }));
const supabaseAdmin = {
  auth: { admin: { createUser, generateLink, signOut } },
} as unknown as SupabaseClient;

const redis = { set: vi.fn(), get: vi.fn(async () => null), del: vi.fn() } as unknown as Redis;
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const service = new AuthService(db, redis, supabaseAdmin, logger, {} as never, 'test-bucket');
const PERIOD = currentIstPeriod();

async function makeStaff(addr: string, over: Record<string, unknown> = {}) {
  return db
    .insertInto('staff')
    .values({
      name: 'Returning Employee',
      email: addr,
      role: 'team_member',
      active: true,
      supabase_uid: randomUUID(),
      ...over,
    })
    .returning(['id', 'email'])
    .executeTakeFirstOrThrow();
}

async function makePending(addr: string) {
  return db
    .insertInto('signup_requests')
    .values({
      name: 'Returning Employee',
      email: addr,
      date_of_birth: '1995-06-15',
      mobile_number: '+11234567890',
      role_requested: 'team_member',
      status: 'pending',
    })
    .returning(['id', 'email'])
    .executeTakeFirstOrThrow();
}

async function cleanup() {
  const ids = (
    await db.selectFrom('staff').select('id').where('email', 'like', `%${DOMAIN}`).execute()
  ).map((s) => s.id);
  if (ids.length) {
    await db.deleteFrom('attendance_logs').where('staff_id', 'in', ids).execute();
    await db.deleteFrom('notifications').where('staff_id', 'in', ids).execute();
  }
  await db.deleteFrom('signup_requests').where('email', 'like', `%${DOMAIN}`).execute();
  if (ids.length) await db.deleteFrom('staff').where('id', 'in', ids).execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values({ id: ADMIN_ID, name: 'Admin User', email: 'admin@test.skaly.in', role: 'admin', active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await db.destroy();
});

beforeEach(() => vi.clearAllMocks());

describe('migration 031 — the partial unique index', () => {
  test('a soft-deleted row no longer occupies the email', async () => {
    const addr = email('freed');
    const dead = await makeStaff(addr);
    await db
      .updateTable('staff')
      .set({ deleted_at: sql`now()`, active: false })
      .where('id', '=', dead.id)
      .execute();

    // Under the old UNIQUE (email) this threw 23505 and the person was unhireable.
    const fresh = await makeStaff(addr, { name: 'Brand New Person' });
    expect(fresh.id).not.toBe(dead.id);
  });

  test('two LIVE rows still cannot share an email', async () => {
    const addr = email('collide');
    await makeStaff(addr);
    // The guarantee that matters survives: at most one ACTIVE row per address.
    await expect(makeStaff(addr)).rejects.toMatchObject({ code: '23505' });
  });
});

describe('⭐ A4 — approval detects a former employee instead of rejecting them', () => {
  test('a soft-deleted row yields the reinstate suggestion, and the request stays pending', async () => {
    const addr = email('a4');
    const former = await makeStaff(addr);
    await service.deactivateStaff(former.id, ADMIN_ID);
    const req = await makePending(addr);

    const err = await service
      .approveSignupRequest(req.id, 'team_member', ADMIN_ID)
      .then(() => null)
      .catch((e: unknown) => e as { code: string; statusCode: number; message: string; details?: Record<string, unknown> });

    expect(err, 'approval must not succeed silently').not.toBeNull();
    expect(err!.code).toBe('ALREADY_PROCESSED');
    expect(err!.statusCode).toBe(409);

    // The actionable half — this is what the UI turns into a [Reinstate] button.
    expect(err!.details).toMatchObject({ previousStaffId: former.id, suggestion: 'reinstate' });
    expect(typeof err!.details!.deactivatedAt).toBe('string');

    // The old false sentence is gone, and nothing was written.
    const after = await db
      .selectFrom('signup_requests')
      .select(['status', 'rejection_note'])
      .where('id', '=', req.id)
      .executeTakeFirstOrThrow();
    expect(after.status, 'a pending request an admin can act on beats a false rejection').toBe('pending');
    expect(after.rejection_note).toBeNull();
    expect(createUser, 'no Supabase user may be created on this path').not.toHaveBeenCalled();
  });

  test('a LIVE row is still rejected — that outcome was always correct', async () => {
    const addr = email('live');
    await makeStaff(addr);
    const req = await makePending(addr);

    await expect(service.approveSignupRequest(req.id, 'team_member', ADMIN_ID)).rejects.toMatchObject({
      code: 'ALREADY_PROCESSED',
    });
    const after = await db
      .selectFrom('signup_requests')
      .select(['status', 'rejection_note'])
      .where('id', '=', req.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('rejected');
    expect(after.rejection_note).toBe('Account already exists at approval time');
  });

  test('with no staff row at all, approval proceeds normally', async () => {
    const req = await makePending(email('clean'));
    const result = await service.approveSignupRequest(req.id, 'team_member', ADMIN_ID);
    expect(result.staffId).toBeTruthy();
    expect(createUser).toHaveBeenCalledOnce();
  });
});

describe('AuthService.reactivateStaff', () => {
  test('reinstates the ORIGINAL row, fires account_reactivated, and audits it', async () => {
    const addr = email('reinstate');
    const former = await makeStaff(addr);
    await service.deactivateStaff(former.id, ADMIN_ID);

    const result = await service.reactivateStaff(former.id, ADMIN_ID);
    expect(result.staffId, 'the same id — history and audit trail intact').toBe(former.id);

    const row = await db
      .selectFrom('staff')
      .select(['active', 'deleted_at'])
      .where('id', '=', former.id)
      .executeTakeFirstOrThrow();
    expect(row.active).toBe(true);
    expect(row.deleted_at).toBeNull();

    const notif = await db
      .selectFrom('notifications')
      .select('type')
      .where('staff_id', '=', former.id)
      .where('type', '=', 'account_reactivated')
      .executeTakeFirst();
    expect(notif, 'the enum value that existed for exactly this since Sprint 10').toBeDefined();

    const audited = await db
      .selectFrom('audit_log')
      .select('new_value')
      .where('record_id', '=', former.id)
      .where('table_name', '=', 'staff')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(audited.new_value)).toContain('reinstated');
  });

  test('MFA state is preserved, not silently cleared', async () => {
    const addr = email('mfa');
    const former = await makeStaff(addr, { mfa_enrolled: true });
    await service.deactivateStaff(former.id, ADMIN_ID);
    await service.reactivateStaff(former.id, ADMIN_ID);

    const row = await db
      .selectFrom('staff')
      .select('mfa_enrolled')
      .where('id', '=', former.id)
      .executeTakeFirstOrThrow();
    // Clearing it would drop a returning admin into /mfa-setup with no way back.
    // The explicit, audited downgrade is PUT /v1/staff/:id/mfa/reset.
    expect(row.mfa_enrolled).toBe(true);
  });

  test('⭐ a live row holding the same email → 409, not a Postgres unique violation', async () => {
    const addr = email('taken');
    const former = await makeStaff(addr);
    await service.deactivateStaff(former.id, ADMIN_ID);
    // Only possible since the index went partial — which is exactly why the
    // pre-check has to exist (ADR-026 §5).
    await makeStaff(addr, { name: 'Current Holder' });

    const err = await service
      .reactivateStaff(former.id, ADMIN_ID)
      .then(() => null)
      .catch((e: unknown) => e as { code: string; statusCode: number; message: string });

    expect(err).not.toBeNull();
    expect(err!.code).toBe('ALREADY_PROCESSED');
    expect(err!.statusCode).toBe(409);
    expect(err!.message, 'a clear message, not "duplicate key value violates..."').toContain(addr);
  });

  test('an already-active staff member → ALREADY_PROCESSED', async () => {
    const live = await makeStaff(email('active'));
    await expect(service.reactivateStaff(live.id, ADMIN_ID)).rejects.toMatchObject({
      code: 'ALREADY_PROCESSED',
    });
  });

  test('an unknown id → 404', async () => {
    await expect(
      service.reactivateStaff('e0000000-0000-4000-8000-0000000dead0', ADMIN_ID),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('AuthService.deactivateStaff', () => {
  test('soft-deletes, deactivates, evicts the cache and revokes the Supabase session', async () => {
    const target = await makeStaff(email('deact'));
    await service.deactivateStaff(target.id, ADMIN_ID);

    const row = await db
      .selectFrom('staff')
      .select(['active', 'deleted_at'])
      .where('id', '=', target.id)
      .executeTakeFirstOrThrow();
    expect(row.active).toBe(false);
    expect(row.deleted_at).not.toBeNull();

    // Ours is the enforcement layer (auth.plugin answers ACCOUNT_DEACTIVATED once
    // the cached lookup is gone); signOut is the courtesy that ends the session.
    expect(redis.del).toHaveBeenCalled();
    expect(signOut).toHaveBeenCalled();
  });

  test('an admin cannot deactivate themselves', async () => {
    await expect(service.deactivateStaff(ADMIN_ID, ADMIN_ID)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });
});
