import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, afterEach, describe, expect, test } from 'vitest';

import { AppError } from '../../src/lib/errors.js';
import { classifyDay, datesInPeriod } from '../../src/lib/period-days.js';
import { requireRole } from '../../src/middleware/auth.plugin.js';
import attendanceRoutes from '../../src/routes/attendance/index.js';
import holidaysRoutes from '../../src/routes/holidays/index.js';

import type { AuthUser } from '../../src/lib/auth-verify.js';
import type { DB } from '@skaly/shared';
import type { FastifyError, FastifyInstance } from 'fastify';

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const DOMAIN = '@attroute.itest';
const PERIOD = '2000-07';
const PERIOD_LOCKED = '2000-08';

// Persistent fixture staff (PATCH/holiday writes append-only audit_log rows that
// FK staff — never deleted).
const ADMIN_ID = 'c1000000-0000-4000-8000-00000000c001';
const MANAGER_ID = 'c1000000-0000-4000-8000-00000000c002';
const MEMBER_ID = 'c1000000-0000-4000-8000-00000000c003';
const OTHER_ID = 'c1000000-0000-4000-8000-00000000c004';
const FREELANCER_ID = 'c1000000-0000-4000-8000-00000000c005';

const workingDate = datesInPeriod(PERIOD).find((d) => classifyDay(d, new Set()) === 'working')!;
const workingDate2 = datesInPeriod(PERIOD).filter((d) => classifyDay(d, new Set()) === 'working')[1]!;
const workingDateLocked = datesInPeriod(PERIOD_LOCKED).find((d) => classifyDay(d, new Set()) === 'working')!;

let asUser: AuthUser;
let app: FastifyInstance;

function authUser(over: Partial<AuthUser>): AuthUser {
  return {
    id: MEMBER_ID,
    supabase_uid: 'uid',
    name: 'Caller',
    email: `caller${DOMAIN}`,
    role: 'team_member',
    active: true,
    mfa_enrolled: false,
    avatar_url: null,
    ...over,
  };
}

async function insertAtt(staffId: string, period: string, date: string, version: number, dayType = 'working') {
  const row = await db
    .insertInto('attendance_logs')
    .values({ period, staff_id: staffId, date, day_type: dayType, present: false, version })
    .onConflict((oc) => oc.columns(['period', 'staff_id', 'date']).doNothing())
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertHoliday(period: string, date: string) {
  const row = await db
    .insertInto('holidays')
    .values({ period, date, name: 'ROUTE-HOL', active: true, added_by: ADMIN_ID })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function attByDate(staffId: string, period: string, date: string) {
  return db
    .selectFrom('attendance_logs')
    .select(['day_type', 'version'])
    .where('staff_id', '=', staffId)
    .where('period', '=', period)
    .where('date', '=', date as unknown as Date)
    .executeTakeFirst();
}

async function cleanupData() {
  await db.deleteFrom('attendance_logs').where('period', 'in', [PERIOD, PERIOD_LOCKED]).execute();
  await db.deleteFrom('holidays').where('period', 'in', [PERIOD, PERIOD_LOCKED]).execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN_ID, name: 'Admin', email: `admin${DOMAIN}`, role: 'admin', active: true },
      { id: MANAGER_ID, name: 'Manager', email: `manager${DOMAIN}`, role: 'manager', active: true },
      { id: MEMBER_ID, name: 'Member', email: `member${DOMAIN}`, role: 'team_member', active: true },
      { id: OTHER_ID, name: 'Other', email: `other${DOMAIN}`, role: 'team_member', active: true },
      { id: FREELANCER_ID, name: 'Freelancer', email: `free${DOMAIN}`, role: 'freelancer', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await db
    .insertInto('months')
    .values([
      { period: PERIOD, label: PERIOD, locked: false },
      { period: PERIOD_LOCKED, label: PERIOD_LOCKED, locked: true },
    ])
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();

  await cleanupData();

  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error: FastifyError, _req, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed.' } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'error' } });
  });
  app.decorate('db', db);
  app.decorate('verifyJwt', async (req: { user?: AuthUser }) => {
    req.user = asUser;
  });
  app.decorate('requireRole', requireRole); // the REAL role gate
  await app.register(attendanceRoutes, { prefix: '/v1' });
  await app.register(holidaysRoutes, { prefix: '/v1' });
  await app.ready();
});

afterEach(cleanupData);

afterAll(async () => {
  await app.close();
  await cleanupData();
  await db.destroy();
});

