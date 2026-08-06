import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { Kysely, PostgresDialect } from 'kysely';
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

const internalRoutes = (await import('../../src/routes/internal/index.js')).default;
const internalAuthPlugin = (await import('../../src/middleware/internalAuth.plugin.js')).default;

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
  await instance.register(internalRoutes, { prefix: '/v1' });
  await instance.ready();
  return instance;
}

const ENDPOINTS = [
  '/v1/internal/attachment-sweep',
  '/v1/internal/message-retention',
  '/v1/internal/recompute-shoot-dates',
] as const;

const call = (url: string, secret?: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: secret === undefined ? {} : { 'x-internal-secret': secret },
  });

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
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
