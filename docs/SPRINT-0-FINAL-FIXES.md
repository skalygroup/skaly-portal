# SPRINT 0 — FINAL FIXES BEFORE SPRINT 1 GO

**You went from STOP with 2 hard bugs to STOP with 1 decision and a README cleanup. That's the run.** This is the last mile.

## Where you stand

| Phase | Result | Action needed |
|---|---|---|
| 1 — Files | PASS | none |
| 2 — Static | PASS | (optional: `pnpm lint --fix` clears the 47 cosmetic warnings) |
| 3 — Tests | PASS | none |
| 4 — Local infra | PASS | none |
| 5 — B-01 lockdown | **PASS — the big one** | none |
| 6 — Boot + health | PARTIAL | resolve `/v1/health` contract (STEP D-3) + browser checks (STEP D-4) |
| 7 — Deploys | PARTIAL | manual dashboard checks (STEP D-5) |
| 8 — Audit | 11/16 PASS, 1 FAIL, 1 PARTIAL, 2 deferred | fix B-02 (STEP D-1), fix M-11 (STEP D-2) |

**Deferred-by-design (these are correct — leave them):**
- **C-06** RolloverService.bootstrapInitialMonth — built in Sprint 12, per V2 guide PART 9 / PART 7 STEP 6 instructions noted "code only, runs in Sprint 12"
- **H-07** Sentry.init — wired in Sprint 11 (the Sprint 0 skeleton was the dependency + a placeholder; full init lives later when Sentry project exists)

These showing as "deferred" in Phase 8 is the correct outcome. Do not try to "fix" them.

## Path to GO

- **STEP D-1** — B-02 templates: ship the email template set (the real blocker)
- **STEP D-2** — M-11 README: rewrite from the canonical 5-section structure (cleans up the duplicates)
- **STEP D-3** — `/v1/health` contract: align implementation and verification prompt to one canonical shape
- **STEP D-4** — Phase 6 browser checks: 90 seconds at localhost:3000
- **STEP D-5** — Phase 7 deploys: 5 minutes across Vercel + Railway + GitHub dashboards
- **STEP D-6** — Final commit + re-run verification + Sprint 1 starts

Total: ~45 minutes if you have the assets ready, ~90 minutes if you're polishing email copy as you go.

---

## STEP D-1 — Resolve B-02: ship email templates

**Goal:** four email templates (`T1` invite / `T2` signup-pending / `T3` signup-approved / `T4` signup-rejected) committed to `apps/api/src/templates/email/`, so Sprint 1's auth flows can render and send real emails. This closes B-02.

### What T1–T4 are (canonical)

Sprint 1 (V2 guide PART 9 → SPRINT 1) wires up auth + signup. Four user-facing emails get sent during those flows. Mapping each to its purpose:

| ID | Filename | Trigger | Recipient | Variables |
|---|---|---|---|---|
| T1 | `invite.html` | Admin invites a user via `POST /v1/auth/invite` | invitee | `name`, `inviteUrl`, `inviterName`, `expiresAt` |
| T2 | `signup-pending.html` | User submits self-signup with CV via `POST /v1/auth/signup/request` | applicant | `name`, `submittedAt` |
| T3 | `signup-approved.html` | Admin approves via `POST /v1/auth/signup-requests/:id/approve` | applicant | `name`, `loginUrl`, `temporaryPassword` |
| T4 | `signup-rejected.html` | Admin rejects via `POST /v1/auth/signup-requests/:id/reject` | applicant | `name`, `publicMessage` (NEVER `rejectionNote`) |

T4 is the one to be careful about. Per APPFLOW §2.6 and the audit, `rejection_note` is admin-only and must never appear in any user-facing surface, including the rejection email. The rejection email uses `public_message` (the polite version the admin types separately).

### Prompt (paste into Antigravity Claude)

