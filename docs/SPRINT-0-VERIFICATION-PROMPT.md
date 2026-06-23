# SPRINT 0 — VERIFICATION PROMPT

> Paste the block between the markers into a fresh Claude chat to verify Sprint 0
> is genuinely complete before starting Sprint 1.

---PROMPT START---

WHERE WE ARE

I just finished Sprint 0 of the Skaly Business Portal — every step from
docs/MASTER-BUILD-GUIDE-V2-FINAL.md PART 7 STEP 1 through STEP 14. Before I start
Sprint 1 (auth + signup), I need you to verify that Sprint 0 is genuinely
complete — not "looks complete," not "the files exist," but actually working
end-to-end.

WHAT TO DO

Run the 8 verification phases below in order. For each phase: execute every
command, paste the actual output (do not paraphrase or skip), and mark the phase
PASS / FAIL / PARTIAL with the evidence inline. If a phase has a hard failure,
finish capturing that phase's output and then stop — do not silently move on, do
not auto-fix. At the very end, output the FINAL VERDICT block.

NOTE ON KNOWN DELTAS (intentional, from the Sprint 0 fix passes):
- vercel.json lives at apps/web/vercel.json (Vercel Root Directory = apps/web),
  NOT at repo root.
- There are 27 migrations (001-027); 027_audit_log_security_definer adds the
  SECURITY DEFINER lockdown for B-01.
- The health route is apps/api/src/routes/health.ts (a file, not a directory).
- /v1/health canonical shape: { status, uptime, timestamp,
  services.database.{ok,pool}, services.redis.ok }.

PHASE 1 — FILE EXISTENCE

```bash
ls -la
ls -la apps apps/web apps/api packages packages/config packages/shared database/migrations database/seeds .github/workflows docs
ls database/migrations/ | wc -l
```

Confirm each of the following exists:

- Root: pnpm-workspace.yaml, package.json, docker-compose.yml, .gitignore,
  .nvmrc, .editorconfig, README.md, apps/web/vercel.json
- apps/web/: package.json, next.config.ts, tsconfig.json, postcss.config.*,
  vitest.config.ts, components.json, src/app/, src/lib/utils.ts,
  src/app/globals.css, src/app/(portal)/layout.tsx
- apps/api/: package.json, tsconfig.json, vitest.config.ts, src/app.ts,
  src/server.ts, src/lib/env.ts, src/lib/db.ts, src/lib/redis.ts,
  src/lib/logger.ts, src/lib/bot/stream-handler.ts,
  src/middleware/internalAuth.plugin.ts,
  src/middleware/socketTokenWatcher.plugin.ts, src/routes/health.ts,
  src/types/fastify.d.ts, scripts/migrate.ts, scripts/rollback.ts,
  scripts/status.ts, scripts/seed.ts, scripts/refresh-views.ts,
  src/templates/email/{invite,signup-pending,signup-approved,signup-rejected}.html,
  test/middleware/internalAuth.test.ts, test/middleware/socketTokenWatcher.test.ts,
  test/lib/bot/stream-handler.test.ts, test/routes/health.test.ts
- packages/config/: tsconfig.base.json, eslint.config.js, prettier.config.js,
  package.json
- packages/shared/: src/index.ts, src/db.types.ts (generated), package.json
- database/migrations/: 27 files numbered 001 through 027, ending with
  027_audit_log_security_definer.ts
- database/seeds/: 001_system_actor.ts, 002_dev_data.ts
- .github/workflows/: ci.yml, deploy-api.yml
- docs/: all 13 spec docs (01-PRD through 13-NFRS), plus 14-PRE-BUILD-AUDIT.md,
  CRITICAL-PATCHES.md, SPRINT-0-READINESS-CHECKLIST.md, FIX-GUIDE-V2-COMPLETE.md,
  MASTER-BUILD-GUIDE-V2-FINAL.md

Anything missing or named differently → PHASE 1 FAIL, list every missing file.

PHASE 2 — STATIC ANALYSIS

