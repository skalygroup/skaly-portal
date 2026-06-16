import type { FastifyInstance } from 'fastify';
import { pool } from '../lib/db.js';
import { redis } from '../lib/redis.js';

/**
 * GET /v1/health — liveness + dependency check.
 * Returns 200 when both Postgres and Redis are reachable, 503 otherwise.
 * Exposes pool stats (total/idle/waiting) per audit H-09.
 */
export async function healthRoutes(app: FastifyInstance) {
  app.get('/v1/health', async (_request, reply) => {
    const [dbCheck, redisCheck] = await Promise.allSettled([
      pool.query('SELECT 1'),
      redis.ping(),
    ]);

    const dbOk = dbCheck.status === 'fulfilled';
    const redisOk = redisCheck.status === 'fulfilled';
    const ok = dbOk && redisOk;

    return reply.status(ok ? 200 : 503).send({
      status: ok ? 'ok' : 'degraded',
      services: {
        database: dbOk ? 'ok' : 'error',
        redis: redisOk ? 'ok' : 'error',
      },
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
      timestamp: new Date().toISOString(),
    });
  });
}