describe('GET /v1/attendance', () => {
  test('freelancer → 403', async () => {
    asUser = authUser({ id: FREELANCER_ID, role: 'freelancer' });
    const res = await app.inject({ method: 'GET', url: `/v1/attendance?period=${PERIOD}` });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error.code).toBe('PERMISSION_DENIED');
  });

  test('admin / manager / team_member → 200', async () => {
    for (const [id, role] of [
      [ADMIN_ID, 'admin'],
      [MANAGER_ID, 'manager'],
      [MEMBER_ID, 'team_member'],
    ] as const) {
      asUser = authUser({ id, role });
      const res = await app.inject({ method: 'GET', url: `/v1/attendance?period=${PERIOD}` });
      expect(res.statusCode).toBe(200);
    }
  });

  test('team_member → editableStaffIds is only their own id', async () => {
    asUser = authUser({ id: MEMBER_ID, role: 'team_member' });
    const res = await app.inject({ method: 'GET', url: `/v1/attendance?period=${PERIOD}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.editableStaffIds).toEqual([MEMBER_ID]);
  });
});

describe('PATCH /v1/attendance/:id', () => {
  test('team_member editing another staff member’s row → 403', async () => {
    const id = await insertAtt(OTHER_ID, PERIOD, workingDate, 1);
    asUser = authUser({ id: MEMBER_ID, role: 'team_member' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/attendance/${id}`,
      payload: { present: true, version: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error.code).toBe('PERMISSION_DENIED');
  });

  test('own row → 200 and version increments', async () => {
    const id = await insertAtt(MEMBER_ID, PERIOD, workingDate, 1);
    asUser = authUser({ id: MEMBER_ID, role: 'team_member' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/attendance/${id}`,
      payload: { present: true, workLog: 'did the edit', version: 1 },
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload).data;
    expect(data.version).toBe(2);
    expect(data.present).toBe(true);
    expect(data.workLog).toBe('did the edit');
  });

  test('stale version → 409 STALE_DATA with details.currentVersion', async () => {
    const id = await insertAtt(MEMBER_ID, PERIOD, workingDate, 5);
    asUser = authUser({ id: MEMBER_ID, role: 'team_member' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/attendance/${id}`,
      payload: { present: true, version: 1 },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('STALE_DATA');
    expect(body.error.details.currentVersion).toBe(5);
  });

  test('locked period → 423 PERIOD_LOCKED', async () => {
    const id = await insertAtt(MEMBER_ID, PERIOD_LOCKED, workingDateLocked, 1);
    asUser = authUser({ id: MEMBER_ID, role: 'team_member' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/attendance/${id}`,
      payload: { present: true, version: 1 },
    });
    expect(res.statusCode).toBe(423);
    expect(JSON.parse(res.payload).error.code).toBe('PERIOD_LOCKED');
  });
});

describe('POST /v1/holidays', () => {
  test('team_member → 403', async () => {
    asUser = authUser({ id: MEMBER_ID, role: 'team_member' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/holidays',
      payload: { period: PERIOD, date: workingDate, name: 'Diwali' },
    });
    expect(res.statusCode).toBe(403);
  });

  test('manager → 201 and the date’s working rows become holiday', async () => {
    await insertAtt(MEMBER_ID, PERIOD, workingDate2, 1);
    await insertAtt(OTHER_ID, PERIOD, workingDate2, 1);
    asUser = authUser({ id: MANAGER_ID, role: 'manager' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/holidays',
      payload: { period: PERIOD, date: workingDate2, name: 'Diwali' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).data.name).toBe('Diwali');

    expect((await attByDate(MEMBER_ID, PERIOD, workingDate2))?.day_type).toBe('holiday');
    expect((await attByDate(OTHER_ID, PERIOD, workingDate2))?.day_type).toBe('holiday');
  });
});

describe('DELETE /v1/holidays/:id (H-01 through HTTP)', () => {
  test('manager → holiday deactivated and attendance reverted to working', async () => {
    const holidayId = await insertHoliday(PERIOD, workingDate);
    await insertAtt(MEMBER_ID, PERIOD, workingDate, 1, 'holiday');
    asUser = authUser({ id: MANAGER_ID, role: 'manager' });

    const res = await app.inject({ method: 'DELETE', url: `/v1/holidays/${holidayId}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.removed).toBe(true);

    const h = await db
      .selectFrom('holidays')
      .select('active')
      .where('id', '=', holidayId)
      .executeTakeFirst();
    expect(h?.active).toBe(false);
    expect((await attByDate(MEMBER_ID, PERIOD, workingDate))?.day_type).toBe('working');
  });
});
