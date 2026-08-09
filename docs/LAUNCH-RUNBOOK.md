# LAUNCH RUNBOOK — Sprint 13 STEPS 11 & 12

**The pre-launch gate and the production deploy, written to be followed line by line.**

This is the part of Sprint 13 that cannot be automated from a dev machine, because every
item touches real infrastructure: a real backup in R2, a real Railway project, a real
Vercel project, real staging Supabase. What follows is every command, what a PASS looks
like, and what to do when it isn't one.

> **Read this first.** STEP 11 is a **gate**, not a checklist. Each item is pass/fail and
> **a single fail stops the launch.** The one item that cannot be faked is 11.1 — a backup
> you have never restored is a hypothesis, not a backup.

---

## Before you start — what you need open

| Thing | Why | Where |
|---|---|---|
| Railway dashboard | API service, cron service, env vars, deploy logs | railway.app |
| Vercel dashboard | Web project, env vars, promotion | vercel.com |
| Cloudflare R2 | The backup you are going to restore | dash.cloudflare.com → R2 |
| Supabase dashboard | Staging project (for 11.4) | supabase.com |
| A terminal with `psql`, `docker`, `gh`, `git` | Everything else | — |

Check `psql` is available before you begin — 11.1 depends on it:

```bash
psql --version        # any 14+ client can restore a 16 dump for our purposes
docker --version
```

If `psql` is missing on Windows, you already have one inside the Postgres container:

```bash
docker compose exec postgres psql --version
```

—and every `psql` command below can be run as `docker compose exec -T postgres psql …`.

---

# STEP 11 — THE PRE-LAUNCH GATE

## 11.1 ⚠️ Backup restore drill — **HARD BLOCKER**

**What this proves:** that the nightly backup at 02:00 IST produces a file that actually
restores, that the schema in it matches the code, and that RTO < 2hr / RPO < 24hr
(NFR §3.2) are real numbers rather than aspirations.

**What it does NOT prove if you skip to a synthetic dump:** anything at all. A dump you
just created with `pg_dump` tests the syntax of `pg_restore`. The failure modes that
matter are *a rotated R2 credential*, *a cron that has been silently failing for six
weeks*, and *a dump truncated by an out-of-disk*. All three produce a file that exists.

### 11.1.a — Find the real backup

Infra §7: daily 02:00 IST full dump → R2 `backups/{date}/`.

```bash
# List what's actually there. Use whichever you have configured:
aws s3 ls s3://skaly-portal-prod/backups/ --endpoint-url "$R2_ENDPOINT" --recursive | tail -20
# or: rclone ls r2:skaly-portal-prod/backups | tail -20
```

**Look at the dates and the sizes.** Two failure signals, both silent:

- The newest backup is older than ~26 hours → the cron has stopped (Infra §8 alerts on
  this; confirm the alert fired).
- A backup is drastically smaller than its neighbours → it was truncated.

Download the newest one:

```bash
aws s3 cp "s3://skaly-portal-prod/backups/<DATE>/db-backup.sql.gz" ./db-backup.sql.gz \
  --endpoint-url "$R2_ENDPOINT"
ls -lh db-backup.sql.gz        # note the size — you will compare it to the row counts
```

### 11.1.b — Spin up a throwaway Postgres

**Never restore into anything you care about.** A fresh container, on a port nothing else
uses:

```bash
docker run -d --name skaly-restore-drill \
  -e POSTGRES_PASSWORD=drill -e POSTGRES_USER=skaly -e POSTGRES_DB=skaly_restore \
  -p 5433:5432 postgres:16-alpine

# Wait for it to accept connections
docker exec skaly-restore-drill pg_isready -U skaly
```

```bash
export TEMP_DATABASE_URL="postgresql://skaly:drill@localhost:5433/skaly_restore"
```

### 11.1.c — Restore

```bash
gunzip -c db-backup.sql.gz | psql "$TEMP_DATABASE_URL"
```

**Watch the output.** `psql` keeps going after errors by default, so a restore can
"finish" having failed. Two things to check:

```bash
# Re-run capturing errors only — this is the honest check
gunzip -c db-backup.sql.gz | psql "$TEMP_DATABASE_URL" -v ON_ERROR_STOP=1 2>&1 | tail -20
```

`ON_ERROR_STOP=1` turns the first error into a non-zero exit. **That is the flag that
makes this drill mean something.**

### 11.1.d — Verify: row counts

