import rateLimit from '@fastify/rate-limit';
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
import { requireRole } from '../../src/middleware/auth.plugin.js';
import contentCalendarRoutes from '../../src/routes/content-calendar/index.js';

import type { AuthUser } from '../../src/lib/auth-verify.js';
import type { DB } from '@skaly/shared';
import type { FastifyError, FastifyInstance } from 'fastify';

// Route-layer contract (07-API-CONTRACT §Content Calendar, 08-AUTH-MATRIX §3–§4).
// The verbs have DIFFERENT role sets and that asymmetry IS the read-only
// team_member rule, so it gets a test per verb per role:
//   GET   — admin/manager/team_member 200, freelancer 403
//   PATCH — admin/manager 200, team_member 403, freelancer 403
// Plus: version required (C-02), `source` rejected by .strict(), 409/423
// surfacing, and M-06 rate-limit headers.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const DOMAIN = '@calroute.itest';
const PERIOD = '1995-06';
const LOCKED_PERIOD = '1995-05';
const DATE = '1995-06-12';
const LOCKED_DATE = '1995-05-12';

const ADMIN_ID = 'e6000000-0000-4000-8000-00000000e001';
const MANAGER_ID = 'e6000000-0000-4000-8000-00000000e002';
const MEMBER_ID = 'e6000000-0000-4000-8000-00000000e003';
const FREELANCER_ID = 'e6000000-0000-4000-8000-00000000e004';
const CLIENT_ID = 'e6000000-0000-4000-8000-00000000e0c1';

let asUser: AuthUser;
let app: FastifyInstance;

function authUser(over: Partial<AuthUser>): AuthUser {
  return {
    id: ADMIN_ID,
    supabase_uid: 'uid',
    name: 'Caller',
    email: `caller${DOMAIN}`,
    role: 'admin',
    active: true,
    mfa_enrolled: false,
    avatar_url: null,
    ...over,
  };
}

async function seedCell(
  over: Partial<{ period: string; date: string; status: string; source: string }> = {},
): Promise<string> {
  const row = await db
    .insertInto('content_calendar')
    .values({
      period: PERIOD,
      client_id: CLIENT_ID,
      date: DATE,
      status: 'No Activity',
      version: 1,
      ...over,
    } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function cleanupData() {
  await db.deleteFrom('content_calendar').where('period', 'in', [PERIOD, LOCKED_PERIOD]).execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN_ID, name: 'Admin', email: `admin${DOMAIN}`, role: 'admin', active: true },
      { id: MANAGER_ID, name: 'Manager', email: `manager${DOMAIN}`, role: 'manager', active: true },
      { id: MEMBER_ID, name: 'Member', email: `member${DOMAIN}`, role: 'team_member', active: true },
      { id: FREELANCER_ID, name: 'Freelancer', email: `free${DOMAIN}`, role: 'freelancer', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await db
    .insertInto('months')
    .values([
      { period: PERIOD, label: PERIOD, locked: false },
      { period: LOCKED_PERIOD, label: LOCKED_PERIOD, locked: true },
    ])
    .onConflict((oc) => oc.column('period').doUpdateSet((eb) => ({ locked: eb.ref('excluded.locked') })))
    .execute();

  await db
    .insertInto('clients')
    .values({ id: CLIENT_ID, name: 'Calendar Route Client', shoot_slots_per_month: 4, pieces_per_visit: 3, active: true, is_internal: false })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await cleanupData();

  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(rateLimit, {
    max: 150,
    timeWindow: '1 minute',
    addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true },
  });
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
  await app.register(contentCalendarRoutes, { prefix: '/v1' });
  await app.ready();
});

afterEach(cleanupData);

afterAll(async () => {
  await app.close();
  await cleanupData();
  await db.destroy();
});

