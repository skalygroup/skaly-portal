# Skaly Business Portal

Internal operations platform for Skaly Group — attendance, tasks, shoot planning,
content pipeline, calendar, reporting, and an AI assistant. A pnpm monorepo with a
Next.js 15 web app and a Fastify 5 API, backed by PostgreSQL and Redis.

## Tech stack

| Layer    | Tech |
|----------|------|
| Web      | Next.js 15 (App Router), React 19, Tailwind CSS 4, shadcn/ui, TanStack Query/Table/Virtual, Zustand, Framer Motion |
| API      | Fastify 5, Kysely + node-postgres, Socket.io (+ Redis adapter), Zod, Pino |
| Data     | PostgreSQL 16, Redis 7 |
| Auth     | Supabase (JWT) |
| AI       | Anthropic Claude (deferred until Sprint 8) |
| Storage  | Cloudflare R2 (deferred until Sprint 1) |
| Tooling  | pnpm workspaces, TypeScript, Vitest, ESLint, Prettier |

## Prerequisites

- **Node.js 20.x** (see [`.nvmrc`](.nvmrc))
- **pnpm 9.x** — `corepack enable` or `npm i -g pnpm@9`
- **Docker Desktop** — for local Postgres + Redis

## Repository layout

```
apps/
  api/         Fastify 5 backend (REST + Socket.io)   @skaly/api
  web/         Next.js 15 frontend                    @skaly/web
packages/
  shared/      Shared Zod schemas & types             @skaly/shared
  config/      Shared tsconfig / eslint / prettier    @skaly/config
database/
  migrations/  Kysely migrations (001–026)            @skaly/database
  seeds/       Seed scripts (system actor + dev data)
docs/          Specs, build guide, audits
```

## Local setup

```bash
# 1. Install dependencies
pnpm install

# 2. Start Postgres + Redis (detached)
docker compose up -d

# 3. Create env files from templates
cp apps/api/.env.example       apps/api/.env
cp apps/web/.env.local.example apps/web/.env.local
#   DATABASE_URL and REDIS_URL already target local Docker.
#   Fill in Supabase / Anthropic / R2 values as you reach the sprints that need them.

# 4. Apply database migrations (all 26)
pnpm --filter @skaly/api db:migrate

# 5. (Optional) Seed dev data
pnpm --filter @skaly/api db:seed

# 6. Start the dev servers
pnpm --filter @skaly/api dev    # http://localhost:3001  (health: /v1/health · API docs: /docs)
pnpm --filter @skaly/web dev    # http://localhost:3000
```

Run everything in parallel from the repo root instead:

```bash
pnpm dev
```

## Environment variables

- **`apps/api/.env`** (see [`apps/api/.env.example`](apps/api/.env.example)):
  `DATABASE_URL`, `REDIS_URL`, `SUPABASE_URL`, `SUPABASE_JWT_SECRET`,
  `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_PROD/DEV`,
  `R2_ENDPOINT`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET_NAME`,
  `CRON_SECRET`, `LOG_LEVEL`.
- **`apps/web/.env.local`** (see [`apps/web/.env.local.example`](apps/web/.env.local.example)):
  `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

> `.env` and `.env.local` are gitignored — **never commit secrets.**

## Scripts

**Root** (run across all packages):

| Command          | Action |
|------------------|--------|
| `pnpm dev`       | Run all packages in dev (parallel) |
| `pnpm build`     | Build all packages |
| `pnpm test`      | Test all packages |
| `pnpm typecheck` | Type-check all packages |
| `pnpm lint`      | Lint all packages |

**API** — `pnpm --filter @skaly/api <script>`:

| Command            | Action |
|--------------------|--------|
| `dev`              | Start API with hot reload (tsx watch) |
| `build` / `start`  | Compile to `dist/` / run the compiled server |
| `test`             | Run Vitest |
| `db:migrate`       | Apply pending migrations |
| `db:rollback`      | Roll back the last migration |
| `db:status`        | Show applied/pending migrations |
| `db:seed`          | Run seeds (system actor + dev data) |
| `db:refresh-views` | Refresh dashboard materialized views |

**Web** — `pnpm --filter @skaly/web <script>`: `dev`, `build`, `start`, `lint`, `typecheck`, `test`.

## Database

Migrations live in [`database/migrations/`](database/migrations/) and run through Kysely.
Local connection string: `postgresql://skaly:localdev@localhost:5432/skaly_dev`.

`audit_log` is **append-only**: the `skaly_app` role is granted `INSERT` but has
`UPDATE`/`DELETE` revoked (migration `026_database_roles`).

## Documentation

See [`docs/`](docs/) — notably `MASTER-BUILD-GUIDE-V2-FINAL.md` (the build guide),
`02-TRD.md`, `05-BACKEND-SCHEMA.md`, `07-API-CONTRACT.md`, and `14-PRE-BUILD-AUDIT.md`.
