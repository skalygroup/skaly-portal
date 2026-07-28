import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';
import { Redis } from 'ioredis';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { AppError } from '../../src/lib/errors.js';
import chatRoutes from '../../src/routes/chat/index.js';

import type { AuthUser } from '../../src/lib/auth-verify.js';
import type { DB } from '@skaly/shared';
import type { FastifyError, FastifyInstance } from 'fastify';

/**
 * /v1/chat/* routes (Sprint 10 STEP 7).
 *
 * The access grid is the point of this file. Auth-Matrix §3 marks /chat 🔧 for
 * freelancers — default-denied and admin-grantable — so the override is tested BOTH
 * ways at the HTTP boundary, not only in the service.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const ADMIN = 'e9000000-0000-4000-8000-00000000b001';
const MEMBER = 'e9000000-0000-4000-8000-00000000b002';
const FREELANCER = 'e9000000-0000-4000-8000-00000000b003';
const DOMAIN = '@chatroute.itest';
const staffIds = [ADMIN, MEMBER, FREELANCER];

let asUser: AuthUser;
let app: FastifyInstance;

function authUser(over: Partial<AuthUser> = {}): AuthUser {
  return {
    id: MEMBER,
    supabase_uid: 'uid',
    name: 'Chat Member',
    email: `member${DOMAIN}`,
    role: 'team_member',
    active: true,
    mfa_enrolled: false,
    avatar_url: null,
    ...over,
  };
}

const post = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/v1/chat/messages', payload: payload as object });

async function clearChat(): Promise<void> {
  await sql`
    DELETE FROM messages
    WHERE channel = 'common'
       OR parent_id IN (SELECT id FROM messages WHERE channel = 'common')
  `.execute(db);
  await db.deleteFrom('notifications').where('staff_id', 'in', staffIds).execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN, name: 'Route Admin', email: `admin${DOMAIN}`, role: 'admin', active: true },
      { id: MEMBER, name: 'Chat Member', email: `member${DOMAIN}`, role: 'team_member', active: true },
      { id: FREELANCER, name: 'Route Free', email: `free${DOMAIN}`, role: 'freelancer', active: true },
    ])
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
  app.decorate('redis', redis);
  app.decorate('verifyJwt', async (req: { user?: AuthUser }) => {
    req.user = asUser;
  });
  await app.register(chatRoutes, { prefix: '/v1' });
  await app.ready();
});

beforeEach(async () => {
  await clearChat();
  await db.deleteFrom('user_permissions').where('staff_id', 'in', staffIds).execute();
  await redis.del(...staffIds.map((id) => `perms:${id}`));
  asUser = authUser();
});

afterAll(async () => {
  await app.close();
  await clearChat();
  await db.deleteFrom('user_permissions').where('staff_id', 'in', staffIds).execute();
  await db.deleteFrom('audit_log').where('staff_id', 'in', staffIds).execute();
  await db.deleteFrom('staff').where('id', 'in', staffIds).execute();
  await redis.quit();
  await db.destroy();
});

describe('POST /v1/chat/messages', () => {
  test('201 with the complete message, so clients append without refetching', async () => {
    const res = await post({ content: 'hello everyone' });

    expect(res.statusCode).toBe(201);
    const { data } = JSON.parse(res.payload);
    expect(data).toMatchObject({
      channel: 'common',
      senderId: MEMBER,
      senderName: 'Chat Member',
      content: 'hello everyone',
      parentId: null,
      replyCount: 0,
      isDeleted: false,
    });
    expect(data.id).toBeTruthy();
    expect(data.createdAt).toBeTruthy();
  });

  test('a threaded reply carries its parentId', async () => {
    const parent = JSON.parse((await post({ content: 'parent' })).payload).data;
    const res = await post({ content: 'reply', parentId: parent.id });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).data.parentId).toBe(parent.id);
  });

  test('.strict() rejects an unknown body field', async () => {
    const res = await post({ content: 'hi', channel: 'bot' });
    expect(res.statusCode).toBe(400);
  });

  test('empty and over-length content are 400', async () => {
    expect((await post({ content: '' })).statusCode).toBe(400);
    expect((await post({ content: 'x'.repeat(4001) })).statusCode).toBe(400);
  });

  test('a non-uuid parentId is 400', async () => {
    const res = await post({ content: 'hi', parentId: 'nope' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/chat/messages', () => {
  test('returns newest first with a nextCursor in meta', async () => {
    for (const c of ['one', 'two', 'three']) await post({ content: c });

    const res = await app.inject({ method: 'GET', url: '/v1/chat/messages?limit=2' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.payload);
    expect(body.data.map((m: { content: string }) => m.content)).toEqual(['three', 'two']);
    expect(body.meta.nextCursor).toBeTruthy();
  });

  test('the cursor walks to the next page with no overlap', async () => {
    for (const c of ['one', 'two', 'three']) await post({ content: c });

    const first = JSON.parse((await app.inject({ method: 'GET', url: '/v1/chat/messages?limit=2' })).payload);
    const second = JSON.parse(
      (await app.inject({ method: 'GET', url: `/v1/chat/messages?limit=2&cursor=${first.meta.nextCursor}` })).payload,
    );

    expect(second.data.map((m: { content: string }) => m.content)).toEqual(['one']);
    expect(second.meta.nextCursor).toBeNull();
  });

  test('limit is capped', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/chat/messages?limit=500' })).statusCode).toBe(400);
  });

  test('.strict() rejects an unknown query field', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/chat/messages?channel=bot' })).statusCode).toBe(400);
  });
});

describe('GET /v1/chat/messages/:id/thread', () => {
  test('returns the replies, oldest first', async () => {
    const parent = JSON.parse((await post({ content: 'parent' })).payload).data;
    await post({ content: 'first' , parentId: parent.id });
    await post({ content: 'second', parentId: parent.id });

    const res = await app.inject({ method: 'GET', url: `/v1/chat/messages/${parent.id}/thread` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.map((m: { content: string }) => m.content)).toEqual([
      'first',
      'second',
    ]);
  });
});

describe('DELETE /v1/chat/messages/:id', () => {
  test('the author can delete their own', async () => {
    const msg = JSON.parse((await post({ content: 'mine' })).payload).data;
    const res = await app.inject({ method: 'DELETE', url: `/v1/chat/messages/${msg.id}` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ data: { deleted: true } });
  });

  test("a member cannot delete someone else's, an admin can", async () => {
    asUser = authUser({ id: ADMIN, role: 'admin' });
    const theirs = JSON.parse((await post({ content: 'admin message' })).payload).data;

    asUser = authUser();
    expect((await app.inject({ method: 'DELETE', url: `/v1/chat/messages/${theirs.id}` })).statusCode).toBe(403);

    asUser = authUser({ id: ADMIN, role: 'admin' });
    expect((await app.inject({ method: 'DELETE', url: `/v1/chat/messages/${theirs.id}` })).statusCode).toBe(200);
  });

  test('an unknown id is 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/chat/messages/e9000000-0000-4000-8000-0000000000ff',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/chat/search', () => {
  test('finds a match and is separate from /v1/search', async () => {
    await post({ content: 'the quarterly report is late' });
    await post({ content: 'unrelated chatter' });

    const res = await app.inject({ method: 'GET', url: '/v1/chat/search?q=quarterly' });
    expect(res.statusCode).toBe(200);
    const contents = JSON.parse(res.payload).data.map((m: { content: string }) => m.content);
    expect(contents).toEqual(['the quarterly report is late']);
  });

  test('a missing q is 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/chat/search' })).statusCode).toBe(400);
  });
});

describe('⭐ the Auth-Matrix §3 access grid', () => {
  test.each([
    ['admin', ADMIN],
    ['manager', ADMIN],
    ['team_member', MEMBER],
  ] as const)('%s reaches chat by default', async (role, id) => {
    asUser = authUser({ id, role });
    expect((await app.inject({ method: 'GET', url: '/v1/chat/messages' })).statusCode).toBe(200);
    expect((await post({ content: `${role} says hi` })).statusCode).toBe(201);
  });

  test('⭐ a freelancer is 403 on EVERY route by default', async () => {
    asUser = authUser({ id: FREELANCER, role: 'freelancer' });

    expect((await app.inject({ method: 'GET', url: '/v1/chat/messages' })).statusCode).toBe(403);
    expect((await post({ content: 'let me in' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/chat/search?q=x' })).statusCode).toBe(403);

    const body = JSON.parse((await app.inject({ method: 'GET', url: '/v1/chat/messages' })).payload);
    expect(body.error.code).toBe('PERMISSION_DENIED');
  });

  test('⭐ with the chat.access override granted, the SAME freelancer gets 200', async () => {
    await db
      .insertInto('user_permissions')
      .values({ staff_id: FREELANCER, permission_key: 'chat.access', value: true, set_by: ADMIN })
      .execute();
    // The perms cache is 5-minute TTL with invalidation on write; the test clears it
    // directly because it wrote the override behind the service's back.
    await redis.del(`perms:${FREELANCER}`);

    asUser = authUser({ id: FREELANCER, role: 'freelancer' });
    expect((await app.inject({ method: 'GET', url: '/v1/chat/messages' })).statusCode).toBe(200);
    expect((await post({ content: 'now I am in' })).statusCode).toBe(201);
  });

  test('a false override denies a role that defaults to allowed', async () => {
    await db
      .insertInto('user_permissions')
      .values({ staff_id: MEMBER, permission_key: 'chat.access', value: false, set_by: ADMIN })
      .execute();
    await redis.del(`perms:${MEMBER}`);

    // A gate that only ever grants is half a gate.
    expect((await app.inject({ method: 'GET', url: '/v1/chat/messages' })).statusCode).toBe(403);
  });
});
