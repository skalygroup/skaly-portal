import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

import type * as EnvModule from '../../src/lib/env.js';
import type * as R2Module from '../../src/lib/r2.js';
import type { DB } from '@skaly/shared';

/**
 * /v1/internal/* — the three Sprint 12 cron entry points.
 *
 * The jobs themselves are tested under test/jobs. What is asserted here is the
 * boundary: these are reachable ONLY with the shared secret, they carry no JWT
 * path at all, and each returns its summary rather than a bare 204 — an
 * unattended job that reports nothing is one nobody can tell has stopped.
 */
const SECRET = 'test-cron-secret-that-is-at-least-32-characters-long!!';

vi.mock('../../src/lib/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return { ...actual, env: { ...actual.env, CRON_SECRET: SECRET } };
});

// R2 is not reachable from a test runner; the sweep's own behaviour is covered
// in test/jobs/attachment-orphan-sweep.test.ts.
vi.mock('../../src/lib/r2.js', async (importOriginal) => {
  const actual = await importOriginal<typeof R2Module>();
  return {
    ...actual,
    listR2Objects: vi.fn(() => Promise.resolve({ objects: [], nextToken: undefined })),
    deleteR2Objects: vi.fn(() => Promise.resolve()),
  };
});

// The rollover summary must never reach the real API from a test runner.
vi.mock('../../src/lib/anthropic.js', () => ({
  getAnthropic: () => {
    throw new Error('no anthropic in tests');
  },
}));

const internalRoutes = (await import('../../src/routes/internal/index.js')).default;
const internalAuthPlugin = (await import('../../src/middleware/internalAuth.plugin.js')).default;
const authPlugin = (await import('../../src/middleware/auth.plugin.js')).default;

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

let app: Awaited<ReturnType<typeof buildTestApp>>;

async function buildTestApp() {
  const instance = Fastify();
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  instance.decorate('db', db);
  await instance.register(internalAuthPlugin);
  // /internal/rollover is the ONE internal route with a session path (ADR-037 §4 —
  // the [Manual rollover] button posts to the same idempotent endpoint the cron
  // does), so its verifyJwt/requireRole decorators have to exist here too.
  await instance.register(authPlugin);
  await instance.register(internalRoutes, { prefix: '/v1' });
  await instance.ready();
  return instance;
}

const ENDPOINTS = [
  '/v1/internal/attachment-sweep',
  '/v1/internal/message-retention',
  '/v1/internal/recompute-shoot-dates',
] as const;

const ROLLOVER = '/v1/internal/rollover';
/** Far from every other suite's periods, and far from anything the seed touches. */
const ROLLOVER_PERIOD = '2091-04';

const call = (url: string, secret?: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: secret === undefined ? {} : { 'x-internal-secret': secret },
  });

async function cleanupRollover() {
  await db
    .deleteFrom('notifications')
    .where(sql<boolean>`payload->>'period' = ${ROLLOVER_PERIOD}`)
    .execute();
  await db
    .deleteFrom('audit_log')
    .where('table_name', '=', 'months')
    .where(sql<boolean>`new_value->>'period' = ${ROLLOVER_PERIOD}`)
    .execute();
  for (const t of ['content_calendar', 'shoot_schedules', 'content_pipelines', 'attendance_logs'] as const) {
    await db.deleteFrom(t).where('period', '=', ROLLOVER_PERIOD).execute();
  }
  await db.deleteFrom('months').where('period', '=', ROLLOVER_PERIOD).execute();
}

beforeAll(async () => {
  app = await buildTestApp();
  await cleanupRollover();
});

afterAll(async () => {
  await cleanupRollover();
  await app.close();
  await db.destroy();
});

