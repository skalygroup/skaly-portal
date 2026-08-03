import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { AppError } from '../../src/lib/errors.js';
import commentsRoutes from '../../src/routes/comments/index.js';

import type { AuthUser } from '../../src/lib/auth-verify.js';
import type { DB } from '@skaly/shared';
import type { FastifyError, FastifyInstance } from 'fastify';

/**
 * /v1/comments (07-API-CONTRACT §Comments).
 *
 * The route is open to all four roles and does NOT filter — the service does,
 * through the shared predicate. These tests assert the envelope, `.strict()`,
 * and that the role outcomes reaching the wire match Auth-Matrix. The row-level
 * rule itself is proved in `services/CommentService.test.ts`.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const ADMIN = 'e8000000-0000-4000-8000-0000000000a1';
const MEMBER = 'e8000000-0000-4000-8000-0000000000b1';
const PEER = 'e8000000-0000-4000-8000-0000000000b2';
const FREELANCER = 'e8000000-0000-4000-8000-0000000000c1';
const CLIENT = 'e8000000-0000-4000-8000-0000000000d1';
const SLOT = 'e8000000-0000-4000-8000-0000000000e1';
const PERIOD = '2092-08';
const DOMAIN = '@commentroute.itest';

let asUser: AuthUser;
let app: FastifyInstance;

function authUser(over: Partial<AuthUser> = {}): AuthUser {
  return {
    id: MEMBER,
    supabase_uid: 'uid',
    name: 'Route Member',
    email: `m${DOMAIN}`,
    role: 'team_member',
    active: true,
    mfa_enrolled: false,
    avatar_url: null,
    ...over,
  };
}

const body = { module: 'shoot_planner', recordId: CLIENT, period: PERIOD, content: 'hello' };
const listUrl = `/v1/comments?module=shoot_planner&recordId=${CLIENT}&period=${PERIOD}`;

const postAs = (user: AuthUser, over: Record<string, unknown> = {}) => {
  asUser = user;
  return app.inject({ method: 'POST', url: '/v1/comments', payload: { ...body, ...over } });
};

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN, name: 'Route Admin', email: `a${DOMAIN}`, role: 'admin', active: true },
      { id: MEMBER, name: 'Route Member', email: `m${DOMAIN}`, role: 'team_member', active: true },
      { id: PEER, name: 'Route Peer', email: `p${DOMAIN}`, role: 'team_member', active: true },
      { id: FREELANCER, name: 'Route Freelancer', email: `f${DOMAIN}`, role: 'freelancer', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('clients')
    .values({ id: CLIENT, name: 'Route Client', shoot_slots_per_month: 1, active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();
  await db
    .insertInto('shoot_schedules')
    .values({ id: SLOT, period: PERIOD, client_id: CLIENT, slot_index: 1, freelancer_id: FREELANCER })
    .onConflict((oc) => oc.column('id').doNothing())
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
  app.decorate('verifyJwt', async (req: { user?: AuthUser }) => {
    req.user = asUser;
  });
  await app.register(commentsRoutes, { prefix: '/v1' });
  await app.ready();
});

beforeEach(async () => {
  await db.deleteFrom('comments').where('period', '=', PERIOD).execute();
  await db.deleteFrom('notifications').where('type', '=', 'new_comment').execute();
  asUser = authUser();
});

afterAll(async () => {
  await app.close();
  await db.deleteFrom('comments').where('period', '=', PERIOD).execute();
  await db.deleteFrom('notifications').where('type', '=', 'new_comment').execute();
  await db.deleteFrom('shoot_schedules').where('id', '=', SLOT).execute();
  await db.destroy();
});

describe('POST /v1/comments', () => {
  test('201 with the comment in a data envelope (§1.1)', async () => {
    const res = await postAs(authUser());
    expect(res.statusCode).toBe(201);

    const payload = JSON.parse(res.payload);
    expect(Object.keys(payload)).toEqual(['data']);
    expect(payload.data).toMatchObject({
      content: 'hello',
      module: 'shoot_planner',
      recordId: CLIENT,
      author: { staffId: MEMBER, role: 'team_member' },
      acknowledgedBy: null,
    });
  });

  test('.strict() rejects an unknown field', async () => {
    const res = await postAs(authUser(), { recordContext: 'spoofed / Shoot Planner' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('VALIDATION_ERROR');
  });

  test('rejects a module the schema does not have (there is no tasks comment surface)', async () => {
    const res = await postAs(authUser(), { module: 'tasks' });
    expect(res.statusCode).toBe(400);
  });

  test('rejects empty and over-long content', async () => {
    expect((await postAs(authUser(), { content: '   ' })).statusCode).toBe(400);
    expect((await postAs(authUser(), { content: 'x'.repeat(2001) })).statusCode).toBe(400);
  });

  test('every role that can reach the record may comment on it', async () => {
    for (const user of [
      authUser({ id: ADMIN, role: 'admin' }),
      authUser({ id: MEMBER, role: 'team_member' }),
      authUser({ id: FREELANCER, role: 'freelancer' }),
    ]) {
      expect((await postAs(user)).statusCode, user.role).toBe(201);
    }
  });

  test('content is stored raw — sanitising is the renderer\'s job (NFR §4.3)', async () => {
    const script = '<script>alert(1)</script>';
    const res = await postAs(authUser(), { content: script });

    expect(JSON.parse(res.payload).data.content).toBe(script);
    const stored = await db
      .selectFrom('comments')
      .select('content')
      .where('period', '=', PERIOD)
      .executeTakeFirstOrThrow();
    expect(stored.content).toBe(script);
  });
});

describe('GET /v1/comments', () => {
  test('200 with a data array, and the route does not filter — the service does', async () => {
    await postAs(authUser());
    await postAs(authUser({ id: PEER, name: 'Route Peer', role: 'team_member' }));

    asUser = authUser({ id: ADMIN, role: 'admin' });
    const res = await app.inject({ method: 'GET', url: listUrl });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data).toHaveLength(2);
  });

  test('a peer team_member does not receive another member\'s comment (Auth-Matrix)', async () => {
    await postAs(authUser());

    asUser = authUser({ id: PEER, name: 'Route Peer' });
    const res = await app.inject({ method: 'GET', url: listUrl });
    expect(JSON.parse(res.payload).data).toEqual([]);
  });

  test('.strict() rejects an unknown query param', async () => {
    const res = await app.inject({ method: 'GET', url: `${listUrl}&limit=5` });
    expect(res.statusCode).toBe(400);
  });

  test('a malformed recordId is a 400, not a 500', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/comments?module=shoot_planner&recordId=not-a-uuid&period=${PERIOD}`,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /v1/comments/:id/acknowledge', () => {
  const create = async (): Promise<string> =>
    JSON.parse((await postAs(authUser())).payload).data.id;

  test('an admin acknowledges (200, acknowledgedBy + acknowledgedAt)', async () => {
    const id = await create();

    asUser = authUser({ id: ADMIN, role: 'admin' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/comments/${id}/acknowledge`,
      payload: { acknowledged: true },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.acknowledgedBy).toBe(ADMIN);
  });

  test('a team_member is refused (admin/manager only)', async () => {
    const id = await create();

    asUser = authUser();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/comments/${id}/acknowledge`,
      payload: { acknowledged: true },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error.code).toBe('PERMISSION_DENIED');
  });

  test('a freelancer is refused', async () => {
    const id = await create();

    asUser = authUser({ id: FREELANCER, role: 'freelancer' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/comments/${id}/acknowledge`,
      payload: { acknowledged: true },
    });
    expect(res.statusCode).toBe(403);
  });

  test('.strict() rejects an unknown body field', async () => {
    const id = await create();

    asUser = authUser({ id: ADMIN, role: 'admin' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/comments/${id}/acknowledge`,
      payload: { acknowledged: true, acknowledgedBy: MEMBER },
    });
    expect(res.statusCode).toBe(400);
  });
});