```
WHERE WE ARE

Sprint 0 B-02 is the last real blocker before Sprint 1 GO. The audit flagged that
T1-T4 email templates referenced by docs/SPRINT-0-READINESS-CHECKLIST.md aren't
committed. Sprint 1 needs them wired into the auth/signup endpoints. Per
docs/04-APPFLOW.md §2.6 and the audit, the rejection email (T4) must use
public_message and NEVER include rejection_note.

WHAT TO BUILD

1. Create the directory apps/api/src/templates/email/

2. Create four HTML email files using Skaly brand styling. All four share a
   single inline-CSS layout (no external stylesheets — email clients strip them).
   Branding:
   - Background: off-white #FAFAF7
   - Primary: near-black #0D0D0D
   - Accent: gold #FDC257 (use for headline underline, button background, divider)
   - Font: system stack — "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
     sans-serif" — DO NOT reference Big Shoulders or DM Sans (most email clients
     can't load custom fonts; sticking to system stack is the standard)
   - Container: 600px max-width, centered, white card with 24px padding
   - Logo: text-only "SKALY" header in caps with gold underline (no image; image
     hosting is a Sprint 2 concern)

3. The four files, each with the Handlebars-style {{variable}} placeholders
   listed for that template. Use Handlebars syntax because we'll likely wire
   handlebars-helpers in Sprint 1 — keeps options open. Don't use {{{triple}}}
   syntax (raw HTML escape) anywhere; everything double-braced and HTML-escaped
   by default.

   apps/api/src/templates/email/invite.html        — T1, vars: name, inviteUrl, inviterName, expiresAt
   apps/api/src/templates/email/signup-pending.html — T2, vars: name, submittedAt
   apps/api/src/templates/email/signup-approved.html — T3, vars: name, loginUrl, temporaryPassword
   apps/api/src/templates/email/signup-rejected.html — T4, vars: name, publicMessage

   T4 MUST NOT contain the string "rejectionNote" or any variable mapped to it.
   Add an HTML comment at the top of T4: <!-- B-02 / APPFLOW §2.6: use publicMessage only; rejectionNote is admin-internal -->

4. Each template:
   - <!doctype html>, lang="en", basic <head> with charset + viewport meta
   - One <h1> headline (specific to that email's purpose), gold underline
   - 2-4 short paragraphs of plain English
   - A primary CTA button (where applicable): gold background, near-black text,
     border-radius 4px, padding 12px 24px, display inline-block, text-decoration none
   - A footer: small grey text with "Skaly Group · Hyderabad" and a "If you
     didn't expect this email, please ignore it." line

5. Content sketches (refine as you like — these are starting points):

   T1 invite.html:
     H1: "You've been invited to Skaly"
     Body: "Hi {{name}}, {{inviterName}} has invited you to join the Skaly Business
            Portal. The link below is valid until {{expiresAt}}."
     CTA: "Accept invitation" → {{inviteUrl}}

   T2 signup-pending.html:
     H1: "We received your application"
     Body: "Hi {{name}}, thank you for your interest in joining Skaly. Your
            application was received on {{submittedAt}}. Our team will review and
            get back to you within 3 working days."
     No CTA.

   T3 signup-approved.html:
     H1: "Welcome to Skaly"
     Body: "Hi {{name}}, your application has been approved. Use the temporary
            password below to log in for the first time — you'll be asked to set
            a new password immediately."
     Temporary password block: <pre style="font-family: monospace; background:
       #F0EFEA; padding: 12px; border-radius: 4px;">{{temporaryPassword}}</pre>
     CTA: "Log in to Skaly" → {{loginUrl}}

   T4 signup-rejected.html:
     H1: "About your application"
     Body: "Hi {{name}}, thank you for your interest in Skaly. After review, we
            won't be moving forward with your application at this time."
     Note block: "<p style='border-left: 3px solid #FDC257; padding-left: 12px;'>
       {{publicMessage}}</p>"
     Closing: "We appreciate the time you took to apply. You're welcome to apply
       again in the future."
     No CTA.

6. After creating the files, run:
     wc -l apps/api/src/templates/email/*.html
   Expected: each file 30-60 lines.

   And:
     grep -l "rejectionNote\|rejection_note" apps/api/src/templates/email/
   Expected: empty output (no file mentions rejection_note — proves T4 is clean).

7. Update docs/SPRINT-0-READINESS-CHECKLIST.md: tick the B-02 row, replace any
   "[ ]" or "pending" text with:
     "[x] B-02 — Templates: T1 (invite), T2 (signup-pending), T3 (signup-approved),
      T4 (signup-rejected) committed to apps/api/src/templates/email/. Sprint 1
      will wire these into AuthService via the email transport layer."

Show me the four files and the diff of SPRINT-0-READINESS-CHECKLIST.md.

RULES

- T4 must not contain rejection_note or rejectionNote anywhere. The grep in
  step 6 enforces this.
- Plain HTML + inline styles only. No <link>, no <style>, no @import.
- System font stack — no custom @font-face.
- Skaly gold is exactly #FDC257 (not #C8A96E from the personal-brand skill —
  that's Mohammed's individual palette; the company portal uses #FDC257).
- The "From" sender address is set in Supabase Auth or Postmark/Resend config
  in Sprint 1 — not in the template itself. Templates are HTML bodies only.
```

