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
import contentDropperRoutes from '../../src/routes/content-dropper/index.js';

import type { AuthUser } from '../../src/lib/auth-verify.js';
import type { DB } from '@skaly/shared';
import type { FastifyError, FastifyInstance } from 'fastify';

// Route-layer contract (07-API-CONTRACT §9, 08-AUTH-MATRIX §3–§4): admin/manager
// only for read AND write (team_member + freelancer → 403); stage sequence
// surfaces from the service; version required (C-02); M-06 rate-limit headers.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const DOMAIN = '@dropperroute.itest';
const PERIOD = '1996-08';

const ADMIN_ID = 'e3000000-0000-4000-8000-00000000e001';
const MANAGER_ID = 'e3000000-0000-4000-8000-00000000e002';
const MEMBER_ID = 'e3000000-0000-4000-8000-00000000e003';
const FREELANCER_ID = 'e3000000-0000-4000-8000-00000000e004';
const CLIENT_ID = 'e3000000-0000-4000-8000-00000000e0c1';

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

async function seedPipeline(): Promise<string> {
  const row = await db
    .insertInto('content_pipelines')
    .values({ period: PERIOD, client_id: CLIENT_ID })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function cleanupData() {
  await db.deleteFrom('content_pipelines').where('period', '=', PERIOD).execute();
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

  await db
    .insertInto('clients')
    .values({ id: CLIENT_ID, name: 'Dropper Route Client', shoot_slots_per_month: 4, pieces_per_visit: 3, active: true, is_internal: false })
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
  await app.register(contentDropperRoutes, { prefix: '/v1' });
  await app.ready();
});

afterEach(cleanupData);

afterAll(async () => {
  await app.close();
  await cleanupData();
  await db.destroy();
});

describe('GET /v1/content-dropper — admin/manager only', () => {
  test('team_member → 403; freelancer → 403', async () => {
    for (const [id, role] of [[MEMBER_ID, 'team_member'], [FREELANCER_ID, 'freelancer']] as const) {
      asUser = authUser({ id, role });
      const res = await app.inject({ method: 'GET', url: `/v1/content-dropper?period=${PERIOD}` });
      expect(res.statusCode).toBe(403);
    }
  });

  test('manager → 200 with the grid', async () => {
    await seedPipeline();
    asUser = authUser({ id: MANAGER_ID, role: 'manager' });
    const res = await app.inject({ method: 'GET', url: `/v1/content-dropper?period=${PERIOD}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data).toHaveLength(1);
  });

  test('M-06: rate-limit headers present', async () => {
    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const res = await app.inject({ method: 'GET', url: `/v1/content-dropper?period=${PERIOD}` });
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });
});

describe('PATCH /v1/content-dropper/:id/stage', () => {
  test('team_member → 403; freelancer → 403', async () => {
    const id = await seedPipeline();
    for (const [uid, role] of [[MEMBER_ID, 'team_member'], [FREELANCER_ID, 'freelancer']] as const) {
      asUser = authUser({ id: uid, role });
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/content-dropper/${id}/stage`,
        payload: { stage: 'raw', version: 1 },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  test('manager marks raw → finals → posted in order → 200 each, version chains', async () => {
    const id = await seedPipeline();
    asUser = authUser({ id: MANAGER_ID, role: 'manager' });

    const raw = await app.inject({ method: 'PATCH', url: `/v1/content-dropper/${id}/stage`, payload: { stage: 'raw', version: 1 } });
    expect(raw.statusCode).toBe(200);
    expect(JSON.parse(raw.payload).data.version).toBe(2);

    const finals = await app.inject({ method: 'PATCH', url: `/v1/content-dropper/${id}/stage`, payload: { stage: 'finals', version: 2 } });
    expect(finals.statusCode).toBe(200);
    expect(JSON.parse(finals.payload).data.status).toBe('Review');

    const posted = await app.inject({ method: 'PATCH', url: `/v1/content-dropper/${id}/stage`, payload: { stage: 'posted', version: 3 } });
    expect(posted.statusCode).toBe(200);
    expect(JSON.parse(posted.payload).data.stagesComplete).toBe(3);
  });

  test('out-of-order (finals with no raw) → 400 STAGE_SEQUENCE_VIOLATION', async () => {
    const id = await seedPipeline();
    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const res = await app.inject({ method: 'PATCH', url: `/v1/content-dropper/${id}/stage`, payload: { stage: 'finals', version: 1 } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('STAGE_SEQUENCE_VIOLATION');
  });

  test('missing version → 400 (C-02: version required)', async () => {
    const id = await seedPipeline();
    asUser = authUser({ id: ADMIN_ID, role: 'admin' });
    const res = await app.inject({ method: 'PATCH', url: `/v1/content-dropper/${id}/stage`, payload: { stage: 'raw' } });
    expect(res.statusCode).toBe(400);
  });
});
