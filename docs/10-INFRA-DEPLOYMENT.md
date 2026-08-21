# 10 — INFRASTRUCTURE & DEPLOYMENT SPECIFICATION
## Skaly Business Portal
**Version:** 2.1 | **Date:** June 2026 | **Status:** Final — Locked
**Cross-refs:** TRD §2.4, IMPL-PLAN §3, THIRD-PARTY §1-7

---

## 1. INFRASTRUCTURE OVERVIEW

```
PRODUCTION

  Vercel (Frontend CDN)              Railway (Backend + DB)
  ├─ Next.js 15 App                  ├─ Fastify 5 API (api.skaly.in)
  ├─ Global edge CDN                 ├─ PostgreSQL 16 (Railway managed)
  ├─ Automatic HTTPS                 ├─ Cron service (rollover 00:01 IST)
  └─ PR preview URLs                 └─ Structured logs (Pino → Railway)

  Upstash                            Cloudflare
  └─ Redis (serverless)              ├─ R2 (object storage — private)
     · Bot sessions (12hr TTL)       │  · Task attachments, CVs, PDFs
     · Presence (60s TTL)            │  · DB backups
     · Permission cache (5min TTL)   └─ (No public R2 access)

  Supabase (auth-only — no DB used)
  └─ JWT issuance, Google OAuth, TOTP

PHASE 2 ADDITIONS
  Expo EAS Build                     App Store + Play Store
  └─ Cloud build service             └─ Distribution
```

**No desktop app. No Electron. No Tauri. The web browser serves desktop users.**

---

## 2. ENVIRONMENTS

| Environment | Frontend | API | Database | Redis |
|-------------|----------|-----|----------|-------|
| Local dev | localhost:3000 | localhost:3001 | Docker (port 5432) | Docker (port 6379) |
| Staging | staging.skaly.in | api-staging.skaly.in | Railway staging | Upstash staging |
| Production | portal.skaly.in | api.skaly.in | Railway production | Upstash production |

### Local Dev — Docker Compose
```yaml
version: '3.9'
services:
  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_DB: skaly_dev, POSTGRES_USER: skaly, POSTGRES_PASSWORD: localdev }
    ports: ["5432:5432"]
    volumes: ["postgres_data:/var/lib/postgresql/data"]
    healthcheck: { test: ["CMD", "pg_isready", "-U", "skaly"], interval: 5s, retries: 5 }
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
volumes:
  postgres_data:
```

---

## 3. CI/CD PIPELINE

### On Every Pull Request
```yaml
# .github/workflows/ci.yml
name: CI
on: { pull_request: { branches: [main] } }
jobs:
  check:
    runs-on: ubuntu-latest
    services:
      postgres: { image: postgres:16-alpine, env: { POSTGRES_USER: test, POSTGRES_DB: test, POSTGRES_PASSWORD: test }, ports: ["5432:5432"] }
      redis:    { image: redis:7-alpine, ports: ["6379:6379"] }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r exec tsc --noEmit
      - run: pnpm -r exec eslint .
      - run: pnpm --filter api migrate:test
        env: { DATABASE_URL: postgresql://test:test@localhost:5432/test }
      - run: pnpm -r exec vitest run --coverage
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/test
          REDIS_URL: redis://localhost:6379
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY_TEST }}
```

**All CI checks must pass before any PR can be merged to `main`.**

### On Merge to Main → Staging Deploy
```
1. CI checks re-run
2. Railway: deploy API to staging service
3. Railway: run Kysely migrations on staging DB
4. Vercel: deploy frontend to staging preview
5. GitHub Actions: run Playwright E2E tests against staging
6. On E2E pass: staging deployment confirmed
```

### On Release Tag (e.g., v1.0.0) → Production Deploy
```
1. Railway: deploy API to production service
2. Railway: run Kysely migrations on production DB
3. Vercel: promote staging build to production
4. Health check: curl https://api.skaly.in/v1/health → verify { "status": "ok" }
5. Smoke test: login, attendance load, bot query
6. Notify team: portal.skaly.in is live
```

---

## 4. RAILWAY CONFIGURATION

