import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { pool } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';

import type { FastifyInstance } from 'fastify';

/**
 * The global error handler must not report a bad REQUEST as a server fault.
 *
 * Fastify raises its own 4xx for things it rejects before a handler ever runs —
 * a malformed JSON body, an empty body that declares application/json, an
 * unsupported media type. Nothing in setErrorHandler claimed those, so they fell
 * through to the catch-all and came back 500 INTERNAL_ERROR. Found during the
 * Sprint 8 STEP 10 walk-through, where a bodyless DELETE sent with a JSON
 * content-type looked for all the world like a broken endpoint.
 *
 * Boots the REAL buildApp() — the handler under test is registered there, so a
 * hand-rolled Fastify instance would not exercise it.
 */
describe('global error handler — Fastify client errors keep their 4xx', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool.end();
    redis.disconnect();
  });

  it('an empty body declaring application/json is 400, not 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bot/message',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('VALIDATION_ERROR');
  });

  it('a malformed JSON body is 400, not 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bot/message',
      headers: { 'content-type': 'application/json' },
      payload: '{ this is not json',
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('VALIDATION_ERROR');
  });

  it('never leaks the FST_ERR_* internal code to the client', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bot/message',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    expect(res.payload).not.toContain('FST_ERR');
    // …and no traceId either — that belongs to the sanitised 500 path, and its
    // presence here would mean this was still being treated as a server fault.
    expect(JSON.parse(res.payload).error.details?.traceId).toBeUndefined();
  });
});