describe('the secret is the only way in', () => {
  test.each(ENDPOINTS)('%s rejects a request with no header (401)', async (url) => {
    const res = await call(url);
    expect(res.statusCode).toBe(401);
  });

  test.each(ENDPOINTS)('%s rejects a wrong secret (401)', async (url) => {
    const res = await call(url, 'x'.repeat(SECRET.length));
    expect(res.statusCode).toBe(401);
  });

  test('a secret of the wrong LENGTH is still a 401, not a crash', async () => {
    // timingSafeEqual throws on unequal buffer lengths; the plugin pre-checks.
    const res = await call(ENDPOINTS[0], 'short');
    expect(res.statusCode).toBe(401);
  });

  test('no endpoint is reachable with a Bearer token instead', async () => {
    const res = await app.inject({
      method: 'POST',
      url: ENDPOINTS[0],
      headers: { authorization: 'Bearer whatever' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('each job reports its summary', () => {
  test('attachment-sweep returns scanned/orphaned/deleted counts', async () => {
    const res = await call(ENDPOINTS[0], SECRET);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data).toMatchObject({
      scanned: expect.any(Number),
      orphaned: expect.any(Number),
      deleted: expect.any(Number),
      skippedTooRecent: expect.any(Number),
    });
  });

  test('message-retention returns what it removed and how many batches it took', async () => {
    const res = await call(ENDPOINTS[1], SECRET);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data).toMatchObject({
      messagesDeleted: expect.any(Number),
      sessionsDeleted: expect.any(Number),
      batches: expect.any(Number),
      hitBatchCap: false,
    });
  });

  test('recompute-shoot-dates defaults to the current IST period', async () => {
    const res = await call(ENDPOINTS[2], SECRET);
    expect(res.statusCode).toBe(200);

    const { data } = JSON.parse(res.payload);
    expect(data.period).toMatch(/^\d{4}-\d{2}$/);
    expect(data).toMatchObject({ clients: expect.any(Number), failed: 0 });
  });

  test('recompute-shoot-dates accepts an explicit period', async () => {
    const res = await call(`${ENDPOINTS[2]}?period=2089-01`, SECRET);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data).toMatchObject({ period: '2089-01', clients: 0 });
  });

  test('a malformed period is a 400, not a silent full-table sweep', async () => {
    const res = await call(`${ENDPOINTS[2]}?period=last-month`, SECRET);
    expect(res.statusCode).toBe(400);
  });

  test('⭐ an unauthenticated caller gets 401 even with a malformed request', async () => {
    // The secret runs onRequest, before validation — so a 400 never confirms the
    // route exists to someone who has not proved they may ask.
    const res = await call(`${ENDPOINTS[2]}?period=garbage`);
    expect(res.statusCode).toBe(401);
  });
});

/**
 * POST /v1/internal/rollover — ADR-037's "two entry points, one idempotent core".
 *
 * The tier behaviour itself lives in test/services/Rollover.failure.test.ts. What
 * is asserted here is only what the ROUTE adds: who may call it, and that calling
 * it twice over HTTP is as safe as calling the service twice.
 */
describe('the rollover endpoint', () => {
  test('rejects a request with no credentials at all (401)', async () => {
    expect((await call(`${ROLLOVER}?period=${ROLLOVER_PERIOD}`)).statusCode).toBe(401);
  });

  test('⭐ a WRONG secret is a 401 — it never falls through to the session path', async () => {
    // The downgrade attack this forecloses: present a bogus secret, get rejected on
    // that path, and be re-evaluated as an anonymous user request. The header's
    // PRESENCE decides which gate runs, so there is nothing to fall through to.
    const res = await call(`${ROLLOVER}?period=${ROLLOVER_PERIOD}`, 'x'.repeat(SECRET.length));
    expect(res.statusCode).toBe(401);
  });

  test('a wrong-LENGTH secret is a 401, not a timingSafeEqual crash', async () => {
    expect((await call(`${ROLLOVER}?period=${ROLLOVER_PERIOD}`, 'short')).statusCode).toBe(401);
  });

  test('an invalid Bearer token is a 401 (the session path is a real gate)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${ROLLOVER}?period=${ROLLOVER_PERIOD}`,
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  test('a malformed period is a 400, not a rollover of something else', async () => {
    expect((await call(`${ROLLOVER}?period=nope`, SECRET)).statusCode).toBe(400);
  });

  test('⭐ POSTing twice creates the month once — the second call reports already_completed', async () => {
    await cleanupRollover();

    const first = await call(`${ROLLOVER}?period=${ROLLOVER_PERIOD}`, SECRET);
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.payload).data).toMatchObject({
      period: ROLLOVER_PERIOD,
      status: 'completed',
      viewsRefreshed: true,
    });

    const second = await call(`${ROLLOVER}?period=${ROLLOVER_PERIOD}`, SECRET);
    expect(second.statusCode).toBe(200);
    // The cron's 3× retry hits this path on every night that is not the 1st, and
    // on every retry after a success. It must cost one SELECT and nothing else.
    expect(JSON.parse(second.payload).data.status).toBe('already_completed');

    const months = await db
      .selectFrom('months')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('period', '=', ROLLOVER_PERIOD)
      .executeTakeFirstOrThrow();
    expect(Number(months.n)).toBe(1);

    await cleanupRollover();
  });
});