```bash
pnpm install
pnpm typecheck
pnpm lint
```

Expected: install completes (no peer dep errors). typecheck 0 errors across all
packages. lint 0 errors (warnings allowed but flag them). Even one TS error →
PHASE 2 FAIL.

PHASE 3 — UNIT TESTS

```bash
pnpm test
```

Expected: all tests pass. At minimum these must exist and pass:
- test/middleware/internalAuth.test.ts — B-03: timing-safe equal, length
  pre-check, 50ms min response delay on invalid secret.
- test/middleware/socketTokenWatcher.test.ts — C-05 server side.
- test/lib/bot/stream-handler.test.ts — H-04: mocked Anthropic completion + error.
- test/routes/health.test.ts — /v1/health 200 + 503 contract.

Any failure → PHASE 3 FAIL with the failing test name and assertion message.

PHASE 4 — LOCAL INFRA + MIGRATIONS + SEEDS

```bash
docker compose up -d
sleep 5
docker compose ps
docker exec -i $(docker compose ps -q postgres) psql -U skaly -d skaly_dev -c "SELECT version();"
docker exec -i $(docker compose ps -q redis) redis-cli PING
pnpm db:migrate
pnpm db:status
pnpm --filter @skaly/api db:codegen
head -40 packages/shared/src/db.types.ts
NODE_ENV=development pnpm db:seed
docker exec -i $(docker compose ps -q postgres) psql -U skaly -d skaly_dev -c "SELECT id, name, role FROM staff WHERE id='00000000-0000-0000-0000-000000000000';"
docker exec -i $(docker compose ps -q postgres) psql -U skaly -d skaly_dev -c "SELECT COUNT(*) AS client_count FROM clients;"
pnpm db:refresh-views
```

Expected: both services up; Postgres 16.x; Redis PONG; 27 applied, 0 pending,
ending 027_audit_log_security_definer; db.types.ts has all table interfaces;
System Actor row at zero UUID; client count >= 3; views refresh without error.
Any failure → PHASE 4 FAIL.

PHASE 5 — B-01 SECURITY LOCKDOWN (kill switch)

Migrations 026 + 027 revoke UPDATE/DELETE/INSERT on audit_log from skaly_app; the
only write path is the audit_log_insert() SECURITY DEFINER function. Verify:

```bash
docker exec -i $(docker compose ps -q postgres) psql -U skaly -d skaly_dev <<'SQL'
SET ROLE skaly_app;
SELECT current_user;
-- correct-schema columns; all three MUST fail with "permission denied for table audit_log"
INSERT INTO audit_log (id, staff_id, changed_by_source, table_name, record_id, action, old_value, new_value, ip_address, created_at)
VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'system', 'test', gen_random_uuid(), 'INSERT', NULL, NULL, NULL, now());
UPDATE audit_log SET action='tampered' WHERE id = (SELECT id FROM audit_log LIMIT 1);
DELETE FROM audit_log WHERE id = (SELECT id FROM audit_log LIMIT 1);
RESET ROLE;
SQL
```

Expected: every one of INSERT, UPDATE, DELETE returns
"ERROR: permission denied for table audit_log".
If even one statement succeeds → PHASE 5 FAIL. STOP. Do not proceed.

PHASE 6 — APP BOOT + HEALTH

```bash
pnpm --filter @skaly/api dev &
pnpm --filter @skaly/web dev &
sleep 12
curl -sS http://localhost:3001/v1/health | jq
curl -sSI http://localhost:3000
```

Expected health JSON (canonical):
- status: "ok"
- uptime: <integer seconds>
- timestamp: <ISO-8601 string>
- services.database.ok: true
- services.database.pool: { total: <n>, idle: <n>, waiting: 0 }
- services.redis.ok: true

Web: HTTP/1.1 200 OK. Then verify in a browser at http://localhost:3000:
- Gold "Skaly Business Portal" headline visible
- DevTools console: zero red errors
- Network → Font: Big Shoulders Display, DM Sans, DM Mono all 200
- Application → Cookies: no Supabase session yet

