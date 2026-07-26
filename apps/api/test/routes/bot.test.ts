import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';
import { Redis } from 'ioredis';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, afterEach, describe, expect, test, vi } from 'vitest';

// getAnthropic() throws without a key and getIo() needs a live socket server —
// neither exists in a route unit test. Mock both so the route can construct its
// BotService; the fire-and-forget handleMessage then runs against the fake
// stream (a clean end_turn) and never touches the network. Real Postgres + real
// Redis, matching the house harness.
vi.mock('../../src/lib/anthropic.js', () => ({
  getAnthropic: () => ({
    messages: {
      stream: () => ({
        on() {
          return this;
        },
        async finalMessage() {
          return {
            id: 'msg_x',
            type: 'message',
            role: 'assistant',
            model: 'test',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      }),
    },
  }),
}));
vi.mock('../../src/sockets/index.js', () => ({
  getIo: () => ({ of: () => ({ to: () => ({ emit: () => undefined }) }) }),
}));

const { AppError } = await import('../../src/lib/errors.js');
const botRoutes = (await import('../../src/routes/bot/index.js')).default;

import type { AuthUser } from '../../src/lib/auth-verify.js';
import type { DB } from '@skaly/shared';
import type { FastifyError, FastifyInstance } from 'fastify';

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const STAFF_ID = 'e3000000-0000-4000-8000-00000000e001';
const DOMAIN = '@botroute.itest';

let asUser: AuthUser;
let app: FastifyInstance;

function authUser(over: Partial<AuthUser> = {}): AuthUser {
  return {
    id: STAFF_ID,
    supabase_uid: 'uid',
    name: 'Bot Caller',
    email: `caller${DOMAIN}`,
    role: 'admin',
    active: true,
    mfa_enrolled: false,
    avatar_url: null,
    ...over,
  };
}

async function cleanup(): Promise<void> {
  await db.deleteFrom('messages').where('sender_id', '=', STAFF_ID).execute();
  await redis.del(`bot:session:${STAFF_ID}`);
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values({ id: STAFF_ID, name: 'Bot Caller', email: `caller${DOMAIN}`, role: 'admin', active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await cleanup();

  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Global limiter with M-06 headers; the POST route adds its own 30/min cap.
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
    // The rate limiter throws a 429 with statusCode set — honour it (app.ts does).
    if (error.statusCode) {
      return reply.status(error.statusCode).send({ error: { code: 'RATE_LIMITED', message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'error' } });
  });
  app.decorate('db', db);
  app.decorate('verifyJwt', async (req: { user?: AuthUser }) => {
    req.user = asUser;
  });
  await app.register(botRoutes, { prefix: '/v1' });
  await app.ready();
});

afterEach(cleanup);

afterAll(async () => {
  await app.close();
  await cleanup();
  await redis.quit();
  await db.destroy();
});

describe('POST /v1/bot/message — C-01 (202 ack only)', () => {
  test('returns 202 with exactly { messageId, sessionId } — no content, no card', async () => {
    asUser = authUser();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bot/message',
      headers: { authorization: 'Bearer c01-token' },
      payload: { content: 'How many tasks are overdue?' },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.payload);
    expect(body.data.messageId).toBeTruthy();
    expect(body.data.sessionId).toBeTruthy();
    // The reply rides the socket, never the HTTP body (C-01).
    expect(body.data).not.toHaveProperty('content');
    expect(body.data).not.toHaveProperty('card');
    expect(Object.keys(body.data).sort()).toEqual(['messageId', 'sessionId']);

    // The user message was archived (channel='bot') — that row IS the messageId.
    const row = await db
      .selectFrom('messages')
      .select(['id', 'channel', 'sender_type'])
      .where('id', '=', body.data.messageId)
      .executeTakeFirst();
    expect(row).toMatchObject({ channel: 'bot', sender_type: 'user' });
  });

  test('empty content → 400 VALIDATION_ERROR', async () => {
    asUser = authUser();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bot/message',
      headers: { authorization: 'Bearer c01-token' },
      payload: { content: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  test('rate-limit headers present; the 31st call in a window → 429', async () => {
    asUser = authUser();
    const hdrs = { authorization: 'Bearer ratelimit-token' };
    let last = await app.inject({ method: 'POST', url: '/v1/bot/message', headers: hdrs, payload: { content: 'hi' } });
    expect(last.headers).toHaveProperty('x-ratelimit-limit');

    // 30/min keyed by the bearer token; the 31st is refused.
    for (let i = 0; i < 30; i++) {
      last = await app.inject({ method: 'POST', url: '/v1/bot/message', headers: hdrs, payload: { content: 'hi' } });
    }
    expect(last.statusCode).toBe(429);
  });
});

describe('POST /v1/bot/message — the turn-2 fields (ADR-014)', () => {
  const CONFIRMATION_ID = 'e3000000-0000-4000-8000-0000000000c1';

  test('a decision + confirmationId still returns 202 — C-01 is unchanged', async () => {
    asUser = authUser();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bot/message',
      headers: { authorization: 'Bearer turn2-token' },
      payload: { content: 'Yes, go ahead', decision: 'confirm', confirmationId: CONFIRMATION_ID },
    });
    expect(res.statusCode).toBe(202);
    expect(Object.keys(JSON.parse(res.payload).data).sort()).toEqual(['messageId', 'sessionId']);
  });

  test('a decision WITHOUT a confirmationId → 400', async () => {
    // The server would resolve this to `stale_id` and answer politely, which is
    // safe but hides a frontend bug — the buttons always bind both.
    asUser = authUser();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bot/message',
      headers: { authorization: 'Bearer turn2b-token' },
      payload: { content: 'yes', decision: 'confirm' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('VALIDATION_ERROR');
  });

  test('a non-uuid confirmationId → 400', async () => {
    asUser = authUser();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bot/message',
      headers: { authorization: 'Bearer turn2c-token' },
      payload: { content: 'yes', decision: 'confirm', confirmationId: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
  });

  test('the schema is strict — the client may not smuggle a tool or its arguments', async () => {
    // ADR-014's rule: the client may reference the pending record by id and may
    // NEVER supply the tool, the input, or the version.
    asUser = authUser();
    for (const extra of [
      { toolName: 'update_task_status' },
      { input: { taskId: 'x', status: 'Done' } },
      { expectedVersion: 1 },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bot/message',
        headers: { authorization: 'Bearer strict-token' },
        payload: { content: 'yes', decision: 'confirm', confirmationId: CONFIRMATION_ID, ...extra },
      });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }
  });

  test('an invalid decision value → 400', async () => {
    asUser = authUser();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bot/message',
      headers: { authorization: 'Bearer turn2d-token' },
      payload: { content: 'yes', decision: 'maybe', confirmationId: CONFIRMATION_ID },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/bot/session/current — session shape ("H-01")', () => {
  test('no session → the null shape', async () => {
    asUser = authUser();
    const res = await app.inject({ method: 'GET', url: '/v1/bot/session/current' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data).toEqual({
      sessionId: null,
      messages: [],
      turnCount: 0,
      lastActivityAt: null,
    });
  });

  test('existing session → { sessionId, messages, turnCount, lastActivityAt }', async () => {
    asUser = authUser();
    await redis.set(
      `bot:session:${STAFF_ID}`,
      JSON.stringify({
        sessionId: 'sess-1',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
        turnCount: 1,
        lastActivityAt: '2026-07-24T00:00:00.000Z',
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/v1/bot/session/current' });
    const data = JSON.parse(res.payload).data;
    expect(Object.keys(data).sort()).toEqual(['lastActivityAt', 'messages', 'sessionId', 'turnCount']);
    expect(data.sessionId).toBe('sess-1');
    expect(data.turnCount).toBe(1);
    expect(data.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });
});

describe('DELETE /v1/bot/session/current — clears the session', () => {
  test('deletes the Redis key → { cleared: true }; a subsequent GET is empty', async () => {
    asUser = authUser();
    await redis.set(`bot:session:${STAFF_ID}`, JSON.stringify({ sessionId: 's', messages: [], turnCount: 0, lastActivityAt: null }));

    const del = await app.inject({ method: 'DELETE', url: '/v1/bot/session/current' });
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.payload).data).toEqual({ cleared: true });
    expect(await redis.exists(`bot:session:${STAFF_ID}`)).toBe(0);

    const get = await app.inject({ method: 'GET', url: '/v1/bot/session/current' });
    expect(JSON.parse(get.payload).data.sessionId).toBeNull();
  });
});
