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
  jsonSchemaTransform,
} from 'fastify-type-provider-zod';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { logger } from './lib/logger.js';
import { pool } from './lib/db.js';
import { redis } from './lib/redis.js';
import internalAuthPlugin from './middleware/internalAuth.plugin.js';
import { setupSocketTokenWatcher } from './middleware/socketTokenWatcher.plugin.js';
import { healthRoutes } from './routes/health.js';

// ── Fastify instance ───────────────────────────────────────────────
// Fastify 5 split logger config: a pre-built logger INSTANCE must be passed
// as `loggerInstance` (the `logger` option only accepts a config object/bool).
const app = Fastify({
  loggerInstance: logger,
});

// Zod type provider
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

// ── Swagger / OpenAPI (dev only, audit M-12) ───────────────────────
if (env.NODE_ENV !== 'production') {
  await app.register(import('@fastify/swagger'), {
    openapi: {
      info: { title: 'Skaly Portal API', version: '0.1.0' },
      servers: [{ url: `http://localhost:${env.PORT}` }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(import('@fastify/swagger-ui'), {
    routePrefix: '/docs',
  });
  logger.info('Swagger UI available at /docs (dev only)');
}

// ── Core plugins ───────────────────────────────────────────────────
await app.register(helmet);

logger.info({ allowedOrigins: env.CORS_ALLOWED_ORIGINS }, 'CORS allowlist loaded');
await app.register(cors, {
  origin: env.CORS_ALLOWED_ORIGINS,
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

// ── Internal auth (B-03: timing-safe CRON_SECRET) ──────────────────
await app.register(internalAuthPlugin);

// ── Socket.io with Redis adapter (TRD §8) ──────────────────────────
const io = new Server(app.server, {
  cors: {
    origin: env.CORS_ALLOWED_ORIGINS,
    credentials: true,
  },
});

const pubClient = new Redis(
  env.REDIS_URL,
  env.REDIS_URL.startsWith('rediss://') ? { tls: {} } : {},
);
const subClient = pubClient.duplicate();
// Attach error handlers so transient Upstash/connection blips are logged
// instead of emitting "missing 'error' handler" warnings or crashing.
pubClient.on('error', (err) => logger.error({ err }, 'Redis pub client error'));
subClient.on('error', (err) => logger.error({ err }, 'Redis sub client error'));
io.adapter(createAdapter(pubClient, subClient));

// ── Socket.io JWT refresh watcher (C-05) ───────────────────────────
setupSocketTokenWatcher(io);

// ── Health route ───────────────────────────────────────────────────
await app.register(healthRoutes);

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