```bash
psql "$TEMP_DATABASE_URL" -c "
SELECT 'staff' AS t, count(*) FROM staff
UNION ALL SELECT 'clients', count(*) FROM clients
UNION ALL SELECT 'tasks', count(*) FROM tasks
UNION ALL SELECT 'attendance_logs', count(*) FROM attendance_logs
UNION ALL SELECT 'content_pipelines', count(*) FROM content_pipelines
UNION ALL SELECT 'messages', count(*) FROM messages
UNION ALL SELECT 'audit_log', count(*) FROM audit_log
ORDER BY 1;"
```

Compare against production:

```bash
psql "$PROD_DATABASE_URL" -c "…the same query…"
```

**PASS =** every count matches within **one day's activity** (RPO < 24hr — the backup is
from 02:00, so a day's writes are legitimately missing). **FAIL =** a table is empty in
the restore and populated in production. An empty `audit_log` in particular means the
`SECURITY DEFINER` function or its grants did not come across (migrations 026/027).

### 11.1.e — Verify: integrity, not just counts

A row count of 50,000 tells you nothing about whether any row is readable.

```bash
# 1. A known recent row is present and legible
psql "$TEMP_DATABASE_URL" -c "SELECT id, name, role, active FROM staff ORDER BY created_at DESC LIMIT 5;"

# 2. ⭐ A materialised view refreshes — this exercises the view DEFINITIONS and
#    their unique indexes, which is what the whole rollover Tier 2 depends on.
psql "$TEMP_DATABASE_URL" -c "REFRESH MATERIALIZED VIEW dashboard_org_stats;"
psql "$TEMP_DATABASE_URL" -c "REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_org_stats;"
psql "$TEMP_DATABASE_URL" -c "REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_staff_task_stats;"

# 3. The rollover state columns exist (migration 033) — proves the backup is
#    from a schema the current code can actually run against
psql "$TEMP_DATABASE_URL" -c "\d months" | grep -i rollover

# 4. Constraints survived
psql "$TEMP_DATABASE_URL" -c "SELECT count(*) FROM pg_constraint WHERE contype = 'f';"
```

The `CONCURRENTLY` refresh in (2) is the specific one to care about: it fails outright if
the unique index did not restore, and that index is what keeps the dashboard readable
during every future rollover.

### 11.1.f — Record the timing, then destroy

**RTO < 2hr (NFR §3.2)** is about how long a real recovery takes. Note the wall-clock time
from "started downloading" to "row counts verified". If it is over two hours, that is a
finding — usually the download, which means the backup is too large or R2 egress is slow,
and the fix is a `--jobs` parallel `pg_restore` from a custom-format dump.

```bash
docker rm -f skaly-restore-drill
rm db-backup.sql.gz
```

**PASS = a real R2 backup restored with `ON_ERROR_STOP=1`, row counts within RPO, a
matview refreshed `CONCURRENTLY`, total time under 2 hours.** Write the date and the
elapsed time into the close-out. This becomes a monthly exercise (POST-LAUNCH-BACKLOG).

---

## 11.2 Report perf — **BLOCKER IF MISSED**

Confirm, don't assume (Ruling 4). The Sprint 12 number was **p95 3796ms / p99 4784ms** at
n=100, representative volume, against budgets of **p95 < 10s / p99 < 20s**.

Re-run on merged code:

```bash
pnpm --filter @skaly/api exec tsx scripts/seed-perf-clients.ts 20
pnpm --filter @skaly/api exec tsx scripts/measure-report-nfr.ts
```

The script prints `NFR §1.2  p95 < 10000ms: PASS/FAIL · p99 < 20000ms: PASS/FAIL`.

**PASS** → closed. **MISS** → launch blocker: profile the **worker render**, not the
accept — the 202 returns immediately by design (ADR-027), so a slow number is always in
`workers/report-*`, never in the route.

---

## 11.3 Instance count → Redis adapter (CONDITIONAL)

**The decision:** how many API instances does production run?

- **One** → correct at 50 users (NFR §2.1). The Socket.io Redis adapter **stays deferred**
  (already recorded in `POST-LAUNCH-BACKLOG.md` with its trigger).
- **Two or more** → the adapter is a **blocker**. Without it, `io.to(room).emit()` reaches
  only the users connected to the emitting instance, and the other half silently never see
  the notification. It presents as "real-time is flaky", not as a missing dependency.

Check it in Railway:

```
Railway → the API service → Settings → Deploy → Replicas
```

**PASS = the number is 1 and it is written down**, or the adapter has been added. Record
which in the close-out. Set a reminder: the first time anyone scales this to 2, the adapter
comes with it (Infra §10 tripwire).

---

## 11.4 Recovery-code redemption on staging (VERIFY)

