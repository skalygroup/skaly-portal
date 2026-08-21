import { env } from '../lib/env.js';

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

/* ── Auth (Supabase JWKS) reachability ──────────────────────────────────
 *
 * Reported, never enforced. Two constraints shape this, and they pull apart:
 *
 * 1. It MUST be visible. The Supabase project behind SUPABASE_JWKS_URL stopped
 *    resolving and every sign-in and every token verification failed, while
 *    this endpoint reported `status: "ok"` — it only watched Postgres and
 *    Redis. Nothing in the stack said the portal could not authenticate anyone.
 *
 * 2. It MUST NOT gate `status` or the HTTP code. INFRA §4 points Railway's
 *    `healthcheckPath` here with `restartPolicyType = "ON_FAILURE"`, so a 503
 *    would restart the container — on a loop, for as long as the third party
 *    was down. That converts "users cannot log in" into "users cannot log in
 *    AND the API keeps dying", killing in-flight requests and report renders
 *    for an outage the API has no part in and cannot fix by restarting.
 *
 * So auth is a DIAGNOSTIC field: monitoring and operators can alert on
 * `services.auth.ok === false` while the orchestrator keeps its hands off.
 *
 * The probe also runs OFF the request path. It is an external network call, and
 * this endpoint is the container healthcheck — the one place a slow third party
 * must never add latency. Requests serve the last cached result and, at most
 * once per TTL, kick off a refresh nobody waits on.
 */
const AUTH_PROBE_TTL_MS = 30_000;

/** null until the first probe resolves — "not checked yet", not "down". */
let authOk: boolean | null = null;
let authCheckedAt = 0;
let authProbeInFlight = false;

const AUTH_DOWN_MSG =
  'health: auth (Supabase JWKS) unreachable — sign-in and token verification are down. ' +
  'Not failing the healthcheck: restarting the API cannot fix a third-party outage.';

/** Runs the probe and updates the cache. Exported so tests can await it. */
export async function probeAuth(log?: FastifyInstance['log']): Promise<boolean> {
  let ok = false;
  try {
    // A non-2xx counts as down too: a deleted project fails DNS, but a paused
    // or misconfigured one answers with an error status, and either way nobody
    // can sign in.
    const res = await withTimeout(fetch(env.SUPABASE_JWKS_URL), 'auth');
    ok = res.ok;
    if (!ok) {
      log?.error({ status: res.status, jwksUrl: env.SUPABASE_JWKS_URL }, AUTH_DOWN_MSG);
    }
  } catch (err) {
    log?.error({ err, jwksUrl: env.SUPABASE_JWKS_URL }, AUTH_DOWN_MSG);
  }
  authOk = ok;
  authCheckedAt = Date.now();
  return ok;
}

/** Fire-and-forget, TTL-gated. Never awaited by a request. */
function refreshAuthIfStale(log: FastifyInstance['log']): void {
  if (authProbeInFlight || Date.now() - authCheckedAt < AUTH_PROBE_TTL_MS) return;
  authProbeInFlight = true;
  void probeAuth(log).finally(() => {
    authProbeInFlight = false;
  });
}

/** Test seam: drop cached probe state so cases don't leak into each other. */
export function __resetAuthProbe(): void {
  authOk = null;
  authCheckedAt = 0;
  authProbeInFlight = false;
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
 *       redis:    { ok: boolean },
 *       auth:     { ok: boolean | null }   // null = not probed yet; see above
 *     }
 *   }
 *
 * HTTP 200 when database and redis are ok, HTTP 503 when either is down.
 * `services.auth` is reported but deliberately does NOT affect either.
 */
export async function healthRoutes(app: FastifyInstance) {
  app.get('/v1/health', async (_request, reply) => {
    refreshAuthIfStale(app.log); // not awaited — see the note above

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
        auth: { ok: authOk },
      },
    });
  });
}
