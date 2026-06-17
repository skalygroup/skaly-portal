# Scaly Portal

Internal operations platform for Skaly Group. Performance marketing, content production, attendance, and reporting in one place.

**Status:** in development. Targeting first production launch end of Sprint 13.

---

## Stack

**Frontend** — Next.js 15, TypeScript 5, Tailwind 4, shadcn/ui, TanStack Query/Table/Virtual, Zustand 5, Framer Motion 11

**Backend** — Fastify 5, Kysely (Postgres), Socket.io v4 with @socket.io/redis-adapter, @anthropic-ai/sdk, Pino

**Infra** — Postgres 16 on Railway · Upstash Redis · Cloudflare R2 · Supabase Auth · Vercel (web) · Railway (api)

**AI** — `claude-sonnet-4-6` in production, `claude-haiku-4-5-20251001` in dev/test

---

## Local development

### Prerequisites

- Node 20.18.0 (`.nvmrc` is in the repo — `nvm use` picks it up)
- pnpm 9.x (`npm install -g pnpm@9`)
- Docker Desktop running

### Setup

\`\`\`bash
pnpm install
cp apps/api/.env.example apps/api/.env       # then fill in real values
cp apps/web/.env.example apps/web/.env.local # then fill in real values
docker compose up -d                          # Postgres + Redis on :5432 and :6379
pnpm db:migrate                               # apply all migrations
pnpm db:seed                                  # dev seed data
pnpm db:refresh-views                         # materialized views
pnpm dev                                       # both apps in parallel
\`\`\`

- Web: http://localhost:3000
- API: http://localhost:3001 (health: `/v1/health`)
- Swagger (dev only): http://localhost:3001/docs

### Common commands

\`\`\`bash
pnpm typecheck       # all packages
pnpm lint            # all packages
pnpm test            # all packages
pnpm db:migrate      # apply pending migrations
pnpm db:rollback     # roll back the latest migration
pnpm db:status       # show applied + pending
pnpm db:refresh-views # refresh mv_dashboard_*
\`\`\`

---

## Repository structure

\`\`\`
apps/
  web/             Next.js 15 frontend
  api/             Fastify 5 backend
packages/
  shared/          Zod schemas, Kysely DB types, shared types
  config/          tsconfig, eslint, prettier shared configs
database/
  migrations/      Kysely migrations 001–026
  seeds/           Dev data + system actor seed
docs/              Specifications, audits, runbooks
.github/workflows/ ci.yml + deploy-api.yml
\`\`\`

---

## Specification documents

All in `docs/`:

| File | Purpose |
|---|---|
| `01-PRD.md` | Product requirements |
| `02-TRD.md` | Technical requirements, stack, infra |
| `03-UIUX.md` | UI/UX system, design tokens, components |
| `04-APPFLOW.md` | Every user flow, end-to-end |
| `05-BACKEND-SCHEMA.md` | Database schema (26 migrations) |
| `06-IMPLEMENTATION-PLAN.md` | 14-sprint plan |
| `07-API-CONTRACT.md` | REST + WebSocket contract |
| `08-AUTH-MATRIX.md` | RBAC model + permission matrix |
| `09-ERROR-HANDLING.md` | Error response format, codes |
| `10-INFRA-DEPLOYMENT.md` | Infra topology, docker compose |
| `11-THIRD-PARTY-INTEGRATIONS.md` | Anthropic, Supabase, R2, etc. |
| `12-TESTING-STRATEGY.md` | Unit, integration, E2E, k6 |
| `13-NFRS.md` | Non-functional requirements |
| `14-PRE-BUILD-AUDIT.md` | 39-finding pre-build audit |
| `CRITICAL-PATCHES.md` | Drop-in code patches for blockers + criticals |
| `FIX-GUIDE-V2-COMPLETE.md` | The 21 audit-driven fixes |
| `MASTER-BUILD-GUIDE-V2-FINAL.md` | From-zero-to-launch build guide |
| `AUDIT-OF-MASTER-BUILD-GUIDE.md` | Audit of the build guide |
| `SPRINT-0-READINESS-CHECKLIST.md` | Sprint 0 close-out |
| `POST-SPRINT-0-CLEANUP-RUNBOOK.md` | Credential rotation + env cleanup |

---

## Development rules

- **Soft delete only** for user-facing entities (`deleted_at` column). Never `DELETE FROM` directly. (Fix Guide V2 H-02.)
- **Audit log is immutable.** All writes go through `AuditService.log()`. Migration 026 revokes direct write permissions on `audit_log` from the application role.
- **Optimistic locking** via `version` column on every editable row. Use `BaseService.optimisticUpdate`. (Audit C-02.)
- **System Actor UUID** for automated writes to audit_log: `00000000-0000-0000-0000-000000000000`. Never NULL `staff_id`. (Audit C-04.)
- **Bot tokens stream via WebSocket only.** HTTP `POST /v1/bot/message` returns 202. (Audit C-01.)
- **Branch strategy:** main → production deploy. Feature branches → preview deploys.

---

## Sprint progress

- [x] Sprint 0 — Foundation, migrations, security plugins, CI/CD
- [ ] Sprint 1 — Auth + Signup
- [ ] Sprint 2 — Database schema + API scaffold
- [ ] Sprint 3 — Staff Attendance
- [ ] Sprint 4 — Tasks
- [ ] Sprint 5 — Shoot Planner
- [ ] Sprint 6 — Content Dropper + Trigger 1
- [ ] Sprint 7 — Content Calendar + Trigger 2
- [ ] Sprint 8 — AI Bot (query tools)
- [ ] Sprint 9 — AI Bot (mutations) + Search
- [ ] Sprint 10 — Chat + Notifications
- [ ] Sprint 11 — Dashboard + Settings
- [ ] Sprint 12 — Rollover + Reports + Comments
- [ ] Sprint 13 — QA + Performance + Launch

---

## License

Proprietary — internal Skaly Group software. All rights reserved.
`UPDATE`/`DELETE` revoked (migration `026_database_roles`).

## Documentation

See [`docs/`](docs/) — notably `MASTER-BUILD-GUIDE-V2-FINAL.md` (the build guide),
`02-TRD.md`, `05-BACKEND-SCHEMA.md`, `07-API-CONTRACT.md`, and `14-PRE-BUILD-AUDIT.md`.
