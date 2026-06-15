import { env } from './lib/env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { logger } from './lib/logger.js';
import { pool } from './lib/db.js';
import { redis } from './lib/redis.js';

// ── Fastify instance ───────────────────────────────────────────────
const app = Fastify({
  logger: logger as any,
});

// Zod type provider
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

// ── Core plugins ───────────────────────────────────────────────────
await app.register(helmet);

await app.register(cors, {
  origin: ['http://localhost:3000', 'https://portal.skaly.in'],
  credentials: true,
});

await app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  addHeaders: {
    'x-ratelimit-limit': true,
    'x-ratelimit-remaining': true,
    'x-ratelimit-reset': true,
    'retry-after': true,
  },
});

await app.register(sensible);
await app.register(multipart);

// ── Socket.io with Redis adapter (TRD §8) ──────────────────────────
const io = new Server(app.server, {
  cors: {
    origin: ['http://localhost:3000', 'https://portal.skaly.in'],
    credentials: true,
  },
});

const pubClient = new Redis(
  env.REDIS_URL,
  env.REDIS_URL.startsWith('rediss://') ? { tls: {} } : {},
);
const subClient = pubClient.duplicate();
io.adapter(createAdapter(pubClient, subClient));

// ── Health route ───────────────────────────────────────────────────
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

// ── Start ──────────────────────────────────────────────────────────
const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info(`🚀 Skaly API listening on http://0.0.0.0:${env.PORT}`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
};

// ── Graceful shutdown ──────────────────────────────────────────────
const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}, shutting down gracefully…`);
  await app.close();
  await pool.end();
  redis.disconnect();
  pubClient.disconnect();
  subClient.disconnect();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
