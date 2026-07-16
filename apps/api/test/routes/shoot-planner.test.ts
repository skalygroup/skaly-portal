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
import shootPlannerRoutes from '../../src/routes/shoot-planner/index.js';

import type { AuthUser } from '../../src/lib/auth-verify.js';
import type { DB } from '@skaly/shared';
import type { FastifyError, FastifyInstance } from 'fastify';

// Route-layer contract (07-API-CONTRACT §8, 08-AUTH-MATRIX §4): GET open to all
// four roles (the SERVICE isolates), PATCH/reset admin+manager only, slot-count
// admin only, reset confirm gate, M-06 rate-limit headers.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const DOMAIN = '@shootroute.itest';
const PERIOD = '1999-08';

const ADMIN_ID = 'e2000000-0000-4000-8000-00000000e001';
const MEMBER_ID = 'e2000000-0000-4000-8000-00000000e002';
const FREELANCER_ID = 'e2000000-0000-4000-8000-00000000e003';
const FREELANCER2_ID = 'e2000000-0000-4000-8000-00000000e004';
const CLIENT_ID = 'e2000000-0000-4000-8000-00000000e0c1';

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

async function seedSlot(
  slotIndex: number,
  over: { slot_status?: string; slot_date?: string; freelancer_id?: string } = {},
): Promise<string> {
  const row = await db
    .insertInto('shoot_schedules')
    .values({
      period: PERIOD,
      client_id: CLIENT_ID,
      slot_index: slotIndex,
      slot_status: 'Unset',
      pieces_expected: 3,
      ...over,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function cleanupData() {
  await db.deleteFrom('shoot_schedules').where('period', '=', PERIOD).execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN_ID, name: 'Admin', email: `admin${DOMAIN}`, role: 'admin', active: true },
      { id: MEMBER_ID, name: 'Member', email: `member${DOMAIN}`, role: 'team_member', active: true },
      { id: FREELANCER_ID, name: 'Freelancer', email: `free${DOMAIN}`, role: 'freelancer', active: true },
      { id: FREELANCER2_ID, name: 'Freelancer2', email: `free2${DOMAIN}`, role: 'freelancer', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doUpdateSet({ locked: false }))
    .execute();

  await db
    .insertInto('clients')
    .values({ id: CLIENT_ID, name: 'Route Test Client', shoot_slots_per_month: 4, pieces_per_visit: 3, active: true })
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
  await app.register(shootPlannerRoutes, { prefix: '/v1' });
  await app.ready();
});

afterEach(cleanupData);

afterAll(async () => {
  await app.close();
  await cleanupData();
  await db.destroy();
});

describe('GET /v1/shoot-planner — open to all four roles', () => {
  test('team_member → 200 with the full grid', async () => {
    await seedSlot(1);
    asUser = authUser({ id: MEMBER_ID, role: 'team_member' });
    const res = await app.inject({ method: 'GET', url: `/v1/shoot-planner?period=${PERIOD}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.slots).toHaveLength(1);
  });

  test('freelancer → 200 with ONLY their own rows (the service isolates)', async () => {
    await seedSlot(1, { freelancer_id: FREELANCER_ID, slot_status: 'Scheduled', slot_date: '1999-08-10' });
    await seedSlot(2, { freelancer_id: FREELANCER2_ID, slot_status: 'Scheduled', slot_date: '1999-08-11' });
    await seedSlot(3); // unassigned

    asUser = authUser({ id: FREELANCER_ID, role: 'freelancer' });
    const res = await app.inject({ method: 'GET', url: `/v1/shoot-planner?period=${PERIOD}` });
    expect(res.statusCode).toBe(200);
    const slots = JSON.parse(res.payload).data.slots as { freelancerId: string }[];
    expect(slots).toHaveLength(1);
    expect(slots[0]!.freelancerId).toBe(FREELANCER_ID);
  });

  test('freelancer GET of a non-owned slot by id → 404', async () => {
    const otherSlot = await seedSlot(1, { freelancer_id: FREELANCER2_ID });
    asUser = authUser({ id: FREELANCER_ID, role: 'freelancer' });
    const res = await app.inject({ method: 'GET', url: `/v1/shoot-planner/${otherSlot}` });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error.code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('PATCH /v1/shoot-planner/:id — admin/manager only', () => {
  test('team_member → 403; freelancer → 403', async () => {
    const slotId = await seedSlot(1);
    for (const [id, role] of [[MEMBER_ID, 'team_member'], [FREELANCER_ID, 'freelancer']] as const) {
      asUser = authUser({ id, role });
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/shoot-planner/${slotId}`,
        payload: { slotStatus: 'Scheduled', slotDate: '1999-08-15' },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  test('admin → 200; a stray `version` in the body is ignored (no-version contract)', async () => {
    const slotId = await seedSlot(1);
    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/shoot-planner/${slotId}`,
      payload: { slotStatus: 'Scheduled', slotDate: '1999-08-15', version: 99 },
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload).data;
    expect(data.slotStatus).toBe('Scheduled');
    expect(data).not.toHaveProperty('version'); // slots are unversioned
  });

  test('empty body → 400 VALIDATION_ERROR', async () => {
    const slotId = await seedSlot(1);
    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const res = await app.inject({ method: 'PATCH', url: `/v1/shoot-planner/${slotId}`, payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/shoot-planner/:id/reset — confirm gate', () => {
  test('missing confirm → 400 SHOOT_RESET_CONFIRMATION_REQUIRED; freelancer → 403', async () => {
    const slotId = await seedSlot(1, { slot_status: 'Scheduled', slot_date: '1999-08-10' });

    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const noConfirm = await app.inject({ method: 'POST', url: `/v1/shoot-planner/${slotId}/reset`, payload: {} });
    expect(noConfirm.statusCode).toBe(400);
    expect(JSON.parse(noConfirm.payload).error.code).toBe('SHOOT_RESET_CONFIRMATION_REQUIRED');

    asUser = authUser({ id: FREELANCER_ID, role: 'freelancer' });
    const asFreelancer = await app.inject({
      method: 'POST',
      url: `/v1/shoot-planner/${slotId}/reset`,
      payload: { confirm: true },
    });
    expect(asFreelancer.statusCode).toBe(403);

    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const ok = await app.inject({ method: 'POST', url: `/v1/shoot-planner/${slotId}/reset`, payload: { confirm: true } });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload).data).toEqual({ reset: true });
  });
});

describe('PATCH /v1/clients/:id/shoot-slots — admin only', () => {
  test('manager → 403; admin out-of-range → 400; admin valid → 200', async () => {
    asUser = authUser({ id: MEMBER_ID, role: 'manager' });
    const asManager = await app.inject({
      method: 'PATCH',
      url: `/v1/clients/${CLIENT_ID}/shoot-slots`,
      payload: { slotsPerMonth: 5 },
    });
    expect(asManager.statusCode).toBe(403);

    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const tooMany = await app.inject({
      method: 'PATCH',
      url: `/v1/clients/${CLIENT_ID}/shoot-slots`,
      payload: { slotsPerMonth: 21 },
    });
    expect(tooMany.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'PATCH',
      url: `/v1/clients/${CLIENT_ID}/shoot-slots`,
      payload: { slotsPerMonth: 4 },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload).data.shootSlotsPerMonth).toBe(4);
    // adjustSlotCount reconciles the CURRENT period — remove the slots it
    // generated there so this suite leaves no residue.
    const currentPeriod = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit',
    }).format(new Date());
    await db
      .deleteFrom('shoot_schedules')
      .where('client_id', '=', CLIENT_ID)
      .where('period', '>=', currentPeriod)
      .execute();
  });
});

describe('M-06 rate-limit headers', () => {
  test('present on GET /v1/shoot-planner', async () => {
    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const res = await app.inject({ method: 'GET', url: `/v1/shoot-planner?period=${PERIOD}` });
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });
});
