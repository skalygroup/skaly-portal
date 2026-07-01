import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { AppError } from '../../src/lib/errors.js';
import clientsRoutes from '../../src/routes/clients/index.js';
import monthsRoutes from '../../src/routes/months/index.js';
import staffRoutes from '../../src/routes/staff/index.js';
import { currentIstPeriod } from '../../src/services/BaseService.js';

import type { AuthUser } from '../../src/lib/auth-verify.js';
import type { DB } from '@skaly/shared';
import type { FastifyError, FastifyInstance } from 'fastify';

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const DOMAIN = '@reads.itest';
const CLIENT_MARKER = 'READS-ITEST';
const PERIOD = currentIstPeriod();

let asUser: AuthUser;
let app: FastifyInstance;

const adminId = randomUUID();
const memberId = randomUUID();
const otherId = randomUUID();

function authUser(over: Partial<AuthUser>): AuthUser {
  return {
    id: memberId,
    supabase_uid: randomUUID(),
    name: 'Caller',
    email: `caller${DOMAIN}`,
    role: 'team_member',
    active: true,
    mfa_enrolled: false,
    avatar_url: null,
    ...over,
  };
}

async function cleanup() {
  await db.deleteFrom('clients').where('name', 'like', `${CLIENT_MARKER}%`).execute();
  await db.deleteFrom('staff').where('email', 'like', `%${DOMAIN}`).execute();
}

beforeAll(async () => {
  await cleanup();

  await db
    .insertInto('staff')
    .values([
      { id: adminId, name: 'Admin', email: `admin${DOMAIN}`, role: 'admin', active: true },
      { id: memberId, name: 'Member', email: `member${DOMAIN}`, role: 'team_member', active: true },
      { id: otherId, name: 'Other', email: `other${DOMAIN}`, role: 'team_member', active: true },
    ])
    .execute();

  await db
    .insertInto('clients')
    .values([
      { name: `${CLIENT_MARKER}-active`, shoot_slots_per_month: 4, active: true },
      { name: `${CLIENT_MARKER}-inactive`, shoot_slots_per_month: 2, active: false },
      { name: `${CLIENT_MARKER}-deleted`, shoot_slots_per_month: 1, active: true, deleted_at: sql`now()` },
    ])
    .execute();

  // Ensure the current IST period exists so /months/current is deterministic.
  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();

  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error: FastifyError, _req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed.' } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'error' } });
  });
  app.decorate('db', db);
  // AuthService (constructed in staffRoutes) captures this but reads never call
  // it; presence uses the lib/redis singleton, not app.redis.
  app.decorate('redis', {});
  app.decorate('verifyJwt', async (req: { user?: AuthUser }) => {
    req.user = asUser;
  });
  app.decorate('requireRole', () => async () => {});
  await app.register(clientsRoutes, { prefix: '/v1' });
  await app.register(monthsRoutes, { prefix: '/v1' });
  await app.register(staffRoutes, { prefix: '/v1' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await cleanup();
  await db.destroy();
});

describe('GET /v1/clients', () => {
  test('200; active clients present, soft-deleted + inactive excluded by default', async () => {
    asUser = authUser({ role: 'team_member' });
    const res = await app.inject({ method: 'GET', url: '/v1/clients' });
    expect(res.statusCode).toBe(200);
    const names = JSON.parse(res.payload).data.map((c: { name: string }) => c.name);
    expect(names).toContain(`${CLIENT_MARKER}-active`);
    expect(names).not.toContain(`${CLIENT_MARKER}-deleted`);
    expect(names).not.toContain(`${CLIENT_MARKER}-inactive`);
  });

  test('?includeInactive=true → 403 for a non-admin', async () => {
    asUser = authUser({ role: 'team_member' });
    const res = await app.inject({ method: 'GET', url: '/v1/clients?includeInactive=true' });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error.code).toBe('PERMISSION_DENIED');
  });

  test('?includeInactive=true → 200 for admin, inactive now visible', async () => {
    asUser = authUser({ id: adminId, role: 'admin' });
    const res = await app.inject({ method: 'GET', url: '/v1/clients?includeInactive=true' });
    expect(res.statusCode).toBe(200);
    const names = JSON.parse(res.payload).data.map((c: { name: string }) => c.name);
    expect(names).toContain(`${CLIENT_MARKER}-inactive`);
    expect(names).not.toContain(`${CLIENT_MARKER}-deleted`);
  });
});

describe('GET /v1/months/current', () => {
  test('returns the IST-current month', async () => {
    asUser = authUser({ role: 'team_member' });
    const res = await app.inject({ method: 'GET', url: '/v1/months/current' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.period).toBe(PERIOD);
  });
});

describe('GET /v1/staff (limited fields)', () => {
  test('returns only limited fields — email and dateOfBirth are absent', async () => {
    asUser = authUser({ role: 'team_member' });
    const res = await app.inject({ method: 'GET', url: '/v1/staff' });
    expect(res.statusCode).toBe(200);
    const item = JSON.parse(res.payload).data.find((s: { id: string }) => s.id === memberId);
    expect(item).toBeDefined();
    expect(Object.keys(item).sort()).toEqual(['avatarUrl', 'id', 'isOnline', 'name', 'role']);
    expect(item).not.toHaveProperty('email');
    expect(item).not.toHaveProperty('dateOfBirth');
  });
});

describe('GET /v1/staff/:id', () => {
  test('403 when a team_member requests another staff member', async () => {
    asUser = authUser({ id: memberId, role: 'team_member' });
    const res = await app.inject({ method: 'GET', url: `/v1/staff/${otherId}` });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error.code).toBe('PERMISSION_DENIED');
  });

  test('200 for own row', async () => {
    asUser = authUser({ id: memberId, role: 'team_member' });
    const res = await app.inject({ method: 'GET', url: `/v1/staff/${memberId}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.id).toBe(memberId);
    expect(JSON.parse(res.payload).data.email).toBe(`member${DOMAIN}`);
  });

  test('200 for admin viewing anyone', async () => {
    asUser = authUser({ id: adminId, role: 'admin' });
    const res = await app.inject({ method: 'GET', url: `/v1/staff/${otherId}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.id).toBe(otherId);
  });
});

describe('GET /v1/staff/me', () => {
  test("returns the caller's own full profile + permissions", async () => {
    asUser = authUser({ id: memberId, role: 'team_member' });
    const res = await app.inject({ method: 'GET', url: '/v1/staff/me' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.id).toBe(memberId);
    expect(body.email).toBe(`member${DOMAIN}`);
    expect(body).toHaveProperty('createdAt');
    expect(body).toHaveProperty('permissions');
  });
});