Confirmed during STEP 1.1's staging pass. **The distinction that matters: a code was
actually REDEEMED, not merely generated.** Sole-admin lockout is the scenario nobody wants
to discover is broken, and generating codes exercises none of the redemption path.

On **staging**, against real Supabase:

1. Enroll a fresh admin MFA factor. Ten recovery codes are shown once (ADR-031).
2. Sign out completely.
3. Sign in with email + password.
4. At the TOTP prompt, choose **"Use a recovery code"**.
5. Paste one code. **You should reach `/home` with a full session.**
6. Try the **same code again**. It must be **rejected** — single-use is the whole security
   property.

**PASS = step 5 signed you in AND step 6 refused.** A pass on 5 with a pass on 6 as well
(i.e. it worked twice) is a **launch blocker**, not a curiosity.

---

## 11.5 Production readiness sweep

```
[ ] Railway env (Infra §6):
      NODE_ENV=production   PORT=3001   TZ=Asia/Kolkata     ← TZ is load-bearing for rollover
      DATABASE_URL  DATABASE_POOL_MIN=2  DATABASE_POOL_MAX=20
      SUPABASE_URL  SUPABASE_JWT_SECRET  SUPABASE_SERVICE_ROLE_KEY
      ANTHROPIC_API_KEY  ANTHROPIC_MODEL_PROD  ANTHROPIC_MODEL_DEV
      R2_ENDPOINT  R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY  R2_BUCKET_NAME
      REDIS_URL
      CRON_SECRET            ← ≥ 32 chars, and the SAME value in the cron service
      SENTRY_DSN             ← OPTIONAL (H-07); unset = disabled, that is a valid state

[ ] Vercel env:
      NEXT_PUBLIC_API_URL  NEXT_PUBLIC_WS_URL
      NEXT_PUBLIC_SUPABASE_URL  NEXT_PUBLIC_SUPABASE_ANON_KEY
      NEXT_PUBLIC_SENTRY_DSN ← OPTIONAL
      …and NOTHING else prefixed NEXT_PUBLIC_. Anything secret with that prefix
      is in the browser bundle, permanently, for everyone.

[ ] Model strings re-verified against the live model list — they move.
[ ] CSP is ON and every module works (STEP 8 — it is enforcing now, not report-only).
[ ] Sentry: either receiving events, or deliberately unset. Both are PASS; "we
    think it's configured" is not.
[ ] Cron schedules, all IST, no overlaps:
      00:01 daily    rollover            31 18 * * *
      02:00 daily    backup              30 20 * * *
      03:00 monthly  message retention   30 21 1 * *
      04:00 daily    attachment sweep    30 22 * * *
[ ] Health check green:
      curl -s https://api.skaly.in/v1/health   → {"status":"ok","services":{…}}
[ ] Full API suite + Playwright green on main.
```

### Verifying `TZ=Asia/Kolkata` actually took

This one is worth proving rather than reading off a dashboard — the rollover's target
period and the recompute's "today" both derive from it:

```bash
curl -s https://api.skaly.in/v1/health | jq .timestamp
# and, once deployed, the rollover's no-op response names the period it resolved:
curl -s -X POST https://api.skaly.in/v1/internal/rollover \
  -H "X-Internal-Secret: $CRON_SECRET" | jq .
# → {"data":{"period":"2026-08", …}}   ← must be the CURRENT IST month
```

If that period is a month behind late at night, `TZ` is not set on the API service.

**THE GATE PASSES ONLY WHEN 11.1–11.5 ALL PASS.**

---

# STEP 12 — PRODUCTION DEPLOY

## 12.1 Deploy via the release tag — do **not** hand-deploy

Infra §3. The pipeline exists so that migrations, API and web move together and in order.

```bash
git checkout main && git pull
git log --oneline -5          # Sprint 13 is merged, CI green
git tag v1.0.0
git push origin v1.0.0
```

Then, in order — **watch each one finish before looking at the next**:

1. **Railway deploys the API and runs migrations against the production DB.**
   Watch the deploy log. The migration output should end with
   `[migrate] all migrations applied` and include `✅ 033_months_rollover_state`.
   *If a migration fails, STOP.* The API will be running old code against a
   half-migrated database. Roll back the deploy in Railway before doing anything else.
2. **Vercel promotes the build to production.**
3. **Health check:**
   ```bash
   curl -s https://api.skaly.in/v1/health | jq .
   ```
   Expect `{"status":"ok","services":{"database":"ok","redis":"ok"}}`. A `degraded`
   here is a stop.
4. **Smoke (12.2 below).**
5. `portal.skaly.in` is live.

