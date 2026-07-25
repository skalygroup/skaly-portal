import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { AppError } from '../../src/lib/errors.js';
import searchRoutes from '../../src/routes/search/index.js';
import { AuditService } from '../../src/services/AuditService.js';

import type { AuthUser } from '../../src/lib/auth-verify.js';
import type { DB } from '@skaly/shared';
import type { Role } from '@skaly/shared/schemas/auth';
import type { FastifyError, FastifyInstance } from 'fastify';

/**
 * /v1/search + /v1/activity-feed routes (Sprint 9 STEP 9).
 *
 * The routes deliberately gate NOTHING beyond authentication — scoping is the
 * service's job, per category and per row. These tests assert that division holds:
 * every role gets 200, and the SHAPE of what comes back differs by role.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const audit = new AuditService();

const ADMIN = 'e8000000-0000-4000-8000-000000000001';
const MANAGER = 'e8000000-0000-4000-8000-000000000002';
const MEMBER = 'e8000000-0000-4000-8000-000000000003';
const FREELANCER = 'e8000000-0000-4000-8000-000000000004';
const CLIENT = 'e8000000-0000-4000-8000-0000000000c1';
const PERIOD = '2092-09';
const TERM = 'quixotry';

const ACTORS = [ADMIN, MANAGER, MEMBER, FREELANCER];

let asUser: AuthUser;
let app: FastifyInstance;

function authUser(id: string, role: Role): AuthUser {
  return {
    id,
    supabase_uid: `uid-${id}`,
    name: 'Search Caller',
    email: `${id}@search.itest`,
    role,
    active: true,
    mfa_enrolled: false,
    avatar_url: null,
  };
}

const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer t' } });

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN, name: `Quixotry Admin`, email: `a${ADMIN}@s.itest`, role: 'admin', active: true },
      { id: MANAGER, name: `Quixotry Manager`, email: `g${MANAGER}@s.itest`, role: 'manager', active: true },
      { id: MEMBER, name: `Quixotry Member`, email: `m${MEMBER}@s.itest`, role: 'team_member', active: true },
      { id: FREELANCER, name: `Quixotry Free`, email: `f${FREELANCER}@s.itest`, role: 'freelancer', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('clients')
    .values({ id: CLIENT, name: 'Quixotry Ltd', shoot_slots_per_month: 1, active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();
  await cleanup();

  await db
    .insertInto('tasks')
    .values({ period: PERIOD, date: `${PERIOD}-05`, description: `A ${TERM} task`, created_by: ADMIN, client_id: CLIENT })
    .execute();

  // Feed rows: one per actor so the role filter has something to filter.
  for (const actor of [ADMIN, MEMBER]) {
    await audit.log({
      actorId: actor,
      entity: 'tasks',
      action: 'INSERT',
      entityId: 'e8000000-0000-4000-8000-00000000aaaa',
      after: { description: `${TERM} event`, period: PERIOD },
      trx: db,
    });
  }

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
  await app.register(searchRoutes, { prefix: '/v1' });
  await app.ready();
});

async function cleanup(): Promise<void> {
  await db.deleteFrom('audit_log').where('staff_id', 'in', ACTORS).execute();
  await db.deleteFrom('tasks').where('period', '=', PERIOD).execute();
}

afterAll(async () => {
  await app.close();
  await cleanup();
  await db.deleteFrom('clients').where('id', '=', CLIENT).execute();
  await db.deleteFrom('staff').where('id', 'in', ACTORS).execute();
  await db.destroy();
});

describe('GET /v1/search', () => {
  test('all four roles get 200 — the route gates nothing beyond auth', async () => {
    for (const [id, role] of [
      [ADMIN, 'admin'],
      [MANAGER, 'manager'],
      [MEMBER, 'team_member'],
      [FREELANCER, 'freelancer'],
    ] as const) {
      asUser = authUser(id, role);
      const res = await get(`/v1/search?q=${TERM}`);
      expect(res.statusCode, role).toBe(200);
    }
  });

  test('the envelope is { data: { tasks, clients, staff, comments } } (§1.1)', async () => {
    asUser = authUser(ADMIN, 'admin');
    // all_time explicitly: the fixture task is in 2092 and the DEFAULT scope is
    // `current`, which correctly finds nothing (asserted below).
    const body = JSON.parse((await get(`/v1/search?q=${TERM}&scope=all_time`)).payload);
    expect(Object.keys(body)).toEqual(['data']);
    expect(Object.keys(body.data).sort()).toEqual(['clients', 'comments', 'staff', 'tasks']);
    expect(body.data.tasks.length).toBeGreaterThan(0);
  });

  test('a freelancer gets 200 with an EMPTY tasks array — scoping is the service\'s', async () => {
    asUser = authUser(FREELANCER, 'freelancer');
    // all_time so the empty array proves the ROLE skip, not the period filter.
    const body = JSON.parse((await get(`/v1/search?q=${TERM}&scope=all_time`)).payload);
    expect(body.data.tasks).toEqual([]);
    // …but still sees staff and clients, which every role may read.
    expect(body.data.staff.length).toBeGreaterThan(0);
    expect(body.data.clients.length).toBeGreaterThan(0);
  });

  test('staff hits carry only the limited fields (NFR §4.2)', async () => {
    asUser = authUser(FREELANCER, 'freelancer');
    const body = JSON.parse((await get('/v1/search?q=Quixotry')).payload);
    for (const s of body.data.staff) {
      expect(Object.keys(s).sort()).toEqual(['avatarUrl', 'id', 'name', 'role']);
    }
  });

  test('q absent → 400 VALIDATION_ERROR', async () => {
    asUser = authUser(ADMIN, 'admin');
    const res = await get('/v1/search');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('VALIDATION_ERROR');
  });

  test('q empty or over 100 chars → 400', async () => {
    asUser = authUser(ADMIN, 'admin');
    expect((await get('/v1/search?q=')).statusCode).toBe(400);
    expect((await get(`/v1/search?q=${'x'.repeat(101)}`)).statusCode).toBe(400);
  });

  test('an unknown scope → 400; a valid one → 200', async () => {
    asUser = authUser(ADMIN, 'admin');
    expect((await get(`/v1/search?q=${TERM}&scope=last_year`)).statusCode).toBe(400);
    expect((await get(`/v1/search?q=${TERM}&scope=current`)).statusCode).toBe(200);
    expect((await get(`/v1/search?q=${TERM}&scope=all_time`)).statusCode).toBe(200);
  });

  test('scope defaults to current when omitted', async () => {
    asUser = authUser(ADMIN, 'admin');
    // The fixture task is in 2092, so a defaulted (current) scope finds no tasks
    // while all_time does — which is the default being applied, not ignored.
    const defaulted = JSON.parse((await get(`/v1/search?q=${TERM}`)).payload);
    const allTime = JSON.parse((await get(`/v1/search?q=${TERM}&scope=all_time`)).payload);
    expect(defaulted.data.tasks).toEqual([]);
    expect(allTime.data.tasks.length).toBeGreaterThan(0);
  });
});

describe('GET /v1/activity-feed', () => {
  test('all four roles get 200', async () => {
    for (const [id, role] of [
      [ADMIN, 'admin'],
      [MANAGER, 'manager'],
      [MEMBER, 'team_member'],
      [FREELANCER, 'freelancer'],
    ] as const) {
      asUser = authUser(id, role);
      expect((await get(`/v1/activity-feed?period=${PERIOD}`)).statusCode, role).toBe(200);
    }
  });

  test('the envelope is { data: [ { id, actor, text, link, at } ] } (§1.1)', async () => {
    asUser = authUser(ADMIN, 'admin');
    const body = JSON.parse((await get(`/v1/activity-feed?period=${PERIOD}`)).payload);
    expect(Object.keys(body)).toEqual(['data']);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(Object.keys(body.data[0]).sort()).toEqual(['actor', 'at', 'id', 'link', 'text']);
  });

  test('a team_member sees only their own events', async () => {
    asUser = authUser(MEMBER, 'team_member');
    const body = JSON.parse((await get(`/v1/activity-feed?period=${PERIOD}`)).payload);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].actor).toBe('Quixotry Member');

    asUser = authUser(ADMIN, 'admin');
    const asAdmin = JSON.parse((await get(`/v1/activity-feed?period=${PERIOD}`)).payload);
    expect(asAdmin.data.length).toBe(2);
  });

  test('limit=999 → 400, and limit=0 → 400', async () => {
    asUser = authUser(ADMIN, 'admin');
    expect((await get(`/v1/activity-feed?limit=999&period=${PERIOD}`)).statusCode).toBe(400);
    expect((await get(`/v1/activity-feed?limit=0&period=${PERIOD}`)).statusCode).toBe(400);
    expect((await get(`/v1/activity-feed?limit=50&period=${PERIOD}`)).statusCode).toBe(200);
  });

  test('limit is coerced from its query-string form', async () => {
    asUser = authUser(ADMIN, 'admin');
    const res = await get(`/v1/activity-feed?limit=1&period=${PERIOD}`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data).toHaveLength(1);
  });

  test('a malformed period → 400', async () => {
    asUser = authUser(ADMIN, 'admin');
    expect((await get('/v1/activity-feed?period=2092')).statusCode).toBe(400);
    expect((await get('/v1/activity-feed?period=not-a-period')).statusCode).toBe(400);
  });

  test('period is optional', async () => {
    asUser = authUser(ADMIN, 'admin');
    expect((await get('/v1/activity-feed')).statusCode).toBe(200);
  });
});
