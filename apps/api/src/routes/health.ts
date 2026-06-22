import type { FastifyInstance } from 'fastify';

// Process start time, captured at module load, for uptime reporting.
const startTime = Date.now();

// Each dependency probe is bounded so a hung dependency can't stall the
// health endpoint — it falls back to ok=false instead.
const PROBE_TIMEOUT_MS = 2000;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout`)), PROBE_TIMEOUT_MS),
    ),
  ]);
}

/**
 * GET /v1/health — liveness + dependency check.
 *
 * Unauthenticated (monitoring services hit it, per 07-API-CONTRACT). Always
 * responds — never 500 — so monitoring can distinguish "partially degraded"
 * from "process crashed". Canonical contract:
 *
 *   {
 *     status: "ok" | "degraded",
 *     uptime: <integer seconds since process start>,
 *     timestamp: "<ISO-8601 UTC>",
 *     services: {
 *       database: { ok: boolean, pool: { total, idle, waiting } },  // H-09 pool stats
 *       redis:    { ok: boolean }
 *     }
 *   }
 *
 * HTTP 200 when both services ok, HTTP 503 when any is down.
 */
export async function healthRoutes(app: FastifyInstance) {
  app.get('/v1/health', async (_request, reply) => {
    const [dbResult, redisResult] = await Promise.allSettled([
      withTimeout(app.pool.query('SELECT 1'), 'database'),
      withTimeout(app.redis.ping(), 'redis'),
    ]);

    const dbOk = dbResult.status === 'fulfilled';
    const redisOk = redisResult.status === 'fulfilled';

    if (!dbOk) {
      app.log.error({ err: dbResult.reason }, 'health: database check failed');
    }
    if (!redisOk) {
      app.log.error({ err: redisResult.reason }, 'health: redis check failed');
    }

    const status = dbOk && redisOk ? 'ok' : 'degraded';

    return reply.status(status === 'ok' ? 200 : 503).send({
      status,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      services: {
        database: {
          ok: dbOk,
          pool: {
            total: app.pool.totalCount,
            idle: app.pool.idleCount,
            waiting: app.pool.waitingCount,
          },
        },
        redis: { ok: redisOk },
      },
    });
  });
}