## 12.2 Live production smoke

Do these **in production, as a real user**, in this order:

1. **Auth** — admin login → MFA challenge → `/home`. Then a `team_member` login (no MFA
   prompt) → `/home`.
2. **Every module loads** — attendance, tasks, shoot planner, content dropper, calendar,
   dashboard, chat, bot. Open the browser console: **a CSP violation prints there and
   nowhere else.** This is the moment the enforcing CSP either works or doesn't.
3. **A real write round-trips** — toggle an attendance cell. Open a second browser as
   another user; the change appears live without a refresh.
4. **The bot answers**, and **executes a confirmed mutation** through the two-turn card.
5. **A report generates** off the event loop → `report_ready` in the bell → it downloads.
6. **Notifications + presence** work across the two sessions.
7. **⚠️ Rollover readiness — verify, do NOT trigger.**
   ```bash
   # Confirm the cron service is scheduled and the endpoint is reachable.
   # This call is SAFE: mid-month, the current period already has its rows, so the
   # idempotency guard returns already_completed and does no work whatsoever.
   curl -s -X POST https://api.skaly.in/v1/internal/rollover \
     -H "X-Internal-Secret: $CRON_SECRET" | jq .
   # → {"data":{"period":"<current IST month>","status":"already_completed", …}}
   ```
   **`already_completed` is the correct and expected answer.** If it returns
   `completed`, the current month did not have a `rollover_completed_at` — harmless (it
   just filled gaps idempotently), but note it: it means the month was created by the seed
   rather than by a rollover.
   Then let the first real rollover run on its own at 00:01.
8. **Sentry** (if configured) shows no unexpected errors from the smoke.

## 12.3 The morning after the first real rollover

Not in the sprint guide, but it is the only time this code has ever run unattended.

```bash
psql "$PROD_DATABASE_URL" -c "
SELECT period, rollover_completed_at, view_refreshed_at, rollover_failed_step
FROM months ORDER BY period DESC LIMIT 3;"
```

**Healthy:** the new month's row has both timestamps set and `rollover_failed_step` NULL.

| What you see | What it means | What to do |
|---|---|---|
| Both timestamps set | Clean run | Nothing |
| `completed_at` set, `refreshed_at` NULL, step `view_refresh` | Tier 2 failed — **the month is intact**, the dashboard is stale | Re-POST the endpoint; it resumes Tier 2 only |
| No row for the new month at all | Tier 1 failed and rolled back fully — correct behaviour | Check the admin's `rollover_failed` notification for the step; click **[Manual rollover]** |
| A row with `completed_at` NULL | Something created a months row without rolling over | Re-POST; the guard treats it as not-yet-rolled-over and runs Tier 1 |

An admin should have a `rollover_success` notification either way. **`rollover_view_refresh_failed`
without a preceding `rollover_success` is impossible if the tiers are correct** — if you
ever see that pairing, the tiers have been entangled and that is a bug, not an incident.

---

## 12.4 Close-out

Record, in the repo:

- The date the backup restore drill ran, and its elapsed time.
- The report-perf numbers from 11.2.
- The instance count decided in 11.3.
- Whether Sentry is on.
- The tag deployed and the deploy date.

Then set the recurring reminder for the monthly restore drill
(`docs/POST-LAUNCH-BACKLOG.md`).

---

# SPRINT 13 CLOSE-OUT

`[x]` = verified in this repo, with the evidence named. `[ ]` = needs infrastructure
only you can reach. Nothing is ticked on the strength of "it should work".

