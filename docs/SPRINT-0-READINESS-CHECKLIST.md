# SPRINT-0-READINESS-CHECKLIST.md
## Skaly Business Portal — Sprint 0 Close-Out Gate
**Companion to:** `14-PRE-BUILD-AUDIT.md`, `CRITICAL-PATCHES.md`
**Use:** Tick each item as it lands. Do not start Sprint 1 with any unticked blocker or critical.

---

## 🔴 BLOCKER ITEMS (3) — Sprint 1 cannot begin without these

```
[x]  B-01  audit_log writes locked down via SECURITY DEFINER function
            └─  Migration 026 revokes UPDATE/DELETE; migration 027 revokes INSERT
                and exposes audit_log_insert() as the sole write path
            └─  Verified 2026-06-22: direct INSERT/UPDATE/DELETE from skaly_app
                returns "permission denied for table audit_log"; function call succeeds
            └─  Owner: TL

[x]  B-02  Templates: T1 (invite), T2 (signup-pending), T3 (signup-approved),
            T4 (signup-rejected) committed to apps/api/src/templates/email/.
            └─  Sprint 1 will wire these into AuthService via the email transport layer
            └─  T4 renders publicMessage only — never rejection_note (APPFLOW §2.6)
            └─  Owner: TL + Design Lead

[ ]  B-03  internalAuthPlugin uses crypto.timingSafeEqual
            └─  File apps/api/src/middleware/internal-auth.ts created (per CRITICAL-PATCHES B-03)
            └─  Verification test passes: wrong-length secret returns 401
            └─  Verification test passes: correct secret passes through
            └─  CRON_SECRET env var set on Railway (>=32 chars)
            └─  Owner: TL
```

---

## 🟠 CRITICAL ITEMS (6) — Sprint 0 cannot close without these

```
[ ]  C-01  PRD §5 bot latency row updated
            └─  Row reads: "TTFT < 2s; full streaming completion < 8s (see NFR §1.2)"
            └─  Owner: TL

[ ]  C-02  API-CONTRACT §1.1.1 PATCH response convention added
            └─  All PATCH endpoints return full resource + meta
            └─  Documented in §1.1.1 (per CRITICAL-PATCHES C-02)
            └─  Owner: TL

[ ]  C-03  PRD §6 OoS row for transactional email added
            └─  APPFLOW §2.6 signup approval notification clarification added
            └─  Stakeholder confirmation: in-app + Supabase email only is acceptable
            └─  Owner: TL + Arslaan

[ ]  C-04  GET /v1/staff/me endpoint added to API contract
            └─  API-CONTRACT §4 entry added
            └─  Backend route handler created (per CRITICAL-PATCHES C-04)
            └─  Frontend hook useCurrentUser() created
            └─  Owner: TL + D1

[ ]  C-05  WebSocket auth refresh protocol specified and built
            └─  TRD §8 section appended (per CRITICAL-PATCHES C-05)
            └─  apps/api/src/socket/auth-refresh.ts created
            └─  apps/web/lib/socket.ts handles auth:refresh_required
            └─  Integration test: socket survives JWT refresh mid-session
            └─  Owner: TL + D2

[ ]  C-06  Rollover bootstrap edge case spec'd and tested
            └─  RolloverService handles missing prior period without error
            └─  Test added: first-ever rollover succeeds with empty months table
            └─  Test added: second rollover correctly locks the first month
            └─  Owner: TL
```

---

## 🟢 STANDARD SPRINT 0 DOD (per IMPL-PLAN §3.5)

