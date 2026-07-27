import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { pool } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';

import type { FastifyInstance } from 'fastify';

/**
 * M-06: @fastify/rate-limit must advertise the client's budget on responses so
 * callers can self-throttle. We boot the REAL app (same buildApp() the server
 * uses) and hit an unauthenticated endpoint — the rate-limit hook runs before the
 * handler, so the x-ratelimit-* headers are present regardless of the handler's
 * own status code (health may be 200 or 503 depending on infra; either way the
 * headers must be there).
 *
 * The limiter now runs at `preHandler`, not `onRequest` (ADR-024) — it has to see
 * `request.user` to key per user. The headers are unaffected; WHICH BUCKET they
 * describe is covered by rate-limit-keying.test.ts.
 */
describe('Rate-limit headers (M-06)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    // Guard so a beforeAll boot failure (e.g. missing R2 config) surfaces its
    // real error instead of being masked by a "close of undefined" TypeError.
    await app?.close();
    await pool.end();
    redis.disconnect();
  });

  it('emits x-ratelimit-limit / -remaining / -reset on responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });

    expect(res.headers).toHaveProperty('x-ratelimit-limit');
    expect(res.headers).toHaveProperty('x-ratelimit-remaining');
    expect(res.headers).toHaveProperty('x-ratelimit-reset');

    // The advertised limit matches the global cap from 07-API-CONTRACT.md §2,
    // and remaining has been decremented by this request.
    expect(Number(res.headers['x-ratelimit-limit'])).toBe(150);
    expect(Number(res.headers['x-ratelimit-remaining'])).toBeLessThan(150);
    expect(Number(res.headers['x-ratelimit-reset'])).toBeGreaterThanOrEqual(0);
  });
});