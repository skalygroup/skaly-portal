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
import tasksRoutes from '../../src/routes/tasks/index.js';

import type { AuthUser } from '../../src/lib/auth-verify.js';
import type { DB } from '@skaly/shared';
import type { FastifyError, FastifyInstance } from 'fastify';

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const DOMAIN = '@tasksroute.itest';
const PERIOD = '2001-01';
const DATE = '2001-01-10';

const ADMIN_ID = 'c2000000-0000-4000-8000-00000000c001';
const MANAGER_ID = 'c2000000-0000-4000-8000-00000000c002';
const MEMBER_ID = 'c2000000-0000-4000-8000-00000000c003';
const FREELANCER_ID = 'c2000000-0000-4000-8000-00000000c004';

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

async function seedTask(): Promise<string> {
  const row = await db
    .insertInto('tasks')
    .values({ period: PERIOD, date: DATE, description: 'Seeded', created_by: ADMIN_ID })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function cleanupData() {
  await db.updateTable('tasks').set({ dependency_id: null }).where('period', '=', PERIOD).execute();
  await db.deleteFrom('tasks').where('period', '=', PERIOD).execute();
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
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doUpdateSet({ locked: false }))
    .execute();

  await cleanupData();

  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Same global limiter config as app.ts, so M-06 headers ride every response.
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
  await app.register(tasksRoutes, { prefix: '/v1' });
  await app.ready();
});

afterEach(cleanupData);

afterAll(async () => {
  await app.close();
  await cleanupData();
  await db.destroy();
});

describe('GET /v1/tasks — role gate', () => {
  test('freelancer → 403', async () => {
    asUser = authUser({ id: FREELANCER_ID, role: 'freelancer' });
    const res = await app.inject({ method: 'GET', url: `/v1/tasks?period=${PERIOD}` });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error.code).toBe('PERMISSION_DENIED');
  });

  test('team_member → 200 (reads all tasks)', async () => {
    asUser = authUser({ id: MEMBER_ID, role: 'team_member' });
    const res = await app.inject({ method: 'GET', url: `/v1/tasks?period=${PERIOD}` });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(res.payload).data)).toBe(true);
  });
});

describe('POST /v1/tasks — write gate', () => {
  test('team_member → 403', async () => {
    asUser = authUser({ id: MEMBER_ID, role: 'team_member' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: { period: PERIOD, date: DATE, description: 'nope', assigneeIds: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  test('manager → 201 with the created task', async () => {
    asUser = authUser({ id: MANAGER_ID, role: 'manager' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: { period: PERIOD, date: DATE, description: 'Edit the reel', assigneeIds: [] },
    });
    expect(res.statusCode).toBe(201);
    const data = JSON.parse(res.payload).data;
    expect(data.status).toBe('To Do');
    expect(data.description).toBe('Edit the reel');
  });
});

describe('PATCH /v1/tasks/:id', () => {
  test('empty body → 400 VALIDATION_ERROR', async () => {
    const id = await seedTask();
    asUser = authUser({ id: MANAGER_ID, role: 'manager' });
    const res = await app.inject({ method: 'PATCH', url: `/v1/tasks/${id}`, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('VALIDATION_ERROR');
  });

  test('a stray `version` field is ignored, not rejected (ADR-008 regression guard)', async () => {
    const id = await seedTask();
    asUser = authUser({ id: MANAGER_ID, role: 'manager' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tasks/${id}`,
      payload: { status: 'In Progress', version: 999 },
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload).data;
    expect(data.status).toBe('In Progress'); // the update applied
    expect(data).not.toHaveProperty('version'); // tasks are unversioned
  });
});

describe('M-06 rate-limit headers', () => {
  test('present on GET /v1/tasks and the presign route', async () => {
    asUser = authUser({ id: MANAGER_ID, role: 'manager' });

    const get = await app.inject({ method: 'GET', url: `/v1/tasks?period=${PERIOD}` });
    expect(get.headers).toHaveProperty('x-ratelimit-limit');

    // Presign with an invalid body still returns headers (the limiter runs
    // onRequest, before validation) — proves the route is limiter-covered
    // without needing a real R2 round-trip.
    const presign = await app.inject({ method: 'POST', url: `/v1/tasks/${ADMIN_ID}/attachments/presign`, payload: {} });
    expect(presign.headers).toHaveProperty('x-ratelimit-limit');
  });
});
