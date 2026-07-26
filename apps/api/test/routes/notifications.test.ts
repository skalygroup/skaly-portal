import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { transactionWithEmits } from '../../src/lib/emit-after-commit.js';
import { AppError } from '../../src/lib/errors.js';
import notificationsRoutes from '../../src/routes/notifications/index.js';
import { NotificationService } from '../../src/services/NotificationService.js';

import type { AuthUser } from '../../src/lib/auth-verify.js';
import type { DB } from '@skaly/shared';
import type { FastifyError, FastifyInstance } from 'fastify';

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const OWNER = 'e7000000-0000-4000-8000-00000000d001';
const OTHER = 'e7000000-0000-4000-8000-00000000d002';
const DOMAIN = '@notifroute.itest';

const service = new NotificationService();
let asUser: AuthUser;
let app: FastifyInstance;

function authUser(over: Partial<AuthUser> = {}): AuthUser {
  return {
    id: OWNER,
    supabase_uid: 'uid',
    name: 'Bell Owner',
    email: `owner${DOMAIN}`,
    role: 'team_member',
    active: true,
    mfa_enrolled: false,
    avatar_url: null,
    ...over,
  };
}

/** Seed one notification directly, returning its id. */
async function seed(
  recipientId: string,
  title: string,
  opts: { read?: boolean } = {},
): Promise<string> {
  const row = await transactionWithEmits(db, (trx) =>
    service.create({
      recipientId,
      type: 'task_assigned',
      title,
      data: { taskId: 't-1', period: '2026-07' },
      trx,
    }),
  );
  if (opts.read) {
    await db.updateTable('notifications').set({ is_read: true }).where('id', '=', row!.id).execute();
  }
  return row!.id;
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: OWNER, name: 'Bell Owner', email: `owner${DOMAIN}`, role: 'team_member', active: true },
      { id: OTHER, name: 'Bell Other', email: `other${DOMAIN}`, role: 'team_member', active: true },
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
  app.decorate('verifyJwt', async (req: { user?: AuthUser }) => {
    req.user = asUser;
  });
  await app.register(notificationsRoutes, { prefix: '/v1' });
  await app.ready();
});

beforeEach(async () => {
  await db.deleteFrom('notifications').where('staff_id', 'in', [OWNER, OTHER]).execute();
  asUser = authUser();
});

afterAll(async () => {
  await app.close();
  await db.deleteFrom('notifications').where('staff_id', 'in', [OWNER, OTHER]).execute();
  await db.deleteFrom('staff').where('id', 'in', [OWNER, OTHER]).execute();
  await db.destroy();
});

describe('GET /v1/notifications', () => {
  test('returns the caller rows newest first, with unreadCount in meta', async () => {
    await seed(OWNER, 'first');
    await seed(OWNER, 'second');
    await seed(OWNER, 'third', { read: true });

    const res = await app.inject({ method: 'GET', url: '/v1/notifications' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.payload);
    expect(body.data).toHaveLength(3);
    expect(body.data[0].title).toBe('third');
    expect(body.meta).toMatchObject({ unreadCount: 2, totalReturned: 3, limit: 50 });
  });

  test('⭐ the count and the list come from ONE request, so they cannot disagree', async () => {
    await seed(OWNER, 'unread one');
    await seed(OWNER, 'unread two');

    const res = await app.inject({ method: 'GET', url: '/v1/notifications' });
    const body = JSON.parse(res.payload);

    // A badge fetched separately from its panel is how you get "3" over an empty
    // list. Same response, same transaction-free read, one truth.
    expect(body.meta.unreadCount).toBe(body.data.filter((n: { isRead: boolean }) => !n.isRead).length);
  });

  test('?unread=true returns only unread, but unreadCount still counts them all', async () => {
    await seed(OWNER, 'unread');
    await seed(OWNER, 'already read', { read: true });

    const res = await app.inject({ method: 'GET', url: '/v1/notifications?unread=true' });
    const body = JSON.parse(res.payload);

    expect(body.data).toHaveLength(1);
    expect(body.data[0].title).toBe('unread');
    expect(body.meta.unreadCount).toBe(1);
  });

  test('⭐ scoped to the caller — another staff member rows are never returned', async () => {
    await seed(OTHER, "someone else's notification");
    await seed(OWNER, 'mine');

    const res = await app.inject({ method: 'GET', url: '/v1/notifications' });
    const body = JSON.parse(res.payload);

    // The ROUTE does not filter; the service does. This asserts the boundary holds.
    expect(body.data).toHaveLength(1);
    expect(body.data[0].title).toBe('mine');
  });

  test('the payload survives the round trip, so linkBuilder has what it needs', async () => {
    await seed(OWNER, 'with payload');
    const res = await app.inject({ method: 'GET', url: '/v1/notifications' });
    const body = JSON.parse(res.payload);

    expect(body.data[0].payload).toEqual({ taskId: 't-1', period: '2026-07' });
  });

  test('limit is capped at 50 — the L-07 window is a decision, not a default', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/notifications?limit=500' });
    expect(res.statusCode).toBe(400);
  });

  test('.strict() rejects an unknown query field', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/notifications?bogus=1' });
    expect(res.statusCode).toBe(400);
  });

  test('an empty bell returns an empty list and a zero count, not an error', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/notifications' });
    const body = JSON.parse(res.payload);
    expect(body.data).toEqual([]);
    expect(body.meta.unreadCount).toBe(0);
  });
});