```toml
# railway.toml (in apps/api/)
[build]
builder = "NIXPACKS"
buildCommand = "pnpm install --frozen-lockfile && pnpm --filter api build"

[deploy]
startCommand = "node dist/server.js"
healthcheckPath = "/v1/health"
healthcheckTimeout = 30
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

**Cron service** (separate Railway service — fires the `/v1/internal/*` endpoints; every one is gated by `X-Internal-Secret` and has no JWT path at all):
```
Schedule: 31 18 * * *   (00:01 IST = 18:31 UTC)   — rollover (Sprint 13)
Command: curl -X POST https://api.skaly.in/v1/internal/rollover
         -H "X-Internal-Secret: ${CRON_SECRET}"

Schedule: 30 22 * * *   (04:00 IST = 22:30 UTC)   — attachment orphan sweep (ADR-033)
Command: curl -X POST https://api.skaly.in/v1/internal/attachment-sweep
         -H "X-Internal-Secret: ${CRON_SECRET}"

Schedule: 30 21 1 * *   (03:00 IST on the 1st = 21:30 UTC on the last day) — message retention (ADR-030)
Command: curl -X POST https://api.skaly.in/v1/internal/message-retention
         -H "X-Internal-Secret: ${CRON_SECRET}"
```

The three are deliberately hours apart and all clear of the 00:01 rollover window.
Retention runs monthly and is the heaviest of them, so it sits at 03:00 — after
the 02:00 backup has finished, and long before anyone is in the chat it deletes
from.

`coming_shoot_date` recompute has **no schedule of its own**: it runs inside the
rollover transaction (ADR-034). `POST /v1/internal/recompute-shoot-dates` exists
as the manual re-run handle and for Sprint 13 to call in-process.

---

## 5. DATABASE MIGRATIONS

**Tool:** Kysely migration runner
**Location:** `database/migrations/YYYYMMDDHHII_description.ts`

```bash
# Commands (run from repo root)
pnpm --filter api db:migrate      # Apply all pending migrations
pnpm --filter api db:status       # List applied/pending migrations
pnpm --filter api db:rollback     # Rollback last migration
```

**Migration discipline:**
- Never modify a migration file after it has run on staging or production
- Write a corresponding rollback migration for every forward migration
- Test on local Docker PostgreSQL → staging → production (never skip staging)

### 5.1 One-off deploy steps

Not database migrations — Redis-side cleanups that accompany a specific release.

**Sprint 10 · retire the old presence keys (ADR-023).** Presence moved from one
`presence:{staffId}` string key per staff member to a single `presence` hash. The old
keys carry a 60s TTL and expire on their own, so this is tidiness rather than
correctness — run it once, after the release is live:

```bash
redis-cli --scan --pattern 'presence:*' | xargs -r redis-cli DEL
```

`--scan`, never `KEYS`. ADR-023 forbids wildcard commands on a **request path**; a
one-shot deploy script is not one. Verify afterwards:

```bash
redis-cli TYPE presence          # hash
redis-cli KEYS 'presence:*'      # empty
```

---

## 6. ENVIRONMENT VARIABLES

### Backend — Railway
```bash
# Core
NODE_ENV=production
PORT=3001
TZ=Asia/Kolkata   # critical for rollover timing (00:01 IST)

# Database
DATABASE_URL=postgresql://user:password@railway.internal:5432/skaly_prod
DATABASE_POOL_MIN=2
DATABASE_POOL_MAX=20

# Auth
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_JWT_SECRET=your-jwt-secret
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# AI (model strings locked)
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL_PROD=claude-sonnet-4-6
ANTHROPIC_MODEL_DEV=claude-haiku-4-5-20251001

# Storage
R2_ENDPOINT=https://xxxx.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=xxxx
R2_SECRET_ACCESS_KEY=xxxx
R2_BUCKET_NAME=skaly-portal-prod

# Cache
REDIS_URL=rediss://default:password@upstash.io:6379

# Internal
CRON_SECRET=long-random-string-minimum-32-chars

# Observability — OPTIONAL (audit H-07, added Sprint 13)
# Unset = Sentry is completely disabled: no init, no network, no behavioural
# change. §8's Railway alerts remain the PRIMARY monitor; Sentry is opt-in
# diagnostics for the incident a p95 alert tells you about but not where.
# When set, every unhandled 500 is captured tagged with the same traceId the
# user was shown (Error-Handling §4), which is the only join between the two.
SENTRY_DSN=

# Phase 2 — Mobile Push (add when mobile is deployed)
EXPO_PROJECT_ID=
FCM_SERVER_KEY=
APNS_KEY_ID=
APNS_TEAM_ID=
APNS_BUNDLE_ID=in.skaly.portal
```

### Frontend — Vercel
```bash
NEXT_PUBLIC_API_URL=https://api.skaly.in/v1
NEXT_PUBLIC_WS_URL=wss://api.skaly.in
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

# Observability — OPTIONAL (audit H-07, added Sprint 13). Same contract as the
# API's SENTRY_DSN: unset = entirely disabled. Wired with @sentry/react and a
# manual init, deliberately NOT @sentry/nextjs — that SDK's build-time plugin
# rewrites the Vercel build, and the build must not change at launch.
NEXT_PUBLIC_SENTRY_DSN=
```
**Only `NEXT_PUBLIC_` variables are exposed to the browser. No API keys or secrets ever use `NEXT_PUBLIC_` prefix.** A Sentry DSN is a public, write-only ingest key by design — it is not a secret, which is why the browser one carries the prefix.

---

## 7. BACKUP STRATEGY

| Backup | Frequency | Retention | Location |
|--------|-----------|-----------|----------|
| PostgreSQL full dump | Daily 02:00 IST | 30 days | R2 `backups/{date}/` |
| R2 object versioning | Every write | 90 days | Cloudflare R2 native versioning |
| Railway point-in-time recovery | Continuous | 7 days | Railway managed |

**Automated backup (Railway cron, 20:30 UTC = 02:00 IST):**
```bash
pg_dump $DATABASE_URL | gzip | aws s3 cp -   s3://$R2_BUCKET_NAME/backups/$(date +%Y-%m-%d)/db-$(date +%H%M%S).sql.gz   --endpoint-url $R2_ENDPOINT
```

**Monthly restore drill:** Spin up temp PostgreSQL → restore latest R2 backup → verify row counts → destroy temp instance.

---

## 8. MONITORING & ALERTING

| Signal | Threshold | Alert |
|--------|-----------|-------|
| API error rate | > 1% per 5 minutes | WhatsApp/Slack (ops team) |
| API p95 response time | > 2 seconds | WhatsApp/Slack |
| DB connection pool usage | > 80% of max 20 | WhatsApp/Slack |
| Rollover job | Transaction failure | Admin in-app `rollover_failed` notification |
| Materialised view refresh | Failure after 3 retries | Admin in-app `rollover_view_refresh_failed` notification (dashboard data stale) |
| Redis unavailable | On startup or connection drop | Railway alert + API logs |
| R2 backup missing | After 26 hours without new backup | WhatsApp/Slack |

**Health check endpoint:**
```typescript
app.get('/v1/health', async (_, reply) => {
  const [db, redis] = await Promise.allSettled([
    db.selectFrom('months').select('period').limit(1).execute(),
    redisClient.ping()
  ]);
  const ok = db.status === 'fulfilled' && redis.status === 'fulfilled';
  return reply.status(ok ? 200 : 503).send({
    status: ok ? 'ok' : 'degraded',
    services: {
      database: db.status === 'fulfilled' ? 'ok' : 'error',
      redis:    redis.status === 'fulfilled' ? 'ok' : 'error'
    },
    timestamp: new Date().toISOString()
  });
});
```

**`services.auth` — reported, never enforced.** The live endpoint also probes
`SUPABASE_JWKS_URL` and reports `auth: { ok }`. It exists because a dead Supabase
project took down every sign-in *and* every token verification while this check
still said `"ok"` — it only watched Postgres and Redis, so nothing in the stack
reported that the portal could not authenticate anyone.

It deliberately does **not** affect `status` or the HTTP code. `healthcheckPath`
points here with `restartPolicyType = "ON_FAILURE"` (§4), so a 503 would restart
the container on a loop for the length of a third-party outage — killing
in-flight requests and report renders to fix nothing. Alert on
`services.auth.ok === false`; let the orchestrator keep its hands off. The probe
also runs off the request path (30s TTL, fire-and-forget) so a slow auth host
cannot add latency to the healthcheck itself.

---

## 9. VERCEL CONFIGURATION

```json
{
  "framework": "nextjs",
  "buildCommand": "pnpm --filter web build",
  "outputDirectory": "apps/web/.next",
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
      ]
    }
  ]
}
```

---

## 10. SCALING NOTES (MVP → GROWTH)

| Component | MVP | Growth Path |
|-----------|-----|------------|
| API server | Single Railway instance | Add replicas + Redis adapter for Socket.io |
| PostgreSQL | Railway Hobby (shared) | Railway Pro → dedicated → RDS |
| Redis | Upstash serverless | Upstash Pro dedicated |
| Frontend | Vercel (unlimited CDN) | No change needed |
| WebSocket | @socket.io/redis-adapter already configured (Sprint 0) | Add API replicas on Railway Pro when needed |

**Critical note on WebSocket scaling:** The current architecture is single-instance. Adding a second API server requires adding the Socket.io Redis adapter (`@socket.io/redis-adapter`) to synchronize room broadcasts across instances. This must be the first change made before scaling the API server beyond one instance.
