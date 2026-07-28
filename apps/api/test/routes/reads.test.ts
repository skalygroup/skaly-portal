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
import type { Redis } from 'ioredis';

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
  // Drop what REFERENCES staff before staff itself. The permission-override test
  // writes user_permissions + an audit_log row, and audit_log.staff_id is a
  // non-null FK — leaving those behind makes the NEXT run's cleanup fail on the
  // constraint, not on anything to do with the test that wrote them. Matched by
  // sub-select because the ids are regenerated each run.
  const staffOfThisSuite = db.selectFrom('staff').select('id').where('email', 'like', `%${DOMAIN}`);
  await db.deleteFrom('audit_log').where('staff_id', 'in', staffOfThisSuite).execute();
  await db.deleteFrom('user_permissions').where('staff_id', 'in', staffOfThisSuite).execute();
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
  app.decorate('redis', {} as unknown as Redis);
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

  test('?includeInactive=true → 200 for admin; inactive AND soft-deleted visible', async () => {
    // ADR-026: the admin Clients panel is where a deactivated client is reinstated,
    // so it must be able to see one. Deactivation stamps deleted_at and active=false
    // together, so excluding tombstones here made the flag a no-op.
    asUser = authUser({ id: adminId, role: 'admin' });
    const res = await app.inject({ method: 'GET', url: '/v1/clients?includeInactive=true' });
    expect(res.statusCode).toBe(200);
    const names = JSON.parse(res.payload).data.map((c: { name: string }) => c.name);
    expect(names).toContain(`${CLIENT_MARKER}-inactive`);
    expect(names).toContain(`${CLIENT_MARKER}-deleted`);
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

  /**
   * Sprint 8.1 Defect 1, as the symptom that was actually reported: an admin
   * revokes a capability, the bot correctly refuses — and /staff/me kept saying
   * the user still had it, because the route read a second, override-blind
   * resolver. This test fails on the pre-8.1 code.
   *
   * Note app.redis is `{}` in this harness, so it also covers the Redis-down
   * path: the resolver must degrade to DB → floor, never fail open.
   */
  test('reflects an admin override — the value that was previously stale', async () => {
    const KEY = 'bot.tool.get_attendance';

    // Baseline: the role default for a team_member is `true`.
    asUser = authUser({ id: memberId, role: 'team_member' });
    const before = JSON.parse((await app.inject({ method: 'GET', url: '/v1/staff/me' })).payload);
    expect(before.permissions[KEY]).toBe(true);

    // Admin revokes it through the real endpoint (writes + audits + busts cache).
    asUser = authUser({ id: adminId, role: 'admin' });
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/staff/${memberId}/permissions/${KEY}`,
      payload: { value: false },
    });
    expect(put.statusCode).toBe(200);

    asUser = authUser({ id: memberId, role: 'team_member' });
    const after = JSON.parse((await app.inject({ method: 'GET', url: '/v1/staff/me' })).payload);
    expect(after.permissions[KEY]).toBe(false);

    // The SHAPE the frontend consumes is untouched — this fix corrects values only.
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(typeof after.permissions).toBe('object');
    // …and only the revoked key moved.
    for (const k of Object.keys(before.permissions)) {
      if (k !== KEY) expect(after.permissions[k]).toBe(before.permissions[k]);
    }

    await db.deleteFrom('user_permissions').where('staff_id', '=', memberId).execute();
  });

  test('an unknown permission key is rejected by the override endpoint', async () => {
    asUser = authUser({ id: adminId, role: 'admin' });
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/staff/${memberId}/permissions/not.a.real.key`,
      payload: { value: false },
    });
    expect(res.statusCode).toBe(400);
  });
});