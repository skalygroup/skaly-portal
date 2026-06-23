import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DB } from '@skaly/shared';
import { AuthService } from '../../src/services/AuthService.js';
import { signupStatusRoutes } from '../../src/routes/auth/signup-status.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const DOMAIN = '@approve.itest';
const email = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${DOMAIN}`;
const REVIEWER_ID = '11111111-1111-1111-1111-111111111111'; // seeded admin

const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

// ── Supabase mock (createUser + generateLink) ───────────────────────────
const createUser = vi.fn(async () => ({ data: { user: { id: randomUUID() } }, error: null }));
const generateLink = vi.fn(async () => ({
  data: { properties: { action_link: 'https://reset.example/abc' } },
  error: null,
}));
const supabaseAdmin = {
  auth: { admin: { createUser, generateLink } },
} as unknown as SupabaseClient;

const redis = { set: vi.fn(), get: vi.fn(async () => null), del: vi.fn() } as unknown as Redis;
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const service = new AuthService(db, redis, supabaseAdmin, logger, {} as never, 'test-bucket');

const PERIOD = new Date().toISOString().slice(0, 7);

/** Working days (UTC, excl. Sundays) from today through end of this month. */
function workingDaysThisPeriod(): string[] {
  const t = new Date();
  const cur = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  const end = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0));
  const out: string[] = [];
  for (let d = new Date(cur); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 0) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Expected backfill count = working days minus active holidays in the period. */
async function expectedAttendanceCount(): Promise<number> {
  const wd = workingDaysThisPeriod();
  const hol = await db
    .selectFrom('holidays')
    .select(sql<string>`to_char(date, 'YYYY-MM-DD')`.as('d'))
    .where('period', '=', PERIOD)
    .where('active', '=', true)
    .where('removed_at', 'is', null)
    .execute();
  const holset = new Set(hol.map((h) => h.d));
  return wd.filter((d) => !holset.has(d)).length;
}

async function createPending(over: Record<string, unknown> = {}) {
  return db
    .insertInto('signup_requests')
    .values({
      name: 'Applicant',
      email: email('req'),
      date_of_birth: '1995-06-15',
      mobile_number: '+11234567890',
      role_requested: 'team_member',
      status: 'pending',
      ...over,
    })
    .returning(['id', 'email'])
    .executeTakeFirstOrThrow();
}

async function cleanup() {
  const created = await db
    .selectFrom('staff')
    .select('id')
    .where('email', 'like', `%${DOMAIN}`)
    .execute();
  const ids = created.map((s) => s.id);
  if (ids.length) await db.deleteFrom('attendance_logs').where('staff_id', 'in', ids).execute();
  await db.deleteFrom('signup_requests').where('email', 'like', `%${DOMAIN}`).execute();
  if (ids.length) await db.deleteFrom('staff').where('id', 'in', ids).execute();
  await db.deleteFrom('holidays').where('name', '=', 'ITEST-HOLIDAY').execute();
}

beforeAll(async () => {
  // Reviewer admin + current period must exist (idempotent).
  await db
    .insertInto('staff')
    .values({
      id: REVIEWER_ID,
      name: 'Admin User',
      email: 'admin@test.skaly.in',
      role: 'admin',
      active: true,
    })
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AuthService.approveSignupRequest', () => {
  test('happy path: Supabase user + staff row + attendance backfill + approved', async () => {
    const req = await createPending();
    const expected = await expectedAttendanceCount();

    const result = await service.approveSignupRequest(req.id, 'team_member', REVIEWER_ID);

    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: req.email, email_confirm: true, user_metadata: { name: 'Applicant' } }),
    );
    expect(result.attendanceRowsCreated).toBe(expected);

    const staff = await db
      .selectFrom('staff')
      .selectAll()
      .where('id', '=', result.staffId)
      .executeTakeFirst();
    expect(staff?.email).toBe(req.email);
    expect(staff?.role).toBe('team_member');
    expect(staff?.supabase_uid).toBe(result.supabaseUid);

    const sr = await db
      .selectFrom('signup_requests')
      .select(['status', 'role_assigned', 'reviewed_by'])
      .where('id', '=', req.id)
      .executeTakeFirst();
    expect(sr?.status).toBe('approved');
    expect(sr?.reviewed_by).toBe(REVIEWER_ID);

    const att = await db
      .selectFrom('attendance_logs')
      .select(({ fn }) => fn.countAll<string>().as('c'))
      .where('staff_id', '=', result.staffId)
      .executeTakeFirstOrThrow();
    expect(Number(att.c)).toBe(expected);
  });

  test('M-02: backfill count excludes a holiday in the remaining period', async () => {
    const wd = workingDaysThisPeriod();
    // Pick a working day in range as the holiday (last one is safe).
    const holidayDate = wd[wd.length - 1]!;
    await db
      .insertInto('holidays')
      .values({ period: PERIOD, date: holidayDate, name: 'ITEST-HOLIDAY', added_by: REVIEWER_ID })
      .execute();

    const req = await createPending();
    const expected = await expectedAttendanceCount(); // now reflects the holiday

    const result = await service.approveSignupRequest(req.id, 'team_member', REVIEWER_ID);
    expect(result.attendanceRowsCreated).toBe(expected);

    // The holiday date must NOT be among the inserted attendance rows.
    const onHoliday = await db
      .selectFrom('attendance_logs')
      .select('id')
      .where('staff_id', '=', result.staffId)
      .where(sql<boolean>`to_char(date, 'YYYY-MM-DD') = ${holidayDate}`)
      .executeTakeFirst();
    expect(onHoliday).toBeUndefined();
  });

  test('M-02 atomicity: staff insert failure rolls back the whole transaction', async () => {
    // Pre-create a staff row holding a fixed supabase_uid; force the approve to
    // reuse it so the staff insert hits the UNIQUE(supabase_uid) constraint.
    const dupUid = randomUUID();
    await db
      .insertInto('staff')
      .values({
        name: 'Blocker',
        email: email('blocker'),
        role: 'team_member',
        active: true,
        mfa_enrolled: false,
        supabase_uid: dupUid,
      })
      .execute();
    createUser.mockResolvedValueOnce({ data: { user: { id: dupUid } }, error: null });

    const req = await createPending();
    await expect(service.approveSignupRequest(req.id, 'team_member', REVIEWER_ID)).rejects.toThrow();

    // Rollback: request still pending, no staff row for it, no stray attendance.
    const sr = await db
      .selectFrom('signup_requests')
      .select('status')
      .where('id', '=', req.id)
      .executeTakeFirst();
    expect(sr?.status).toBe('pending');

    const staff = await db
      .selectFrom('staff')
      .select('id')
      .where('email', '=', req.email)
      .executeTakeFirst();
    expect(staff).toBeUndefined();
  });

  test('already-reviewed → 409 ALREADY_REVIEWED', async () => {
    const req = await createPending();
    await service.approveSignupRequest(req.id, 'team_member', REVIEWER_ID);
    await expect(
      service.approveSignupRequest(req.id, 'team_member', REVIEWER_ID),
    ).rejects.toMatchObject({ code: 'ALREADY_REVIEWED', statusCode: 409 });
  });
});

describe('AuthService.rejectSignupRequest', () => {
  test('happy path: note stored, no Supabase user, no staff row', async () => {
    const req = await createPending();
    const result = await service.rejectSignupRequest(
      req.id,
      'INTERNAL: incomplete profile',
      'Thanks for applying.',
      REVIEWER_ID,
    );
    expect(result.status).toBe('rejected');
    expect(createUser).not.toHaveBeenCalled();

    const sr = await db
      .selectFrom('signup_requests')
      .select(['status', 'rejection_note', 'public_rejection_message'])
      .where('id', '=', req.id)
      .executeTakeFirst();
    expect(sr?.status).toBe('rejected');
    expect(sr?.rejection_note).toBe('INTERNAL: incomplete profile');
    expect(sr?.public_rejection_message).toBe('Thanks for applying.');

    const staff = await db
      .selectFrom('staff')
      .select('id')
      .where('email', '=', req.email)
      .executeTakeFirst();
    expect(staff).toBeUndefined();
  });

  test('already-reviewed → 409 ALREADY_REVIEWED', async () => {
    const req = await createPending();
    await service.rejectSignupRequest(req.id, 'note', 'public', REVIEWER_ID);
    await expect(
      service.rejectSignupRequest(req.id, 'note again', 'public again', REVIEWER_ID),
    ).rejects.toMatchObject({ code: 'ALREADY_REVIEWED', statusCode: 409 });
  });
});

describe('rejection privacy contract (linchpin)', () => {
  test('GET /v1/auth/signup-requests/me/status NEVER returns rejection_note', async () => {
    const req = await createPending();
    await service.rejectSignupRequest(
      req.id,
      'INTERNAL: profile incomplete + suspect resume',
      'Thanks for applying. We are not moving forward at this time.',
      REVIEWER_ID,
    );

    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db);
    await app.register(signupStatusRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/auth/signup-requests/me/status?email=${encodeURIComponent(req.email)}`,
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).not.toHaveProperty('rejectionNote');
    expect(body).not.toHaveProperty('rejection_note');
    expect(body.status).toBe('rejected');
    expect(body.publicRejectionMessage).toBe(
      'Thanks for applying. We are not moving forward at this time.',
    );
    expect(JSON.stringify(body)).not.toContain('INTERNAL');
  });
});