### Verify

```bash
ls -la apps/api/src/templates/email/
# Expected: invite.html, signup-pending.html, signup-approved.html, signup-rejected.html

grep -l "rejectionNote\|rejection_note" apps/api/src/templates/email/
# Expected: empty (no matches)

grep -c "{{" apps/api/src/templates/email/signup-rejected.html
# Expected: several (at least name + publicMessage variables)

grep "publicMessage" apps/api/src/templates/email/signup-rejected.html
# Expected: at least one match (the variable is referenced)
```

**If you have polished templates from your assets folder** — drop them into the same paths instead of letting Claude generate stubs, then run the same grep/verify checks. The contract (variables, no `rejection_note`, file paths) is what matters; visual design can be anything.

---

## STEP D-2 — Resolve M-11: rewrite README.md from canonical structure

**Goal:** one clean README with the 5 required sections, no duplicates, no missing "Common Commands" heading.

### Prompt

```
WHERE WE ARE

Sprint 0 verification flagged M-11 PARTIAL. The current README.md is missing the
"Common Commands" heading and has three sections appearing twice (Development
rules, Sprint progress, License). The verification prompt expected exactly five
top-level headings: Stack, Local Setup, Common Commands, Specification,
Sprint Progress.

WHAT TO DO

Rewrite README.md from the structure below. Do not preserve existing content
verbatim — clean rewrite. Drop everything that's duplicated.

Target structure:

# Skaly Business Portal

> Internal operations platform for Skaly Group — staff attendance, work
> allocation, shoot planning, content pipeline, AI bot, chat, notifications.
> Built on Next.js 15 + Fastify 5 + Postgres 16. MVP for 50 concurrent users.

## Stack

A brief table or bullet list:

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
- **Verification prompt** — SPRINT-0-VERIFICATION-PROMPT.md

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

---

After writing the file, run:

  grep -c "^## " README.md
  grep "^## " README.md

Expected: count is exactly 5 (no duplicates), the headings are Stack, Local Setup,
Common Commands, Specification, Sprint Progress in that order.

RULES

- Single top-level # heading at the file start. Everything else is ## or below.
- No duplicate headings anywhere.
- No "Development rules" or "License" sections (those weren't required by M-11).
- The Common Commands table is the centrepiece — make it complete.
```

### Verify

```bash
grep -c "^## " README.md
# Expected: exactly 5

grep "^## " README.md
# Expected (in order):
# ## Stack
# ## Local Setup
# ## Common Commands
# ## Specification
# ## Sprint Progress

# No accidental duplicates:
grep "^## " README.md | sort | uniq -d
# Expected: empty output
```

---

## STEP D-3 — Resolve `/v1/health` contract mismatch

**Decision:** the canonical shape includes BOTH the implementation's `services` grouping AND the verification prompt's `status` + `uptime`. Best of both. Then both code and verification prompt align to this single contract.

**Canonical shape:**

```json
{
  "status": "ok",
  "uptime": 1247,
  "timestamp": "2026-06-22T14:23:11.482Z",
  "services": {
    "database": {
      "ok": true,
      "pool": { "total": 10, "idle": 8, "waiting": 0 }
    },
    "redis": { "ok": true }
  }
}
```

