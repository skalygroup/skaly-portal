import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { pool } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';

import type { FastifyInstance } from 'fastify';

/**
 * M-06: @fastify/rate-limit must advertise the client's budget on responses so
 * callers can self-throttle. We boot the REAL app (same buildApp() the server
 * uses) and hit an unauthenticated endpoint — the rate-limit onRequest hook
 * runs before the handler, so the x-ratelimit-* headers are present regardless
 * of the handler's own status code (health may be 200 or 503 depending on
 * infra; either way the headers must be there).
 */
describe('Rate-limit headers (M-06)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
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