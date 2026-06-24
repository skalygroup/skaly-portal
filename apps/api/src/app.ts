import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
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
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { pool, db } from './lib/db.js';
import { redis } from './lib/redis.js';
import internalAuthPlugin from './middleware/internalAuth.plugin.js';
import authPlugin from './middleware/auth.plugin.js';
import { healthRoutes } from './routes/health.js';
import authRoutes from './routes/auth/index.js';
import staffRoutes from './routes/staff/index.js';
import settingsRoutes from './routes/settings/index.js';

/**
 * Builds and fully configures the Fastify instance — WITHOUT calling listen().
 *
 * This is the testable entrypoint: injection-style tests (supertest /
 * app.inject) and the listening entrypoint (server.ts) both consume it.
 * Socket.io is intentionally NOT started here — it binds to the raw HTTP
 * server, which only exists meaningfully once server.ts calls listen(); see
 * registerSockets() in src/sockets/index.ts.
 *
 * Every failure path throws (await on a failing register rejects); callers
 * decide how to handle startup failure. We never console.error-and-continue.
 *
 * Fastify 5 split logger config: a pre-built pino INSTANCE must be passed as
 * `loggerInstance` (the `logger` option only accepts a config object/bool).
 */
export async function buildApp(
  opts: FastifyServerOptions = { loggerInstance: logger },
): Promise<FastifyInstance> {
  const app = Fastify(opts);

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
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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
  // CV upload (signup): 5MB cap, one file per request. Oversized → HTTP 413.
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  });

  // ── Internal auth (B-03: timing-safe CRON_SECRET) ──────────────────
  await app.register(internalAuthPlugin);

  // ── Shared resources on the instance ───────────────────────────────
  // Decorate so handlers can reach the DB/Redis via the Fastify instance
  // (typed in src/types/fastify.d.ts) instead of importing the singletons.
  app.decorate('db', db);
  app.decorate('pool', pool);
  app.decorate('redis', redis);

  // ── User auth (Sprint 1 STEP 4: Supabase RS256 JWT + staff lookup) ──
  // After db/redis are available; before any route plugin so route
  // preHandlers can reference app.verifyJwt / app.requireRole.
  await app.register(authPlugin);

  // ── Routes ─────────────────────────────────────────────────────────
  // Each area is a barrel (routes/<area>/index.ts) that registers its sibling
  // route files; the /v1 version prefix is applied once here, not repeated in
  // every route path. Health stays unversioned-by-convention at /v1/health.
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/v1' });
  await app.register(staffRoutes, { prefix: '/v1' });
  await app.register(settingsRoutes, { prefix: '/v1' });

  return app;
}