When a service is unhealthy: `"ok": false` on that service AND top-level `"status": "degraded"`, HTTP code 503 (not 200). The endpoint always responds — never 500 — so monitoring can distinguish "service partially up" from "service crashed."

### Prompt

```
WHERE WE ARE

Sprint 0 Phase 6 verification flagged a shape mismatch between the implemented
/v1/health endpoint (services.{database,redis} + top-level pool + timestamp)
and the verification prompt's expected shape (status/db.ok/redis.ok/uptime).
We're settling the contract now so Sprint 1+ never has to revisit it.

CANONICAL CONTRACT

GET /v1/health
HTTP 200 when all services ok, HTTP 503 when any service is down.

Response body:
{
  "status": "ok" | "degraded",
  "uptime": <integer seconds since process start>,
  "timestamp": "<ISO-8601 string>",
  "services": {
    "database": {
      "ok": <boolean>,
      "pool": { "total": <n>, "idle": <n>, "waiting": <n> }
    },
    "redis": { "ok": <boolean> }
  }
}

WHAT TO DO

1. Update the /v1/health route handler in apps/api (likely in
   apps/api/src/routes/health.ts or wherever the route currently lives).
   The handler must:

   a) Record uptime: use a module-level constant
        const startTime = Date.now();
      and compute uptime as Math.floor((Date.now() - startTime) / 1000).

   b) Check Postgres: run a trivial query like
        await fastify.db.selectFrom('staff').select(sql<number>`1`.as('one')).limit(0).execute();
      In a try/catch. On success, ok=true. On error, ok=false and log the error.

   c) Capture pool stats from the pg Pool (which db.ts exports per H-09):
        const pool = fastify.pool;  // or however your db.ts exposes it
        const poolStats = {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        };

   d) Check Redis: await fastify.redis.ping() in try/catch.

   e) Compute overall status: 'ok' if both services ok, else 'degraded'.

   f) Compute HTTP code: 200 if 'ok', 503 if 'degraded'.

   g) Send response with the canonical shape above.

2. The handler should respond in under 100ms. If either dependency check is
   slow, add a 2-second timeout (Promise.race) and fall back to ok=false with
   a "timeout" error.

3. Add or update an integration test at apps/api/test/routes/health.test.ts
   (creating the routes/ subdirectory if needed):

   - Test: GET /v1/health returns 200 with shape matching the canonical schema
     when both services are healthy. Use a Zod schema or explicit field
     assertions.
   - Test: GET /v1/health returns 503 with status='degraded' when redis ping
     fails (mock fastify.redis.ping to throw).

4. Update docs/SPRINT-0-VERIFICATION-PROMPT.md Phase 6 to match the canonical
   shape. Find the block that currently lists expected keys:

     Expected JSON keys at minimum:
     - status: "ok"
     - db: { ok: true, pool: { total: <n>, idle: <n>, waiting: 0 } }
     - redis: { ok: true }
     - uptime: <number>

   Replace with:

     Expected JSON keys at minimum:
     - status: "ok"
     - uptime: <integer seconds>
     - timestamp: <ISO-8601 string>
     - services.database.ok: true
     - services.database.pool: { total: <n>, idle: <n>, waiting: 0 }
     - services.redis.ok: true

5. Show me the updated route handler, the new test file, and the diff of
   SPRINT-0-VERIFICATION-PROMPT.md.

RULES

- The endpoint is unauthenticated (per docs/07-API-CONTRACT.md health spec —
  monitoring services hit it).
- Do not add fields that aren't in the canonical contract above. Keep it lean.
- The timestamp must be ISO-8601 UTC (use new Date().toISOString()), not
  a number, not a localised string.
```

### Verify

```bash
# After Claude updates the code:
pnpm --filter @skaly/api dev &
sleep 6
curl -sS http://localhost:3001/v1/health | jq

# Expected JSON shape exactly:
# {
#   "status": "ok",
#   "uptime": <number>,
#   "timestamp": "<iso8601>",
#   "services": {
#     "database": { "ok": true, "pool": {...} },
#     "redis": { "ok": true }
#   }
# }

kill %1
```