```
[ ]  Railway PostgreSQL 16 provisioned (staging + production)
[ ]  Railway cron service configured (31 18 * * * UTC)
[ ]  Vercel project connected to GitHub
[ ]  Upstash Redis instances (staging + production)
[ ]  Cloudflare R2 buckets (staging + production) with private access
[ ]  Supabase project: Auth (email/password + Google OAuth + TOTP)
[ ]  GitHub repository with branch protection on main
[ ]  GitHub Actions CI workflow passes on test PR
[ ]  Vercel preview URLs on every PR
[ ]  Docker Compose working on all 4 dev machines

[ ]  pnpm workspace configured (apps/web, apps/api, apps/mobile skel, packages/shared, packages/config)
[ ]  TypeScript 5 across all packages
[ ]  Shared ESLint config in packages/config
[ ]  packages/shared with initial Zod schemas + TypeScript types

[ ]  Next.js 15 app with App Router and TypeScript
[ ]  Tailwind CSS 4 with @theme directive in globals.css
[ ]  Three fonts loaded via next/font/google (Big Shoulders Display, DM Sans, DM Mono)
[ ]  All CSS variables from UI/UX §2.1 in globals.css
[ ]  shadcn/ui installed and Tailwind 4 compatible
[ ]  Framer Motion 11 installed
[ ]  useColumnHighlight hook with passing Vitest unit tests
[ ]  Gold column overlay component built for virtual-scrolled grids
[ ]  Gold column highlight demo verified working

[ ]  Fastify 5 app with all route plugin stubs
[ ]  Kysely configured (pool min: 2, max: 20)
[ ]  All 20+ table migrations + 026_database_roles run on Docker local
[ ]  All migrations run on Railway staging
[ ]  System actor seed (00000000-0000-0000-0000-000000000000) created
[ ]  @fastify/helmet, @fastify/cors, @fastify/rate-limit configured
[ ]  GET /v1/health endpoint with DB + Redis status
[ ]  Pino logger configured (Railway log stream format)
[ ]  Upstash Redis connected and ping-tested
[ ]  @socket.io/redis-adapter installed and configured
[ ]  T1–T4 template files received OR fallback path active (per B-02)
[ ]  Skaly lion logo SVG received OR placeholder confirmed
```

---

## 📦 AUDIT-ADDED SPRINT 0 ITEMS

```
[ ]  M-02  Sub-768px fallback page implemented
            └─  Renders branded "Use desktop browser" message at narrow viewports

[ ]  M-10  Dev seed data file created
            └─  database/seeds/002_dev_data.ts inserts 5 staff + 8 clients + 2 holidays
            └─  Runs only when NODE_ENV !== 'production'

[ ]  M-11  README.md at repo root
            └─  Project overview
            └─  Local dev setup commands
            └─  Links to all 14 spec documents

[ ]  L-09  GitHub Dependabot enabled
            └─  Security alerts on
            └─  Weekly dep updates on

[ ]  H-04  Bot streaming reference implementation drafted
            └─  apps/api/src/bot/stream-handler.ts created
            └─  Reviewed by TL before Sprint 8

[ ]  H-03  Refresh views CLI script created
            └─  apps/api/scripts/refresh-views.ts
            └─  Listed in apps/api/package.json scripts
            └─  Documented in README
```

---

## 🔧 FIXES APPLIED (Sprint 0 close-out)

- **027_audit_log_security_definer** — applied 2026-06-22; closes B-01.
- **Migration 002 `months_period_format` CHECK** — replaced `'^\d{4}-\d{2}$'`
  regex with `'^[0-9]{4}-[0-9]{2}$'` character-class form (JS template literal
  was eating the backslash escape, breaking the constraint at the DB layer).

---

## 🏗️ STRUCTURE / LAYOUT

- Project structure aligned to V2 master guide spec on 2026-06-22:
  - `apps/web` wrapped in `src/`
  - `apps/api` split into `app.ts` (buildApp) + `server.ts` (entrypoint)
  - `apps/api/src/lib/bot/stream-handler.ts` (kebab-case)
  - `db.types.ts` moved to `packages/shared/src/`
  - tests moved to `apps/api/test/`
  - **vercel.json kept at `apps/web/`** (Vercel Root Directory contract — the
    repo-root move from the original B-5 plan was reversed)

---

## 🎯 DECISION CLOSURE — END OF SPRINT 0

```
[ ]  OD-06  Comment notification recipients per module decided and documented
            └─  Per CRITICAL-PATCHES H-05 (broadcast to admins + managers + assigned freelancer)

[ ]  OD-07  Transactional email policy explicit
            └─  Per CRITICAL-PATCHES C-03 (in-app + Supabase Auth flows only)

[ ]  B-02   T1–T4 path locked in (templates or fallback)

[ ]  OD-05  Per-client shoot slot counts (decision can defer to Sprint 4 close)
            └─  Placeholder = 4 acceptable until Sprint 4 end
```

---

## ✅ GATE: SPRINT 1 BEGINS

When EVERY box above is ticked:

1. TL announces Sprint 0 close at end of Week 1
2. Sprint 1 kicks off Monday Week 2 with TL + D1
3. All 4 developers have read this audit + V2.1 specs they own
4. Risk register updated with V2.2 additions (per audit §13)

---

## 🚨 ESCALATION

If any blocker is at risk of slipping past end-of-Week-1:

- B-01: Cannot ship without — extend Sprint 0 by 1 day
- B-02: If templates not delivered by Day 5, default to fallback path. Do not wait.
- B-03: 30-minute task, no excuse for slipping.

Mid-Sprint 0 daily standup must explicitly cover blocker + critical status.

---

**END OF CHECKLIST**