Any console error → PHASE 6 PARTIAL. Kill the dev processes when done.

PHASE 7 — DEPLOYS (user-verified, paste back evidence)

1. Vercel production deployment: open production URL (expect gold headline, no 500).
2. Railway API: open https://YOUR-API.up.railway.app/v1/health (expect canonical JSON).
3. GitHub Actions: latest run on main — ci.yml and deploy-api.yml both green. SHA + conclusion.
4. GitHub Secrets: DATABASE_URL_PROD exists? (yes/no)
5. GitHub Dependabot: alerts enabled? security updates enabled? open alerts = 0? (L-09)
6. Vercel env (prod): NEXT_PUBLIC_API_URL, NEXT_PUBLIC_WS_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY all present?
7. Railway env (prod): DATABASE_URL, REDIS_URL, R2_BUCKET_NAME, ANTHROPIC_API_KEY, TZ=Asia/Kolkata, CRON_SECRET, SUPABASE_JWT_SECRET all set?

Any "no"/"missing" → PHASE 7 PARTIAL or FAIL.

PHASE 8 — AUDIT FINDINGS CROSS-CHECK

| ID | Check |
|---|---|
| B-01 | Phase 5 — must be PASS |
| B-02 | grep -A3 "B-02" docs/SPRINT-0-READINESS-CHECKLIST.md — decision logged; templates in apps/api/src/templates/email/ |
| B-03 | grep -E "timingSafeEqual\|length\|50" apps/api/src/middleware/internalAuth.plugin.ts — all three appear |
| C-04 | Phase 4 — staff row at zero UUID exists |
| C-05 | ls apps/api/src/middleware/socketTokenWatcher.plugin.ts + Phase 3 test passing |
| C-06 | grep "bootstrapInitialMonth" apps/api/src/services/RolloverService.ts — deferred to Sprint 12 |
| H-03 | grep "REFRESH MATERIALIZED VIEW" database/migrations/024_*.ts — first refresh NOT CONCURRENTLY |
| H-04 | wc -l apps/api/src/lib/bot/stream-handler.ts — ~150 lines, Phase 3 test passes |
| H-07 | grep -r "Sentry.init" apps/api/src apps/web/src — deferred to Sprint 11 |
| H-08 | grep -i "content-security-policy" apps/web/vercel.json — appears |
| H-09 | grep "pool" apps/api/src/lib/db.ts + Phase 6 health JSON pool stats |
| M-02 | grep -ri "mobile" "apps/web/src/app/(portal)/layout.tsx" — gate present |
| M-06 | grep "addHeaders" apps/api/src/app.ts — rate-limit headers on |
| M-10 | Phase 4 — clients >= 3 |
| M-11 | grep -E "^## (Stack\|Local Setup\|Common Commands\|Specification\|Sprint Progress)" README.md — all 5 |
| L-09 | Phase 7 — Dependabot enabled |

FINAL VERDICT

```
SPRINT 0 VERIFICATION REPORT — <date>
=============================================
Phase 1 (File existence):      PASS | FAIL | PARTIAL — <evidence>
Phase 2 (Static analysis):     PASS | FAIL — <evidence>
Phase 3 (Unit tests):          PASS | FAIL — <Test Files X | Tests Y>
Phase 4 (Local infra):         PASS | FAIL — <evidence>
Phase 5 (B-01 lockdown):       PASS | FAIL — <evidence>
Phase 6 (App boot + health):   PASS | FAIL | PARTIAL — <evidence>
Phase 7 (Deploys):             PASS | FAIL | PARTIAL — <pending user>
Phase 8 (Audit cross-check):   <N> of 16 PASS — <FAILs with IDs>

FINAL VERDICT: GO FOR SPRINT 1 | STOP — RESOLVE BLOCKERS
```

RULES
- Run every command. Paste actual output (truncate only >50 lines: first 20 + last 20).
- No silent fixes. Report what's broken.
- Phase 5 is the kill switch: if audit_log accepts a write from skaly_app, verdict is STOP.

---PROMPT END---
