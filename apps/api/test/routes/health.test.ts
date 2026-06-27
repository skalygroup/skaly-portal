import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { healthRoutes } from '../../src/routes/health.js';

// Build a bare Fastify instance with mocked pool/redis decorators (the real
// ones are attached in buildApp). This keeps the health-contract test fast and
// independent of live Postgres/Redis.
function makeApp(opts: {
  dbOk: boolean;
  redisOk: boolean;
}): FastifyInstance {
  const app = Fastify({ logger: false });

  const pool = {
    query: opts.dbOk
      ? vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] })
      : vi.fn().mockRejectedValue(new Error('db down')),
    totalCount: 10,
    idleCount: 8,
    waitingCount: 0,
  };
  const redis = {
    ping: opts.redisOk
      ? vi.fn().mockResolvedValue('PONG')
      : vi.fn().mockRejectedValue(new Error('redis down')),
  };

  app.decorate('pool', pool as never);
  app.decorate('redis', redis as never);
  app.register(healthRoutes);
  return app;
}

describe('GET /v1/health', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it('returns 200 with the canonical shape when all services are healthy', async () => {
    app = makeApp({ dbOk: true, redisOk: true });
    const res = await app.inject({ method: 'GET', url: '/v1/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(Number.isInteger(body.uptime)).toBe(true);
    // ISO-8601 UTC timestamp
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(body.services.database.ok).toBe(true);
    expect(body.services.database.pool).toEqual({ total: 10, idle: 8, waiting: 0 });
    expect(body.services.redis.ok).toBe(true);
  });

  it('returns 503 with status=degraded when redis ping fails', async () => {
    app = makeApp({ dbOk: true, redisOk: false });
    const res = await app.inject({ method: 'GET', url: '/v1/health' });

    expect(res.statusCode).toBe(503);
    const body = res.json();

    expect(body.status).toBe('degraded');
    expect(body.services.database.ok).toBe(true);
    expect(body.services.redis.ok).toBe(false);
    // Pool stats are still reported even when degraded.
    expect(body.services.database.pool.waiting).toBe(0);
  });
});