const get = () => app.inject({ method: 'GET', url: `/v1/content-calendar?period=${PERIOD}` });
const patch = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/v1/content-calendar/${id}`, payload });

describe('GET /v1/content-calendar — team_member reads, freelancer does not', () => {
  test('admin, manager and team_member all → 200 with the grid', async () => {
    await seedCell();
    for (const [id, role] of [
      [ADMIN_ID, 'admin'],
      [MANAGER_ID, 'manager'],
      [MEMBER_ID, 'team_member'],
    ] as const) {
      asUser = authUser({ id, role });
      const res = await get();
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload).data;
      expect(body.cells.some((c: { clientId: string }) => c.clientId === CLIENT_ID)).toBe(true);
      expect(body.clients.some((c: { id: string }) => c.id === CLIENT_ID)).toBe(true);
    }
  });

  test('freelancer → 403', async () => {
    asUser = authUser({ id: FREELANCER_ID, role: 'freelancer' });
    expect((await get()).statusCode).toBe(403);
  });

  test('a malformed period → 400 before the service is reached', async () => {
    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const res = await app.inject({ method: 'GET', url: '/v1/content-calendar?period=1995-6' });
    expect(res.statusCode).toBe(400);
  });

  test('M-06: rate-limit headers present', async () => {
    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const res = await get();
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });
});

describe('PATCH /v1/content-calendar/:id — admin/manager only', () => {
  test('manager → 200, and the auto-reset is visible in the response', async () => {
    const id = await seedCell({ source: 'pipeline_trigger', status: 'Posted' });
    asUser = authUser({ id: MANAGER_ID, role: 'manager' });

    const res = await patch(id, { status: 'Ready', version: 1 });

    expect(res.statusCode).toBe(200);
    const cell = JSON.parse(res.payload).data;
    expect(cell).toMatchObject({ status: 'Ready', source: 'manual', version: 2 });
    expect(cell.updatedBy).toEqual({ staffId: MANAGER_ID, name: 'Manager' });
  });

  test('team_member → 403 (this is the read-only rule; the grid’s pointer-events is only UX)', async () => {
    const id = await seedCell();
    asUser = authUser({ id: MEMBER_ID, role: 'team_member' });
    expect((await patch(id, { status: 'Ready', version: 1 })).statusCode).toBe(403);
  });

  test('freelancer → 403', async () => {
    const id = await seedCell();
    asUser = authUser({ id: FREELANCER_ID, role: 'freelancer' });
    expect((await patch(id, { status: 'Ready', version: 1 })).statusCode).toBe(403);
  });

  test('without version → 400 (C-02)', async () => {
    const id = await seedCell();
    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const res = await patch(id, { status: 'Ready' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('VALIDATION_ERROR');
  });

  test('a `source` field in the body → 400 (.strict(); the client cannot forge provenance)', async () => {
    const id = await seedCell();
    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const res = await patch(id, { status: 'Ready', source: 'pipeline_trigger', version: 1 });
    expect(res.statusCode).toBe(400);
  });

  test('an off-vocabulary status → 400 (the 6-value CHECK, not the task vocabulary)', async () => {
    const id = await seedCell();
    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    expect((await patch(id, { status: 'Done', version: 1 })).statusCode).toBe(400);
  });

  test('all six statuses are accepted', async () => {
    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const statuses = ['No Activity', 'Under Progress', 'Ready', 'Posted', 'Pending', 'Rescheduled'];
    let version = 1;
    const id = await seedCell();
    for (const status of statuses) {
      const res = await patch(id, { status, version });
      expect(res.statusCode).toBe(200);
      version = JSON.parse(res.payload).data.version;
    }
    expect(version).toBe(1 + statuses.length);
  });

  test('a note over 1000 chars → 400; exactly 1000 → 200', async () => {
    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const id = await seedCell();
    expect((await patch(id, { note: 'x'.repeat(1001), version: 1 })).statusCode).toBe(400);
    expect((await patch(id, { note: 'x'.repeat(1000), version: 1 })).statusCode).toBe(200);
  });

  test('a stale version → 409 STALE_DATA with currentVersion + updatedBy (Testing-Strategy §5.2)', async () => {
    const id = await seedCell();
    asUser = authUser({ id: MANAGER_ID, role: 'manager' });
    await patch(id, { status: 'Ready', version: 1 }); // → version 2

    const res = await patch(id, { status: 'Pending', version: 1 });

    expect(res.statusCode).toBe(409);
    const err = JSON.parse(res.payload).error;
    expect(err.code).toBe('STALE_DATA');
    expect(err.details.currentVersion).toBe(2);
    expect(err.details.updatedBy).toEqual({ staffId: MANAGER_ID, name: 'Manager' });
  });

  test('a locked period → 423 PERIOD_LOCKED', async () => {
    const id = await seedCell({ period: LOCKED_PERIOD, date: LOCKED_DATE });
    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const res = await patch(id, { status: 'Ready', version: 1 });
    expect(res.statusCode).toBe(423);
    expect(JSON.parse(res.payload).error.code).toBe('PERIOD_LOCKED');
  });

  test('an unknown cell → 404', async () => {
    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const res = await patch('e6000000-0000-4000-8000-0000000000ff', { status: 'Ready', version: 1 });
    expect(res.statusCode).toBe(404);
  });
});
