import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { healthRoutes, probeAuth, __resetAuthProbe } from '../../src/routes/health.js';

// Build a bare Fastify instance with mocked pool/redis decorators (the real
// ones are attached in buildApp). This keeps the health-contract test fast and
// independent of live Postgres/Redis.
function makeApp(opts: { dbOk: boolean; redisOk: boolean }): FastifyInstance {
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

/** The auth probe is a real `fetch` at the Supabase JWKS URL, so tests stub it. */
function stubJwks(impl: () => Promise<unknown>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

describe('GET /v1/health', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    __resetAuthProbe();
    stubJwks(async () => ({ ok: true, status: 200 }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app?.close();
  });

  it('returns 200 with the canonical shape when all services are healthy', async () => {
    await probeAuth(); // settle the probe so `auth.ok` is a boolean, not null
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
    expect(body.services.auth.ok).toBe(true);
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

  // The regression the probe exists for: the Supabase project stopped resolving,
  // nobody could sign in or have a token verified, and health said "ok" because
  // it only watched Postgres and Redis.
  it('reports auth.ok=false when the auth host does not resolve', async () => {
    stubJwks(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await probeAuth()).toBe(false);

    app = makeApp({ dbOk: true, redisOk: true });
    expect(app.inject).toBeDefined();
    const body = (await app.inject({ method: 'GET', url: '/v1/health' })).json();
    expect(body.services.auth.ok).toBe(false);
  });

  // A paused/misconfigured project answers, but with an error status — still
  // "nobody can log in", so a reachability-only check would miss it.
  it('treats a non-2xx JWKS response as auth down', async () => {
    stubJwks(async () => ({ ok: false, status: 503 }));
    expect(await probeAuth()).toBe(false);
  });

  /**
   * THE LOAD-BEARING ONE. INFRA §4 points Railway's healthcheck at this route
   * with restartPolicyType = "ON_FAILURE". If a dead third-party auth host made
   * this 503, Railway would restart the container in a loop for the whole
   * outage — a strictly worse failure than "logins are down", and one no
   * restart can fix. auth must be reported and never enforced.
   */
  it('stays 200/ok when auth is down but db+redis are up', async () => {
    stubJwks(async () => {
      throw new TypeError('fetch failed');
    });
    await probeAuth();

    app = makeApp({ dbOk: true, redisOk: true });
    const res = await app.inject({ method: 'GET', url: '/v1/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.services.auth.ok).toBe(false);
  });

  // The probe must never sit in the request path: this endpoint is the
  // container healthcheck, and a slow third party must not delay it.
  it('does not await the auth probe — a hanging JWKS host cannot stall health', async () => {
    stubJwks(() => new Promise(() => {})); // never settles
    app = makeApp({ dbOk: true, redisOk: true });

    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    const elapsed = Date.now() - started;

    expect(res.statusCode).toBe(200);
    // Nowhere near the 2s probe timeout, let alone a hang.
    expect(elapsed, `health took ${elapsed}ms with a hanging auth host`).toBeLessThan(500);
    // Not yet probed successfully, so it reports null rather than guessing.
    expect(res.json().services.auth.ok).toBeNull();
  });
});
