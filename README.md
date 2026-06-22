# Skaly Business Portal

> Internal operations platform for Skaly Group — staff attendance, work
> allocation, shoot planning, content pipeline, AI bot, chat, notifications.
> Built on Next.js 15 + Fastify 5 + Postgres 16. MVP for 50 concurrent users.

## Stack

- **Frontend** — Next.js 15 (App Router), React 19, Tailwind 4 @theme, shadcn/ui,
  TanStack Query/Table/Virtual, Zustand 5, Framer Motion 11
- **Backend** — Fastify 5, Kysely, Socket.io v4 + @socket.io/redis-adapter,
  @anthropic-ai/sdk, Pino, Zod
- **Database & infra** — Postgres 16 (Railway), Upstash Redis (TLS),
  Cloudflare R2, Supabase Auth (JWT-only)
- **Deploys** — Vercel (web), Railway (api)
- **Models** — claude-sonnet-4-6 (production), claude-haiku-4-5-20251001 (dev)
- **Mobile (Phase 2)** — React Native + Expo

## Local Setup

Prerequisites: Node 20 LTS, pnpm 9, Docker Desktop, Git, openssl.

1. Clone and install:
   ```
   git clone git@github.com:<org>/skaly-portal.git
   cd skaly-portal
   pnpm install
   ```

2. Copy environment file:
   ```
   cp .env.example .env.local
   ```
   Fill values from your Supabase project, Upstash instance, Cloudflare R2,
   and Anthropic console. See docs/10-INFRA-DEPLOYMENT.md §2 for keys.

3. Start local Postgres + Redis:
   ```
   docker compose up -d
   ```

4. Apply migrations + seeds + materialised views:
   ```
   pnpm db:migrate
   NODE_ENV=development pnpm db:seed
   pnpm db:refresh-views
   ```

5. Run dev servers (two terminals):
   ```
   pnpm --filter @skaly/api dev   # api on :3001
   pnpm --filter @skaly/web dev   # web on :3000
   ```

6. Open http://localhost:3000.

## Common Commands

| Task | Command |
|---|---|
| Install dependencies | `pnpm install` |
| Run both apps in dev | `pnpm dev` |
| Run one app | `pnpm --filter @skaly/api dev` or `pnpm --filter @skaly/web dev` |
| Typecheck monorepo | `pnpm typecheck` |
| Lint monorepo | `pnpm lint` (or `pnpm lint --fix`) |
| Test monorepo | `pnpm test` |
| Apply migrations | `pnpm db:migrate` |
| Rollback last migration | `pnpm db:rollback` |
| Migration status | `pnpm db:status` |
| Run seeds | `NODE_ENV=development pnpm db:seed` |
| Refresh materialised views | `pnpm db:refresh-views` |
| Regenerate Kysely types | `pnpm --filter @skaly/api db:codegen` |
| Start local Docker services | `docker compose up -d` |
| Stop + wipe local volumes | `docker compose down -v` |
| psql into local Postgres | `docker exec -it $(docker compose ps -q postgres) psql -U skaly -d skaly_dev` |

## Specification

All product, technical, and operational specs live in `docs/`:

- **Master Build Guide** — `docs/MASTER-BUILD-GUIDE-V2-FINAL.md` (the day-to-day reference)
- **Specs (13 docs)** — 01-PRD through 13-NFRS
- **Audit & patches** — 14-PRE-BUILD-AUDIT.md, CRITICAL-PATCHES.md, FIX-GUIDE-V2-COMPLETE.md
- **Readiness checklist** — SPRINT-0-READINESS-CHECKLIST.md

When in doubt about a feature behaviour: the spec is the source of truth.
When in doubt about a file path or sprint sequence: the master build guide is.

## Sprint Progress

- [x] **Sprint 0** (Week 1) — Foundation: monorepo, infra, migrations 001-027,
      security plugins (B-01, B-03, C-05), bot stream handler reference (H-04),
      Sentry/CSP/pool-monitoring skeletons (H-07/H-08/H-09), email templates
      (B-02), CI/CD, staging deploys.
- [ ] **Sprint 1** (Week 2) — Auth + signup (Supabase JWT plugin, all auth
      endpoints, MFA, password reset, frontend pages).
- [ ] **Sprint 2** (Week 3) — DB types + base service + AuditService (calls
      audit_log_insert via SECURITY DEFINER per B-01) + Socket.io scaffold.
- [ ] **Sprint 3-13** — see master build guide PART 9.