```
LAUNCH
  [x] ADR-035/036/037 committed; POST-LAUNCH-BACKLOG.md seeded
  [x] Idempotency migration run (033), additive, reversible (rolled back and re-applied)
  [x] The view unique indexes CONCURRENTLY needs already existed (024) — confirmed,
      not assumed, and now COMMENTed so an index audit cannot drop them
  [ ] Push backlog cleared: ADR-031 staging pass, then Sprints 11 → 12 → 13 to main
      ⚠️ origin/main is still at Sprint 10. THIS IS THE OUTSTANDING BLOCKER.

ROLLOVER (ADR-035/036/037)
  [x] Tier 1 (months row + period rows + recompute + audit + both success
      notifications) is ONE transaction; the commit is the boundary
  [x] Tier 2 refreshes both matviews CONCURRENTLY post-commit, never rolls Tier 1
      back (TESTED — Tier 2 injected to fail; period rows persist, endpoint 200s)
  [x] Tier 1 failure rolls back FULLY at every step — period_rows, recompute and
      audit each injected; all three assert ZERO partial state, not just an error
  [x] Recompute called, not reimplemented; System Actor; source='manual' honoured
  [x] Retention stays a temporally separate neighbour (03:00 IST monthly)
  [x] Four types fire to the right audiences over notify:new, payload under `payload`
  [x] Failure notification written FIRST with the templated body, then enriched
      (TESTED both ways: Anthropic throwing past its retries still leaves a
      complete notification; succeeding replaces the body)
  [x] AI summary uses the SDK's built-in retry; no hand loop, no retry-in-retry
  [x] [Manual rollover] is idempotent, shares the cron's core, admin-gated
  [x] Running rollover twice creates rows ONCE, month_ready ONCE (TESTED, and again
      end-to-end over HTTP)
  [x] Retry-after-partial RESUMES Tier 2 only (TESTED, unit + E2E)
  [x] Timing-safe internal-secret compare (pre-existing; a wrong secret never
      falls through to the session path — TESTED)
  [x] ADR-020 CLOSED — all 18 types have producers, deferred list = 0 (ASSERTED)

HARDENING
  [x] CSP enforcing (was Report-Only with no report-uri — a no-op header)
  [x] Per-module error boundaries, one error.tsx per segment (Next's own isolation)
  [x] Rate limits per API-Contract §2 — three missing ones added and asserted
      behaviourally; internal-rollover is secret-gated, not rate-limited
  [x] No secret in the web bundle; no dangerouslySetInnerHTML (grep clean)
  [x] Sentry wired behind an OPTIONAL DSN; unset = provably inert (TESTED)
  [ ] CSP verified against the real deployed app — it fails QUIETLY, and only a
      browser console on production proves it (STEP 12.2 item 2)

NFRs (MEASURED, not asserted)
  [x] Rollover 580ms at 20 clients, against a 5-minute budget
  [x] API operational during the window: view reads p95 2ms / max 3ms WHILE the
      rollover ran — the CONCURRENTLY proof
  [x] k6 50 VUs, realistic profile: every §1.2 budget passes (attendance p95 44ms)
  [x] Stress profile ceiling recorded (attendance 449ms at 147 req/s) — one Node
      process's CPU, which is the 11.3 instance-count lever
  [x] Report perf RE-CONFIRMED on merged code (11.2): p95 3381ms / p99 6079ms
      at n=20, representative volume, real worker + real R2 — vs 10s / 20s. PASS.
      (Sprint 12 recorded p95 3796ms / p99 4784ms; the arc has not regressed.)
  [ ] Re-measure on STAGING. Every number above is a Windows dev laptop against
      Docker Postgres. Treat them as a floor.

PRE-LAUNCH GATE  (all four need real infrastructure — see STEP 11 above)
  [ ] Backup restore drill — a REAL R2 backup, ON_ERROR_STOP=1  (HARD BLOCKER)
  [x] Report perf confirmed — see NFRs above. Re-run on staging to be thorough,
      but the local number is a 3x margin, not a marginal pass.
  [ ] Instance count decided; Redis adapter deferred if single-instance
  [ ] Recovery-code redemption on staging — REDEEMED, and the second use REFUSED

DEPLOY
  [ ] v1.0.0 tagged; deployed via the release-tag pipeline, not by hand
  [ ] Migrations run on production; health check green
  [ ] Live smoke passed; portal.skaly.in live

SUITES, at close-out
  [x] 977 API tests · 76 files
  [x] 310 web tests · 38 files
  [x] 154 Playwright, 10 skipped, 0 failed (chromium + webkit, 52.6m)
  [x] typecheck + lint clean across the workspace
```

## The three defects this sprint's own tests found

Recorded because each one would have reached production, and none would have been
caught by review:

1. **`entityId: period` into `audit_log.record_id`, a UUID column.** `months` is
   keyed `CHAR(7)`. Tier 1 would have thrown at the *audit* step — every night,
   after generating every row. The transaction rolled back correctly, so the
   symptom was "rollover always fails" with no data damage and no obvious cause.
2. **The notification census reported a producer that did not exist.** An inline
   union *type annotation* matched its `type: 'x'` producer grep, so
   `rollover_failed` looked wired while its real emitter went unfound — precisely
   the false positive the census exists to catch.
3. **`/auth/signup/invite` had no rate limit.** The path that turns a token into an
   account, inheriting the global 150/min.

And one measurement defect, worth as much as the three: the first k6 run reported
two NFR misses that were **the harness**, not the API — a ~200ms IPv6 loopback
penalty on `localhost` plus a load model 14× real usage. A perf number nobody
double-checks is a perf number that misdirects a whole launch.