---

## STEP D-4 — Phase 6 browser verification (manual, 90 seconds)

Run both apps locally:

```bash
pnpm dev   # both apps via root script
# OR if separate:
pnpm --filter @skaly/api dev &
pnpm --filter @skaly/web dev &
```

Wait ~10 seconds. Open `http://localhost:3000` in a browser.

**Check each:**

- [ ] Gold "Skaly Business Portal" headline visible
- [ ] Browser DevTools console (F12 → Console tab) — **zero red errors**. Warnings in yellow are fine.
- [ ] DevTools Network tab → filter to "Font" — three fonts load with 200 status:
  - `BigShouldersDisplay-*.woff2` (or similar)
  - `DMSans-*.woff2`
  - `DMMono-*.woff2`
- [ ] DevTools → Application → Cookies → no Supabase session cookie yet (we haven't built auth)
- [ ] DevTools → Application → Storage → no localStorage entries from Supabase yet

If any item fails, paste the error or finding back into Antigravity Claude with the prompt: *"Phase 6 verification failed on [item]. Here's the evidence: [paste]. Diagnose and fix."*

Stop dev servers when done:
```bash
kill %1 %2 2>/dev/null || true
```

---

## STEP D-5 — Phase 7 deploys verification (manual, 5 minutes)

Open these tabs in your browser:

1. **Vercel project dashboard** (`https://vercel.com/<your-team>/skaly-portal`)
   - [ ] Latest deployment on `main` branch is green
   - [ ] Production URL responds with the gold headline (open it)
   - [ ] Production URL response headers include `Content-Security-Policy-Report-Only` (or `Content-Security-Policy` if you've already flipped to enforce — but Sprint 0 should still be Report-Only)
   - [ ] Settings → Environment Variables: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` all set for Production scope

2. **Railway project dashboard** (`https://railway.app/project/<your-project-id>`)
   - [ ] API service shows "Running" status
   - [ ] Open `https://YOUR-API.up.railway.app/v1/health` — JSON response with `status: "ok"`
   - [ ] Variables tab: `DATABASE_URL`, `REDIS_URL`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_JWT_SECRET`, `SUPABASE_URL`, `INTERNAL_SECRET`, `TZ=Asia/Kolkata`, `CRON_SECRET` all set
   - [ ] Deployments tab: latest deploy is green

3. **GitHub Actions** (`https://github.com/<org>/skaly-portal/actions`)
   - [ ] Most recent `ci.yml` run on `main` is green ✅
   - [ ] Most recent `deploy-api.yml` run on `main` is green ✅

4. **GitHub Secrets** (`Settings → Secrets and variables → Actions`)
   - [ ] `DATABASE_URL_PROD` exists (don't click into it — just confirm presence)

5. **GitHub Dependabot** (`Settings → Code security and analysis`)
   - [ ] "Dependabot alerts" enabled (toggle ON)
   - [ ] "Dependabot security updates" enabled
   - [ ] Open alerts: zero (you mentioned in the report they were remediated to 0 — confirm)

If any checkbox fails, paste back into chat: *"Phase 7 failed on [item]. Here's what I see: [screenshot or description]."*

---

## STEP D-6 — Final commit + re-verify + Sprint 1 GO

### Commit Phase D

```bash
git add apps/api/src/templates/email/ \
        apps/api/src/routes/health* \
        apps/api/test/routes/health.test.ts \
        docs/SPRINT-0-READINESS-CHECKLIST.md \
        docs/SPRINT-0-VERIFICATION-PROMPT.md \
        README.md

git commit -m "Sprint 0 final: B-02 templates, M-11 README, canonical health contract

- B-02: T1-T4 email templates committed to apps/api/src/templates/email/
  (invite, signup-pending, signup-approved, signup-rejected). T4 uses
  publicMessage only — never rejection_note per APPFLOW §2.6.
- M-11: README rewritten with the 5 required sections (Stack, Local Setup,
  Common Commands, Specification, Sprint Progress). Duplicates removed.
- /v1/health: canonical contract { status, uptime, timestamp, services.* }.
  Implementation, integration test, and verification prompt all aligned.
- Readiness checklist: B-02 ticked.
- Verification prompt: Phase 6 expected-keys block updated.

Closes the last remaining Sprint 0 items from verification report
(2026-06-22). Sprint 1 (auth + signup) starts next."
```

Push:

```bash
git push origin main
```

Watch CI go green.

### Re-run verification one final time

Open a fresh Antigravity Claude chat. Paste the contents of `docs/SPRINT-0-VERIFICATION-PROMPT.md` (between the markers).

**Expected this run:**

| Phase | Verdict |
|---|---|
| 1 — Files | PASS |
| 2 — Static | PASS (47 warnings clearable with `pnpm lint --fix` — optional) |
| 3 — Tests | PASS — 5 test files (added health.test.ts), 17+ tests |
| 4 — Local infra | PASS |
| 5 — B-01 lockdown | PASS (strict — direct INSERT denied, function call succeeds) |
| 6 — Boot + health | PASS — canonical shape matches |
| 7 — Deploys | PASS — your manual confirmations |
| 8 — Audit | 14/16 PASS, 2 deferred-by-design (C-06 Sprint 12, H-07 Sprint 11), 0 FAIL, 0 PARTIAL |

**FINAL VERDICT: GO FOR SPRINT 1.**

### Start Sprint 1

Open `docs/MASTER-BUILD-GUIDE-V2-FINAL.md`. Navigate to PART 9 → SPRINT 1 — AUTH + SIGNUP.

Open Antigravity. Open the five Sprint 1 reading-list docs in split view:
- `docs/04-APPFLOW.md` §1, §2, §3
- `docs/07-API-CONTRACT.md` §1
- `docs/08-AUTH-MATRIX.md`
- `docs/06-IMPLEMENTATION-PLAN.md` §4
- `docs/FIX-GUIDE-V2-COMPLETE.md` §H-04, §M-02

Open a fresh Claude chat. Paste the **Sprint 1 driving prompt** from PART 9.

You're building.

---

## Optional polish (not required for Sprint 1 GO)

### Clear the 47 lint warnings

```bash
pnpm lint --fix
git diff
# Review the diff — should be only import reorderings
git add -A
git commit -m "chore: pnpm lint --fix import order across monorepo"
git push
```

### Move `vercel.json` to repo root (if you want the cleaner monorepo pattern)

Skipped in Phase B because the current `apps/web/vercel.json` is read correctly by Vercel when project Root Directory = `apps/web`. Both layouts are valid. If you want to align with the typical monorepo convention:

```bash
git mv apps/web/vercel.json vercel.json
# Then in Vercel project settings, confirm Root Directory still = apps/web
# Redeploy and verify CSP header still present
git commit -m "chore: move vercel.json to repo root for monorepo convention"
```

Doesn't affect functionality. Pure preference.

### Convert `routes/health.ts` to `routes/health/index.ts`

Cosmetic. Only worth doing if Sprint 13 adds sub-routes under `/v1/health/*` (it doesn't currently plan to). Skip.

---

## What you're shipping at GO

By the time the next verification returns GO:

- **27 migrations applied**, including 027 SECURITY DEFINER lockdown
- **4 email templates** committed, T4 audited to never leak `rejection_note`
- **Canonical `/v1/health`** with `status` + `uptime` + nested `services` + pool stats
- **README** with the 5 required sections, no duplicates
- **Vercel deploy** serving over HTTPS with CSP header
- **Railway API deploy** serving with all secrets configured
- **GitHub Actions CI + deploy-api** green on `main`
- **Dependabot** enabled, zero open alerts
- **17+ unit tests** across security plugins, stream handler, period-format regression, and health endpoint
- **B-01 strict** — `audit_log` is genuinely tamper-proof and write-controlled at the Postgres role level

Sprint 1 starts on a foundation that earned its acceptance.

Go finish.