describe('PUT /v1/notifications/:id/read', () => {
  test('marks one read and returns { read: true }', async () => {
    const id = await seed(OWNER, 'to be read');

    const res = await app.inject({ method: 'PUT', url: `/v1/notifications/${id}/read` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ data: { read: true } });

    const row = await db
      .selectFrom('notifications')
      .select('is_read')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.is_read).toBe(true);
  });

  test("⭐ cannot mark someone else's notification read — 404, not 403", async () => {
    const id = await seed(OTHER, "someone else's");

    const res = await app.inject({ method: 'PUT', url: `/v1/notifications/${id}/read` });

    // 404 rather than 403: ownership must not be discoverable by probing ids.
    expect(res.statusCode).toBe(404);

    const row = await db
      .selectFrom('notifications')
      .select('is_read')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.is_read).toBe(false);
  });

  test('an unknown id is 404', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/notifications/e7000000-0000-4000-8000-0000000000ff/read',
    });
    expect(res.statusCode).toBe(404);
  });

  test('a non-uuid id is 400', async () => {
    const res = await app.inject({ method: 'PUT', url: '/v1/notifications/not-a-uuid/read' });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /v1/notifications/read-all', () => {
  test('clears every unread and returns how many changed', async () => {
    await seed(OWNER, 'a');
    await seed(OWNER, 'b');
    await seed(OWNER, 'c', { read: true });

    const res = await app.inject({ method: 'PUT', url: '/v1/notifications/read-all' });
    expect(res.statusCode).toBe(200);
    // Only the two that were actually unread.
    expect(JSON.parse(res.payload)).toEqual({ data: { updatedCount: 2 } });

    const after = await app.inject({ method: 'GET', url: '/v1/notifications' });
    expect(JSON.parse(after.payload).meta.unreadCount).toBe(0);
  });

  test("⭐ does not touch another staff member's notifications", async () => {
    await seed(OTHER, 'theirs');
    await seed(OWNER, 'mine');

    await app.inject({ method: 'PUT', url: '/v1/notifications/read-all' });

    const theirs = await db
      .selectFrom('notifications')
      .select('is_read')
      .where('staff_id', '=', OTHER)
      .executeTakeFirstOrThrow();
    expect(theirs.is_read).toBe(false);
  });

  test('read-all on an empty bell is 0, not an error', async () => {
    const res = await app.inject({ method: 'PUT', url: '/v1/notifications/read-all' });
    expect(JSON.parse(res.payload)).toEqual({ data: { updatedCount: 0 } });
  });
});

describe('every authenticated role reaches the bell', () => {
  test.each(['admin', 'manager', 'team_member', 'freelancer'] as const)(
    '%s gets 200 — notifications are not role-gated, they are recipient-scoped',
    async (role) => {
      asUser = authUser({ role });
      const res = await app.inject({ method: 'GET', url: '/v1/notifications' });
      expect(res.statusCode).toBe(200);
    },
  );
});
