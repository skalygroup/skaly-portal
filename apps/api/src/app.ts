import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';

import { registerEventListeners } from './events/listeners.js';
import { verifySupabaseToken } from './lib/auth-verify.js';
import { pool, db } from './lib/db.js';
import { env } from './lib/env.js';
import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { registerSwagger } from './lib/swagger.js';
import authPlugin from './middleware/auth.plugin.js';
import internalAuthPlugin from './middleware/internalAuth.plugin.js';
import attendanceRoutes from './routes/attendance/index.js';
import auditLogRoutes from './routes/audit-log/index.js';
import authRoutes from './routes/auth/index.js';
import botRoutes from './routes/bot/index.js';
import chatRoutes from './routes/chat/index.js';
import clientsRoutes from './routes/clients/index.js';
import commentsRoutes from './routes/comments/index.js';
import contentCalendarRoutes from './routes/content-calendar/index.js';
import contentDropperRoutes from './routes/content-dropper/index.js';
import { healthRoutes } from './routes/health.js';
import holidaysRoutes from './routes/holidays/index.js';
import internalRoutes from './routes/internal/index.js';
import monthsRoutes from './routes/months/index.js';
import notificationsRoutes from './routes/notifications/index.js';
import reportsRoutes from './routes/reports/index.js';
import searchRoutes from './routes/search/index.js';
import settingsRoutes from './routes/settings/index.js';
import shootPlannerRoutes from './routes/shoot-planner/index.js';
import staffRoutes from './routes/staff/index.js';
import tasksRoutes from './routes/tasks/index.js';

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
  /**
   * `trustProxy` is a HOP COUNT, never `true` (ADR-024).
   *
   * Without it, `request.ip` behind Railway's proxy is the PROXY's address, so
   * the IP-keyed rate limiter put the entire organisation in one bucket — audit
   * A1, the deploy blocker.
   *
   * `true` is the tempting fix and is a security downgrade: it trusts every
   * entry in `X-Forwarded-For`, including the leftmost one the CLIENT supplies.
   * Since the unauthenticated rate-limit key is the IP and login's brute-force
   * guard is 10/15min, `true` would let an attacker rotate a header per request
   * and bypass login rate limiting entirely. A hop count trusts only the address
   * the proxy appends.
   */
  const app = Fastify({ trustProxy: env.TRUST_PROXY_HOPS, ...opts });

  // Zod type provider
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // ── Global error handler (09-ERROR-HANDLING.md §4) ─────────────────
  // Single sanctioned renderer of the canonical error envelope
  // { error: { code, message, details? } }. Any AppError thrown by a service
  // or route surfaces here with its registered status; anything unexpected is
  // sanitised to INTERNAL_ERROR with a traceId. Sprint 1 auth routes still
  // catch their own AuthError locally and return before reaching this handler.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Known application errors.
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }

    // Zod schema validation failures (fastify-type-provider-zod).
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: {
            fields: error.validation.map((v) => ({
              field: v.instancePath,
              message: v.message,
            })),
          },
        },
      });
    }

    // Rate limiting (@fastify/rate-limit).
    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please slow down.',
        },
      });
    }

    // Fastify's OWN client errors — malformed JSON, an empty body declaring
    // application/json, unsupported media type, payload too large. They already
    // carry the right 4xx, but nothing claimed them, so they fell through to the
    // 500 branch below and a bad REQUEST was reported as a server fault. That
    // sends whoever is debugging looking at the server instead of their call
    // (it cost us exactly that during the Sprint 8 STEP 10 walk-through).
    //
    // The status is Fastify's; the code stays VALIDATION_ERROR (Error-Handling
    // §Data Integrity) so FST_ERR_* internals never reach a client. 5xx still
    // falls through and is sanitised below.
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.warn({ err: error, url: request.url }, 'Client error');
      return reply.status(error.statusCode).send({
        error: { code: 'VALIDATION_ERROR', message: error.message },
      });
    }

    // Unexpected — sanitise, log with a correlation id, never leak internals.
    const traceId = randomUUID();
    request.log.error({ err: error, traceId, url: request.url }, 'Unhandled error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Please try again.',
        details: { traceId },
      },
    });
  });

  // ── Swagger / OpenAPI (dev only, audit M-12) ───────────────────────
  // Registered BEFORE the route plugins so it captures their Zod schemas, and
  // deliberately BEFORE helmet: Fastify hooks only attach to routes registered
  // after them, so mounting /docs ahead of helmet keeps its CSP off the Swagger
  // UI assets (which use inline styles/scripts) without loosening helmet for
  // the rest of the app. No-op in production — /docs must never be exposed.
  await registerSwagger(app, { nodeEnv: env.NODE_ENV, port: env.PORT });
  if (env.NODE_ENV !== 'production') {
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

  /**
   * Identify the caller BEFORE the rate limiter keys the request (ADR-024).
   *
   * ⚠️ THE ORDERING TRAP. `verifyJwt` is a route-level `preHandler` — routes opt
   * in individually — and Fastify runs GLOBAL preHandler hooks before route-level
   * ones. So a limiter registered at `hook: 'preHandler'` still sees
   * `request.user === undefined` and its key silently degrades to the IP. The
   * config would read as fixed while nothing changed, which is exactly the class
   * of failure audit A3 exists to catch.
   *
   * This hook is global and registered BEFORE the limiter, so it runs first.
   * `verifySupabaseToken` is Redis-cached, so on the hot path this is a cache
   * read, not a second verification.
   *
   * Failures are deliberately silent: this hook only decides a rate-limit BUCKET.
   * The route's own `verifyJwt` remains the authoritative gate and produces the
   * real 401 — an unauthenticated caller simply falls through to the IP key.
   */
  app.addHook('preHandler', async (request) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    try {
      request.user = await verifySupabaseToken(header.slice('Bearer '.length).trim());
    } catch {
      // Not our decision to make here — verifyJwt will reject it properly.
    }
  });

  /**
   * Per-USER cap per 07-API-CONTRACT.md §2 (150 req/min), keyed per ADR-024.
   *
   * Was `@fastify/rate-limit`'s default IP key, which behind a proxy meant one
   * bucket for the whole organisation (audit A1). AUTH-MATRIX §3 already solved
   * this shape for `/auth/login` with an `email + IP` key and explained why —
   * "prevents a shared office IP from blocking all staff at 9am". This
   * generalises that design rather than inventing one.
   *
   * Per-route buckets (login by email, invite by staffId, …) are attached on
   * their own routes via `config.rateLimit` and are untouched. addHeaders keeps
   * M-06 satisfied: every response advertises the remaining budget, and 429s
   * carry Retry-After.
   */
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    hook: 'preHandler', // after the identify hook above, never the default onRequest
    // `ip:` namespaces the fallback so an address can never collide with a staff id.
    keyGenerator: (request) => request.user?.id ?? `ip:${request.ip}`,
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

  // ── Cross-module EventBus listeners (Trigger 1: shoot:* → coming_shoot_date) ──
  // Registered once here (module-guarded) now that the shared db exists — this is
  // the single startup path both server.ts and inject-tests flow through.
  registerEventListeners(db);

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
  await app.register(botRoutes, { prefix: '/v1' });
  await app.register(searchRoutes, { prefix: '/v1' });
  await app.register(staffRoutes, { prefix: '/v1' });
  await app.register(clientsRoutes, { prefix: '/v1' });
  await app.register(monthsRoutes, { prefix: '/v1' });
  await app.register(attendanceRoutes, { prefix: '/v1' });
  await app.register(holidaysRoutes, { prefix: '/v1' });
  await app.register(tasksRoutes, { prefix: '/v1' });
  await app.register(shootPlannerRoutes, { prefix: '/v1' });
  await app.register(contentDropperRoutes, { prefix: '/v1' });
  await app.register(contentCalendarRoutes, { prefix: '/v1' });
  await app.register(settingsRoutes, { prefix: '/v1' });
  await app.register(auditLogRoutes, { prefix: '/v1' });
  await app.register(reportsRoutes, { prefix: '/v1' });
  await app.register(notificationsRoutes, { prefix: '/v1' });
  await app.register(chatRoutes, { prefix: '/v1' });
  await app.register(commentsRoutes, { prefix: '/v1' });
  // Cron-only (X-Internal-Secret, no JWT) — the three Sprint 12 jobs.
  await app.register(internalRoutes, { prefix: '/v1' });

  return app;
}
