# SPRINT 13 — ROLLOVER, HARDENING & LAUNCH: DETAILED PROMPT-BY-PROMPT GUIDE

## Scaly Business Portal • Sprint 13 of 13 — THE FINAL SPRINT

**Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1..12-DETAILED.md` + `SPRINT-8_1` / `SPRINT-10_1` patches**
**Same Goal / Prompt / Verify framework as Sprints 0–12**
**Tooling interfaces verified as of July 2026** — Fastify 5, Kysely (transactions, `REFRESH MATERIALIZED VIEW CONCURRENTLY`, `sql` template), PostgreSQL 16 (materialised views + unique index for concurrent refresh, advisory locks), `@anthropic-ai/sdk` (built-in `maxRetries` retry — the Sprint 8 amendment), Socket.io v4 (`notify:new` **typed** delivery — a type is not an event; the payload arrives under `payload`), Railway cron (`X-Internal-Secret`), `pg_dump`/`pg_restore`, k6, Playwright latest. **ADR series lives in `docs/decisions/`.**

> **Risk note:** rollover is the highest-stakes transaction in the product — it runs unattended at 00:01 with no user watching, and a wrong outcome is discovered the next morning by the business owner. Everything in this sprint is about making a failure *loud, recoverable, and non-destructive* rather than making success elegant. The two-tier boundary (STEP 3) and idempotency (STEP 5) are the load-bearing decisions; the notifications (STEP 4) are how anyone finds out. This is also the launch sprint — STEP 11 is a gate, not a formality, and the backup restore drill in it is the one item that cannot be faked.

---

## USING THE `/ponytail` PLUGIN IN THIS SPRINT

Placement as established in Sprint 9: **between the build prompt and the test prompt** — on the implementation, before anything is written against its shape. Absent from manual steps, ADR authoring, migrations, branch creation, and the launch-gate drills.

**Where he earns his keep this sprint:** the rollover transaction body (STEP 3 — a long procedure that will want to sprawl and must stay one readable transaction with a clear commit line), the notification fan-out across four types (STEP 4 — one shape, four triggers), and the idempotency guard (STEP 5 — a create-if-absent/resume-if-partial check that should read as one decision). The failure path — templated-then-enriched summary — is his kind of convergence: four ways in, one notification out.

---

## WHAT YOU'RE BUILDING IN SPRINT 13

The last feature, the hardening, and the launch. By the end of this week the portal is live. Specifically:

- **The three pre-Sprint-13 decisions are recorded** as **ADR-035** (rollover atomicity), **ADR-036** (rollover notifications + AI summary), **ADR-037** (rollover idempotency).
- **Rollover runs as a two-tier transaction** — Tier 1 (period-row creation for every client + the `coming_shoot_date` recompute + the `months` idempotency row) is one atomic transaction that fully commits or fully rolls back; Tier 2 (the materialised-view refresh) is a **separate, post-commit** step, `CONCURRENTLY`, whose failure degrades the dashboard but **never** undoes the rollover.
- **All four rollover notification types fire** — `month_ready` (all), `rollover_success` (admins), `rollover_failed` and `rollover_view_refresh_failed` (admins). These are the **last** of ADR-017's deferred six: after this, **all 18 types have producers and the coverage test's deferred list is zero** — the assertion that closes the entire notification arc.
- **The failure notification is unconditional** — written first with a **templated** body, then *enriched* by the Claude-generated incident summary (Error-Handling §7) if the API succeeds. A rollover that fails silently because the *summary* also failed is the worst case in the product; the notification never depends on the summary.
- **The failure notification is actionable** — the inline, idempotent **`[Manual rollover]`** action (Error-Handling §7), sharing one idempotent core with the cron.
- **Rollover is safe to run twice** — the `months` row inside Tier 1's transaction as the create-if-absent key; post-commit steps guarded on row state so a retry resumes rather than re-runs; the manual button and the cron hit the same idempotent endpoint.
- **The pre-launch gate is passed explicitly** — the **backup restore drill** run once against a real backup (hard blocker), the **report-perf number** from Sprint 12 confirmed (blocker if it missed), the **instance-count** decision made (single-instance → Redis adapter deferred with a note), and staging's **recovery-code redemption** verified end-to-end.
- **A post-launch backlog exists** — the deferred items (2-year audit archival, id-based mention resolution, the Redis-adapter tripwire, Phase-2 mobile) have a home so "deferred" doesn't evaporate the day after launch.
- **The portal is deployed to production and smoke-tested live.**

**Estimated time:** 5 working days (Week 14 per `06-IMPLEMENTATION-PLAN.md` §16; owners TL + D1 + D2). Day 1 pre-flight + the push backlog cleared + ADRs + idempotency migration; day 2 the two-tier rollover transaction; day 3 notifications + AI summary + manual-rollover action; day 4 rollover tests (failure injection) + the launch gate drills; day 5 production deploy + live smoke + close-out.

**Prerequisites — the push backlog must be cleared first:**

- **⚠️ Sprints 11 and 12 are pushed and merged.** Both were tagged locally and gated on the **same** thing — **ADR-031's staging MFA verification** (the server-enroll/verify flow against real Supabase, which genuinely can't run locally). That one manual step has been the long pole holding two finished sprints. STEP 1 clears it once, pushes Sprint 11 → `main`, then Sprint 12 → `main`, before any Sprint 13 code.
- The atomic-transaction discipline from every prior sprint (`BaseService`, `AuditService` with the System Actor); the recompute is a single extracted function (ADR-034, Sprint 12); retention is a temporally-separate neighbor (03:00 IST monthly), never a rollover passenger.
- `NotificationService` with the 18-type registry (ADR-017), the `notify:new` **typed** delivery invariant now pinned on `useNotifySocket` (a type is not an event; the payload arrives under `payload` — pinned commit; do not reintroduce a bespoke event).
- The Anthropic SDK client with built-in retry (the Sprint 8 amendment — `maxRetries`, respects `Retry-After`).
- A `dashboard`/reporting materialised view exists (Sprints 4/7 dashboard work) — STEP 1 confirms it has the unique index `CONCURRENTLY` requires.
- The Railway cron service firing the rollover endpoint with `X-Internal-Secret` (Infra §4).
- `pnpm typecheck`, `pnpm lint`, and the full suite green on `main`.

---

## THE PRE-SPRINT-13 DECISIONS — WHERE THEY LAND

| Decision | Ruling | Executed in |
|---|---|---|
| **Rollover atomicity = two tiers** | Tier 1 (period rows + recompute + `months` insert) one atomic transaction; Tier 2 (materialised-view refresh) post-commit, `CONCURRENTLY`, independently failable, **never rolls back the rollover**. Retention stays a temporally-separate neighbor. → **ADR-035** | STEP 1 (record) + STEP 3 |
| **↳ Commit is the boundary** | `rollover_success`/`month_ready` fire on Tier 1 commit; the refresh outcome fires its own notification. `rollover_view_refresh_failed` without a preceding `rollover_success` = tiers entangled = bug. | STEP 3 + STEP 4 |
| **↳ Refresh is CONCURRENTLY** | Or it takes `ACCESS EXCLUSIVE` and blocks dashboard reads. Requires a unique index on the view — confirm before wiring. | STEP 1 + STEP 3 |
| **Four notification types + AI summary** | Last of ADR-017's six → deferred list hits **zero**. Failure notification **written first with a templated body**, *enriched* by the AI summary, never dependent on it. SDK retry then template. → **ADR-036** | STEP 1 (record) + STEP 4 |
| **↳ Actionable failure** | Inline, idempotent `[Manual rollover]` action (Error-Handling §7). A failure summary with no recovery action is a dead-end. | STEP 4 |
| **Idempotency + retry** | `months` row inserted **inside Tier 1's transaction** as create-if-absent key; post-commit steps guarded on row state so a retry resumes; manual button + cron share one idempotent core. → **ADR-037** | STEP 1 (record) + STEP 2 + STEP 5 |
| **Launch gate — triage** | Backup restore drill = **hard blocker**. Report perf = **confirm the Sprint 12 number** (blocker if missed). Redis adapter = **deferred if single-instance**. Recovery-code redemption = **verify on staging**. | STEP 11 |
| **Still deferred** | 2-year audit archival (year-two); id-based mention resolution (non-blocking hardening); Phase-2 mobile. → post-launch backlog. | STEP 1 + STEP 12 |

---

## READ FIRST (Open in Antigravity Split View)

| Doc | Sections | Why |
|---|---|---|
| `docs/09-ERROR-HANDLING.md` | **§7 (rollover failure AI summary — model, prompt, delivery, the `[Manual rollover]` button)**, §2 (`ANTHROPIC_ERROR`, `INTERNAL_ERROR`) | The failure path spec, verbatim |
| `docs/02-TRD.md` | Rollover section, §8 (`notify:new` typed delivery), §11 (materialised views + refresh) | The transaction + refresh architecture |
| `docs/13-NFRS.md` | **§3.1 (rollover single atomic transaction, < 5 min, "API fully operational during 00:01–00:05")**, §1.2 (`POST /internal/rollover` p95 < 60s / p99 < 90s), §3.2 (RTO/RPO), §2.2 (view refresh volume) | The numbers + the atomicity requirement |
| `docs/10-INFRA-DEPLOYMENT.md` | **§4 (cron service, `X-Internal-Secret`, `31 18 * * *` = 00:01 IST)**, §3 (release-tag production deploy), §7 (**backup strategy + the monthly restore drill**), §8 (monitoring — rollover + view-refresh alerts), §10 (scaling / Redis adapter tripwire) | Deploy + the launch-gate drills |
| `docs/05-BACKEND-SCHEMA.md` | `months` (**the idempotency key**), the materialised view definition + its unique index, `notifications` (the 4 rollover enum values), `audit_log` (System Actor) | Column truth |
| `docs/07-API-CONTRACT.md` | `POST /internal/rollover`, `/v1/notifications/*`, §1.1 envelopes | Exact shapes |
| `docs/11-THIRD-PARTY-INTEGRATIONS.md` | §3 (Anthropic SDK + the built-in-retry amendment), §3.4 (retry), §4 (R2 for the backup) | The AI call + backup target |
| `docs/08-AUTH-MATRIX.md` | §4 (`POST/DELETE /v1/months/:period/lock`, `POST /v1/reports/generate`), the internal-secret route | Who may trigger what |
| `docs/decisions/` | **ADR-012, 017, 022, 030, 034** + **035/036/037** (created STEP 1) | The rulings this sprint executes |
| `docs/06-IMPLEMENTATION-PLAN.md` | §16 | Sprint 13 checklist |
| `docs/12-TESTING-STRATEGY.md` | Rollover + failure-injection sections | The tests you must reproduce |

---

## CONSISTENCY RECONCILIATIONS — LOCK THESE BEFORE YOU PROMPT

1. **The materialised-view refresh is OUTSIDE the rollover transaction** (ADR-035). A refresh inside the transaction means a refresh failure rolls back a successful rollover — strictly worse than a stale dashboard. Tier 1 commits; Tier 2 refreshes after.
2. **`REFRESH MATERIALIZED VIEW CONCURRENTLY`** — requires a unique index on the view. Without `CONCURRENTLY` the refresh takes `ACCESS EXCLUSIVE` and blocks dashboard reads for its duration, contradicting NFR §3.1's "API fully operational during the rollover window." Confirm the unique index exists (STEP 1).
3. **The failure notification is written BEFORE the AI summary is attempted** (ADR-036). Templated body first, AI enrichment second. The notification must never depend on the summary succeeding — a cron whose failure notification also fails to generate is the worst case.
4. **The AI call uses the SDK's built-in retry, not a hand loop** (Sprint 8 amendment). No retry-inside-the-cron's-retry — the SDK owns backoff and `Retry-After`. On exhaustion, the templated body stays.
5. **`notify:new` is a typed delivery; the payload arrives under `payload`.** This bug has now been caught twice (`report_ready` in Sprint 11, live comments in Sprint 12) and is pinned on `useNotifySocket`. The four rollover types are types over `notify:new` — **not** `rollover:success` socket events. Do not reintroduce a bespoke event, and a consumer test must fire the **server emit**, not the handler's assumed shape.
6. **The `months` row is the idempotency key, inserted inside Tier 1** (ADR-037). Create-if-absent, skip-if-present. Because Tier 1 is atomic, "the month row exists" and "the period rows exist" commit together — so skip-if-present is trustworthy.
7. **The manual-rollover button and the cron share one idempotent endpoint** (ADR-037). Not a separate "force" path that skips the guard. Two entry points, one idempotent core.
8. **The recompute runs INSIDE Tier 1** (ADR-034/035) with the System Actor, all active clients, honouring `source='manual'`, no version bump. Retention does **not** run inside or adjacent to rollover's transaction — it is 03:00 IST monthly (ADR-030), a separate schedule with no overlap.
9. **Rollover timing is 00:01 IST = 18:31 UTC** (`31 18 * * *`, Infra §4). `TZ=Asia/Kolkata` on the API (Infra §6) — the recompute's "today" and the period math depend on it. Confirm the env before testing.
10. **The four rollover types close ADR-017's deferred list to zero.** Confirm the running count in the coverage test and drive it to **zero deferred** this sprint. Every one of the 18 enum values now has a producer.
11. **Production deploy is release-tag-gated** (Infra §3): tag → Railway deploys API + runs migrations → Vercel promotes → health check → smoke test. Do not hand-deploy; follow the pipeline.
12. **The backup restore drill uses a REAL backup** (Infra §7), not a synthetic dump. A backup never restored is a hypothesis.

---

## AUDIT + ADR ITEMS THIS SPRINT MUST HANDLE

| ID | What | Where |
|---|---|---|
| **ADR-035 (new)** | Two-tier rollover; view refresh post-commit + `CONCURRENTLY`; never rolls back rollover. | STEP 1 + 3 |
| **ADR-036 (new)** | Four notification types (deferred list → 0); templated-first, AI-enriched failure notification; idempotent manual-rollover action. | STEP 1 + 4 |
| **ADR-037 (new)** | `months`-row idempotency inside Tier 1; post-commit steps resume-not-rerun; one idempotent core. | STEP 1 + 2 + 5 |
| **ADR-017 (closed)** | All 18 notification types have producers; deferred list = 0. | STEP 4 + STEP 6 |
| **ADR-034 (inherited)** | Recompute (one function) runs inside Tier 1 with the System Actor. | STEP 3 |
| **NFR §3.1** | Rollover < 5 min, API fully operational during the window (hence `CONCURRENTLY`). | STEP 3 + STEP 10 |
| **NFR §3.2 / Infra §7** | Backup restore drill proves RTO/RPO — the launch blocker. | STEP 11 |
| **Error-Handling §7** | Failure summary model/prompt/delivery + the manual-rollover button. | STEP 4 |

If you skip the test for any of these, Sprint 13 is not done — and this is the launch, so "not done" means "do not tag production."

---

## STEP-BY-STEP STRUCTURE

| # | Type | What |
|---|---|---|
| 1 | Manual | Pre-flight — **clear the push backlog (ADR-031 staging → push 11 → push 12)**, confirm the view's unique index, confirm the report-perf number, record ADR-035/036/037, start the post-launch backlog, branch |
| 2 | Prompt | Idempotency migration — `months` row state columns if absent + the view unique index |
| 3 | Prompt | ADR-035 — the two-tier rollover transaction (Tier 1 atomic + Tier 2 post-commit refresh) |
| 4 | Prompt | ADR-036 — four notification types + templated-first AI failure summary + `[Manual rollover]` action |
| 5 | Prompt | ADR-037 — idempotency + the 3× retry policy + the shared manual/cron core |
| 6 | Prompt | Rollover tests — failure injection at every step; deferred-list-to-zero assertion |
| 7 | Prompt | Frontend — rollover notifications + the manual-rollover action + the read-only rollover window banner |
| 8 | Prompt | Hardening pass — security headers (CSP), Sentry, the final error-boundary + rate-limit sweep |
| 9 | Prompt | Full-system E2E — the month-boundary journey end to end |
| 10 | Manual + Prompt | NFR verification at scale — rollover < 5 min, API responsive during the window, k6 at 50 VUs |
| 11 | Manual | ⭐ THE PRE-LAUNCH GATE — backup restore drill, perf confirmation, instance decision, recovery-code staging check |
| 12 | Manual | Production deploy (release tag) + live smoke + post-launch backlog + close-out |

---

## SPRINT 13 — STEP 1: Pre-flight + clear the push backlog (manual)

### 1.1 — ⚠️ Clear the ADR-031 staging gate and push both sprints

Two finished sprints are held on one manual step. Clear it first — nothing in Sprint 13 should be built on top of unmerged work.

**ADR-031 staging MFA verification** (user-only, genuinely can't run locally — local Supabase won't issue a TOTP factor):
- On staging, against real Supabase: enroll a fresh admin MFA factor, verify the TOTP challenge, and confirm the server-enroll/verify branch works end-to-end.
- **In the same pass, verify recovery-code redemption end-to-end** (the Sprint 11 path) — enroll, then redeem a code to complete a session. The sole-admin-lockout case is the one you never want to discover is broken; this is the moment to prove it.
- Confirm the two intended E2E skips are the can't-run-locally perf probes, not a real regression.

Then push, in order:
```bash
git checkout main && git pull
# Sprint 11 first
git merge --ff-only sprint-11   # or open/merge its PR; CI must be green
git push origin main
# then Sprint 12
git merge --ff-only sprint-12
git push origin main
git log --oneline -5
```

```bash
pnpm install && docker compose up -d && docker compose ps
pnpm --filter @skaly/api db:status && pnpm typecheck && pnpm lint
pnpm --filter @skaly/api test && pnpm exec playwright test   # full green on main
```

**Do not proceed until both sprints are on `main` and green.** The rollover this sprint builds sits on the recompute (Sprint 12), the notification registry (Sprint 11/10), and the settings months-lock (Sprint 11).

### 1.2 — Confirm the two things the gate rulings depend on

**The materialised view's unique index** (ADR-035 needs `CONCURRENTLY`):
```bash
psql "$DATABASE_URL" -c "\d+ <dashboard_matview>" | grep -i "unique\|index"
```
If there's no unique index, STEP 2 adds one — `REFRESH … CONCURRENTLY` fails without it, and without `CONCURRENTLY` the refresh blocks dashboard reads.

**The Sprint 12 report-perf number** (Ruling 4 — confirm, don't assume):
```bash
grep -rn "p95\|p99\|test:perf" apps/api/test 2>/dev/null
```
Locate the representative-volume result. If p95 < 10s / p99 < 20s held, it's closed. **If it missed, it's a launch blocker** — flag it now; STEP 11 gates on it and STEP 8/10 may need to profile the worker.

**The `months` idempotency shape** (ADR-037):
```bash
psql "$DATABASE_URL" -c "\d months" | grep -i "rollover\|refreshed\|completed\|period"
grep -rn "internal/rollover\|rolloverService\|RolloverService" apps/api/src | grep -v test
```
Determine whether `months` already has state columns (a `rollover_completed_at` / `view_refreshed_at` or equivalent) and whether a rollover skeleton exists from earlier scaffolding. Write down what you find.

### 1.3 — Record ADR-035, 036, 037 + start the post-launch backlog (Prompt)

> **WHERE WE ARE**
>
> Sprint 13, STEP 1.3 — the final sprint. Recording the three rollover rulings and starting the post-launch backlog. **ADR series lives in `docs/decisions/`.** Read `docs/decisions/ADR-034` (the recompute this runs inside), `docs/09-ERROR-HANDLING.md` §7 (the failure summary + manual button — verbatim), `docs/13-NFRS.md` §3.1 + §3.2, `docs/10-INFRA-DEPLOYMENT.md` §4 + §7, and `docs/05-BACKEND-SCHEMA.md` (`months`, the materialised view).
>
> My STEP 1.2 census found: **[paste — view unique index, report-perf result, `months` state columns]**.
>
> **WHAT TO BUILD** — three files in `docs/decisions/`, plus `docs/POST-LAUNCH-BACKLOG.md`:
>
> **`ADR-035-rollover-atomicity.md`**
> ```
> # ADR-035 — Rollover is a two-tier transaction
> Status: Accepted • Pre-Sprint 13
> Cross-refs: NFR §3.1 (single atomic txn, <5min, API operational during window),
>             TRD §11 (matviews), ADR-034 (recompute), ADR-030 (retention is a neighbor)
>
> Context: rollover creates the next period's rows for every client and runs the
>   coming_shoot_date recompute. The dashboard materialised-view refresh can fail
>   independently and has its own notification type (rollover_view_refresh_failed).
>
> Decision — two tiers:
>   TIER 1 (atomic, all-or-nothing, one transaction):
>     period-row creation for every client + recomputeComingShootDate (System Actor,
>     all active clients, ADR-034) + the months idempotency-key row (ADR-037).
>     Either the whole next month exists or none of it does. This is what NFR §3.1 protects.
>   TIER 2 (post-commit, independently failable):
>     REFRESH MATERIALIZED VIEW CONCURRENTLY of the dashboard view. Runs AFTER Tier 1
>     commits. Its failure fires rollover_view_refresh_failed and degrades the dashboard —
>     it does NOT roll back the rollover.
>
>   Boundary proof: rollover_success/month_ready fire on Tier 1 commit; the refresh
>     outcome fires its own notification. rollover_view_refresh_failed WITHOUT a preceding
>     rollover_success means the tiers are entangled (refresh inside the txn) — that is the bug.
>
>   CONCURRENTLY requires a unique index on the view. Without CONCURRENTLY the refresh takes
>     ACCESS EXCLUSIVE and blocks dashboard reads, contradicting NFR §3.1.
>
>   Retention (ADR-030) is a temporally-separate NEIGHBOR (03:00 IST monthly), never a
>     rollover passenger — a long DELETE holding locks while rollover's txn is open is an
>     outage. The recompute is the only thing that runs inside Tier 1.
>
> Rule: a refresh failure degrading the dashboard is recoverable; a refresh failure undoing
>   a month's creation is not. Never put Tier 2 inside Tier 1.
> ```
>
> **`ADR-036-rollover-notifications.md`**
> ```
> # ADR-036 — Rollover notifications: templated-first, AI-enriched, actionable
> Status: Accepted • Pre-Sprint 13 (closes ADR-017's deferred list to zero)
> Cross-refs: ADR-017 (18 types), ERROR-HANDLING §7, THIRD-PARTY §3 (SDK retry),
>             ADR-022 (notify:new self-heal), 02-TRD §8 (typed delivery)
>
> Context: the four rollover types are the last of ADR-017's deferred six. The failure
>   summary calls Anthropic from inside a cron with no user waiting.
>
> Decision:
>   1. Four types, delivered as notify:new TYPES (not bespoke socket events; the payload
>      arrives under `payload`, pinned on useNotifySocket):
>        month_ready               -> all staff (Tier 1 commit)
>        rollover_success          -> admins    (Tier 1 commit)
>        rollover_failed           -> admins    (Tier 1 failure, with AI summary)
>        rollover_view_refresh_failed -> admins  (Tier 2 failure, with AI summary)
>      After this, all 18 enum types have producers; the coverage test's deferred list = 0.
>   2. THE FAILURE NOTIFICATION IS UNCONDITIONAL AND WRITTEN FIRST, with a templated body:
>        "Rollover for {period} failed at step {failedStep}. The previous month is intact —
>         data was not affected. A detailed summary is being generated."
>      The Claude summary (ERROR-HANDLING §7, claude-sonnet-4-6, <=400 tokens, 3-5 plain
>      sentences) then ENRICHES that row if it succeeds. The notification NEVER depends on
>      the summary — a cron whose failure notification also fails to generate is the worst case.
>   3. The AI call uses the SDK built-in retry (Sprint 8 amendment). On exhaustion the
>      templated body stays. No retry-inside-the-cron's-retry.
>   4. ACTIONABLE: the failure notification carries an inline, idempotent [Manual rollover]
>      action (ERROR-HANDLING §7, red tint). A failure summary with no recovery is a dead-end.
>
> Rule: the notification is the invariant; the summary is enrichment. Write the row, then
>   enrich it — never the reverse.
> ```
>
> **`ADR-037-rollover-idempotency.md`**
> ```
> # ADR-037 — Rollover is safe to run twice
> Status: Accepted • Pre-Sprint 13
> Cross-refs: INFRA §4 (cron + 3x retry), ERROR-HANDLING §7, ADR-035, ADR-036
>
> Context: the cron fires rollover with curl + X-Internal-Secret and retries 3x on failure.
>   A retry after a partial run must not double-create period rows.
>
> Decision:
>   1. The months row for the target period is the idempotency key: create-if-absent,
>      skip-if-present. It is inserted INSIDE Tier 1's transaction — so "the month row
>      exists" and "the period rows exist" commit together, making skip-if-present
>      trustworthy. Because Tier 1 is atomic, a failed attempt rolls back completely
>      (no months row, no period rows); the retry runs from clean state. Atomicity IS
>      most of the idempotency.
>   2. Post-commit steps (Tier 2 refresh, notifications) are guarded on months-row state
>      (rollover_completed_at / view_refreshed_at) so a retry after Tier 1 committed but
>      before notifications sent RESUMES rather than re-runs — no double month_ready,
>      no double refresh.
>   3. The [Manual rollover] button and the cron hit ONE idempotent endpoint — not a
>      separate "force" path that skips the guard. Two entry points, one idempotent core.
>      Clicking Manual rollover after a partial cron success is safe.
>
> Rule: two entry points, one idempotent core, guarded by the months row.
> ```
>
> **`docs/POST-LAUNCH-BACKLOG.md`** — seed it:
> ```
> # Post-Launch Backlog
> Items deliberately deferred out of the MVP, with their trigger conditions.
>
> - 2-year audit-log archival to R2 cold storage (NFR §5.2). Year-two concern; audit_log
>   is ~50k rows at 12 months, nowhere near a problem. Trigger: table growth / the 2-year mark.
> - Id-based mention resolution (ChatService.resolveMentions + comment mentions). Current:
>   notify-all-matches (recorded, correct). Residual-free fix: carry the composer's selected
>   staffId through send instead of re-deriving by name. Load-bearing ONLY if two ACTIVE
>   staff share a display name in production. Trigger: a real duplicate display name.
> - Socket.io Redis adapter (@socket.io/redis-adapter). Trigger: a SECOND API instance.
>   Single-instance at 50 users needs it not at all (INFRA §10 tripwire).
> - Phase 2 mobile (Expo, FCM/APNs push). Out of MVP scope entirely.
> ```
>
> Show me the three ADRs and the backlog file.

**Verify:**
```bash
ls docs/decisions/ADR-03{5,6,7}*.md docs/POST-LAUNCH-BACKLOG.md
git add docs/ && git commit -m "docs(decisions): ADR-035 rollover atomicity, 036 notifications, 037 idempotency; seed post-launch backlog"
```

### 1.4 — Branch
```bash
git checkout -b sprint-13-rollover-launch
```

**Verify gate:** both prior sprints merged + green on `main`, ADR-031 staging done (incl. recovery-code), view unique-index status known, report-perf number confirmed, three ADRs + backlog committed. Proceed.

---

## SPRINT 13 — STEP 2: Idempotency migration

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 13, STEP 2. The schema support for idempotency and the concurrent refresh. Read `docs/decisions/ADR-037` + `ADR-035`, `docs/05-BACKEND-SCHEMA.md` (`months`, the materialised view).
>
> My STEP 1.2 census: **[paste — `months` columns + the view's unique index]**.
>
> **WHAT TO BUILD** (additive only; skip any that already exist):
>
> 1. **`months` state columns** (if absent) — for resume-not-rerun (ADR-037 §2):
>    ```
>    rollover_completed_at TIMESTAMPTZ   -- set at Tier 1 commit
>    view_refreshed_at     TIMESTAMPTZ   -- set at Tier 2 success
>    rollover_failed_step  TEXT          -- set on failure, for the notification
>    ```
>    The row's *presence* is the create-if-absent key; these columns track post-commit progress.
> 2. **The materialised view's unique index** (if absent) — required for `REFRESH … CONCURRENTLY`:
>    ```sql
>    CREATE UNIQUE INDEX <view>_unique_idx ON <dashboard_matview> (<the view's natural key>);
>    ```
>    Pick the view's genuine natural key (likely `(period, client_id)` or `(period, staff_id)` depending on the view). Comment why it exists — CONCURRENTLY, not query performance.
> 3. Reverse migrations for both. Regenerate Kysely types.
>
> **RULES:** additive only (NFR §3.1). Do not alter the view's SELECT — only add the index. Comment the index's purpose so nobody drops it thinking it's redundant.
>
> Show me both migrations, then run them.

**Verify:**
```bash
pnpm --filter @skaly/api db:migrate
psql "$DATABASE_URL" -c "\d months" | grep -i rollover
psql "$DATABASE_URL" -c "REFRESH MATERIALIZED VIEW CONCURRENTLY <dashboard_matview>;"   # must succeed now
pnpm --filter @skaly/api db:rollback && pnpm --filter @skaly/api db:migrate
```

---

## SPRINT 13 — STEP 3: The two-tier rollover transaction (ADR-035)

**Goal:** The highest-stakes procedure in the product. Loud, recoverable, non-destructive.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 13, STEP 3. The rollover transaction. Read `docs/decisions/ADR-035` (follow it exactly) + `ADR-034` (the recompute) + `ADR-037` (the months key), `docs/13-NFRS.md` §3.1, `docs/02-TRD.md` §11, `docs/09-ERROR-HANDLING.md` §7, and the recompute + period-row generators from Sprints 5/7/12.
>
> **HARD CONSTRAINTS:**
> - Tier 1 (period rows + recompute + `months` insert) is **one atomic transaction**. Tier 2 (view refresh) is **post-commit**. A refresh failure must NEVER roll back Tier 1.
> - The recompute is the **existing** `recomputeComingShootDate` function (ADR-034) — call it, do not reimplement.
> - The `months` insert is the idempotency key, **inside** Tier 1 (ADR-037).
>
> **WHAT TO BUILD** — `apps/api/src/services/RolloverService.ts`, invoked by `POST /internal/rollover` (Infra §4, `X-Internal-Secret`):
>
> 1. **Guard (idempotency entry):** the target period = next month from the current `months` row. If a `months` row for the target already exists with `rollover_completed_at` set → **skip, return already-done** (ADR-037). If it exists without completion → a prior attempt reached partway; **resume** post-commit steps (STEP 5).
> 2. **Tier 1 — one transaction (`db.transaction().execute`):**
>    a. Insert the `months` row for the target period (create-if-absent).
>    b. For every **active** client: generate the period's shoot-schedule slots, pipeline row, and calendar cells — the same generators create/reactivate use.
>    c. Call `recomputeComingShootDate(clientId, targetPeriod, SYSTEM_ACTOR, trx)` for every active client.
>    d. `AuditService.log` the rollover (System Actor) inside the transaction.
>    e. Set `rollover_completed_at`.
>    f. Commit. **This commit is the boundary.**
> 3. **On Tier 1 commit:** fire `rollover_success` (admins) and `month_ready` (all) — as `notify:new` types (STEP 4).
> 4. **Tier 2 — post-commit, separate:** `REFRESH MATERIALIZED VIEW CONCURRENTLY <view>`. On success → set `view_refreshed_at`. On failure → fire `rollover_view_refresh_failed` (STEP 4) and **return success for the rollover** — the dashboard is stale, the month is intact.
> 5. **On Tier 1 failure:** the transaction rolls back (no `months` row, no period rows). Record the failed step in the notification path (STEP 4), fire `rollover_failed`, and return the failure to the cron (which will retry, STEP 5). **Never** partially commit.
> 6. **Timing:** the whole thing targets < 5 min (NFR §3.1). Tier 2's `CONCURRENTLY` keeps the dashboard readable throughout.
>
> **RULES**
>
> - Tier 2 is outside Tier 1's transaction. If you find the `REFRESH` inside `db.transaction()`, it is wrong.
> - The recompute is called, not rewritten.
> - `rollover_success` fires on commit, before Tier 2 — its presence without `rollover_view_refresh_failed` is the healthy path; the reverse pairing is impossible if the tiers are correct.
> - System Actor for every write.
>
> **Tests:**
> - Happy path: Tier 1 commits, all active clients have next-period rows, `coming_shoot_date` recomputed, `rollover_success` + `month_ready` fired, Tier 2 refreshed, `view_refreshed_at` set.
> - **⭐ Tier 2 failure does not roll back Tier 1:** inject a refresh failure → the period rows **persist**, `rollover_view_refresh_failed` fires, `rollover_success` **already** fired, the endpoint returns success.
> - **⭐ Tier 1 failure rolls back fully:** inject a mid-loop failure → **no** `months` row, **no** period rows, `rollover_failed` fired.
> - A client with a `source='manual'` `coming_shoot_date` is not overwritten (ADR-034 inherited).
> - The recompute runs with the System Actor and no version bump.
>
> Show me the guard + Tier 1 transaction first (with the commit line clearly marked), then Tier 2.

`▶ /ponytail` — the Tier 1 body is a long loop-over-clients that will sprawl. It must stay one readable transaction with an unmistakable commit line, because the commit *is* the boundary the whole ADR rests on. And the guard/resume logic should read as one decision, not scattered ifs.

**Verify:**
```bash
pnpm --filter @skaly/api test services/RolloverService
pnpm typecheck
```

---

## SPRINT 13 — STEP 4: Four notification types + AI failure summary + manual-rollover action (ADR-036)

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 13, STEP 4. Rollover notifications and the failure path. Read `docs/decisions/ADR-036` (follow it exactly), `docs/09-ERROR-HANDLING.md` §7 (the summary prompt + delivery + the `[Manual rollover]` button — verbatim), `docs/decisions/ADR-017` (the enum), `docs/11-THIRD-PARTY-INTEGRATIONS.md` §3 (the SDK retry), and `apps/api/src/services/NotificationService.ts` (the 18-type registry).
>
> **WHAT TO BUILD**
>
> 1. **Register the four types' producers** in the registry (they already have enum values + registry entries from ADR-017; wire the producers):
>    - `month_ready` → all staff, on Tier 1 commit.
>    - `rollover_success` → admins, on Tier 1 commit.
>    - `rollover_failed` → admins, on Tier 1 failure.
>    - `rollover_view_refresh_failed` → admins, on Tier 2 failure.
>    All via `notify:new` **typed** delivery — **not** `rollover:*` socket events. `linkBuilder` returns an in-app route.
> 2. **⭐ The failure notification, written FIRST with a templated body** (both failure types):
>    ```
>    "Rollover for {period} failed at step {failedStep}. The previous month is intact —
>     data was not affected. A detailed summary is being generated."
>    ```
>    Write the notification row immediately, then attempt enrichment.
> 3. **AI enrichment** (Error-Handling §7, exactly): `claude-sonnet-4-6`, `max_tokens: 400`, the §7 system prompt (calm, plain-language, non-technical, 3–5 sentences), user content = the failed step + error + attempt N of 3. Use the **SDK built-in retry** (Sprint 8 amendment). On success → **update** the notification row's body with the summary. On exhaustion → the templated body stays. **The notification never waits on or depends on the summary.**
> 4. **⭐ The `[Manual rollover]` action** — the failure notification carries an inline action (red tint, Error-Handling §7) that POSTs to the **same idempotent rollover endpoint** (STEP 5), not a force path. Admin-only.
> 5. **Failure-step tracking:** since a Tier 1 failure rolls back the `months` row, thread the `failedStep` through the service→notification path (a caught-error field), not a DB read.
>
> **RULES**
>
> - Row first, summary second. Never the reverse (ADR-036 §2).
> - SDK retry, not a hand loop; no retry-inside-retry.
> - `notify:new` types, payload under `payload`; a consumer test fires the server emit.
> - The manual action is idempotent and shares the cron's core.
>
> **Tests:**
> - **⭐ Failure notification exists even when the AI call fails:** mock Anthropic to throw past retries → the notification row exists with the **templated** body, admins received it (the worst-case guard).
> - AI success **enriches** the row (body updated to the summary).
> - All four types fire to the correct audience on the correct trigger.
> - **⭐ ADR-017 closed:** the coverage test's deferred list is now **zero** — every one of the 18 types has a producer (assert length 0).
> - The manual-rollover action hits the idempotent endpoint (STEP 5) and is admin-only.
>
> Show me the templated-first-then-enrich failure path first, then the four producers.

`▶ /ponytail` — the failure path has four inputs (Tier 1 fail, Tier 2 fail, each × AI-success/AI-fail) converging on "an admin gets a correct notification." That convergence is his; the templated-first ordering is the invariant he must not optimize away.

**Verify:**
```bash
pnpm --filter @skaly/api test services/NotificationService services/RolloverService
grep -rn "deferred" apps/api/test | grep -i notif   # the deferred assertion is now length 0
```

---

## SPRINT 13 — STEP 5: Idempotency + retry + the shared core (ADR-037)

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 13, STEP 5. Making rollover safe to run twice and wiring the retry. Read `docs/decisions/ADR-037` (follow it exactly), `docs/10-INFRA-DEPLOYMENT.md` §4 (cron + `X-Internal-Secret` + the 3× retry), and the `RolloverService` from STEP 3.
>
> **WHAT TO BUILD**
>
> 1. **The endpoint** `POST /internal/rollover` — `X-Internal-Secret` verified with a **timing-safe** compare (the B-03 discipline; a variable-time secret compare is the same bug class). Calls `RolloverService.run(targetPeriod?)`.
> 2. **The idempotent core** (ADR-037 §1–2):
>    - `months` row present + `rollover_completed_at` set → return `{ status: 'already_completed' }`, no work.
>    - `months` row absent → run Tier 1 (STEP 3).
>    - `months` row present, `rollover_completed_at` set, `view_refreshed_at` null → **resume Tier 2 only** (the refresh), don't re-run Tier 1.
>    - This resume logic is what a retry-after-partial hits.
> 3. **The retry policy** (Infra §4): the cron already retries 3× on a non-2xx. The endpoint's job is to make each retry **safe** — the idempotent core above guarantees a retry never double-creates rows or double-fires `month_ready`. Do **not** add a second retry layer in the service.
> 4. **⭐ The manual-rollover action shares this exact endpoint** (ADR-037 §3). The `[Manual rollover]` button (STEP 4) POSTs here (admin auth, not the internal secret — it's a user action). One idempotent core, two entry points (cron via secret, admin via session). Clicking it after a partial cron success resumes safely.
>
> **RULES**
>
> - Timing-safe secret compare.
> - One idempotent core; the manual button is not a separate force path.
> - No service-level retry — the cron owns retries; the endpoint owns idempotency.
>
> **Tests:**
> - **⭐ Running rollover twice creates the period rows once** — second call returns `already_completed`, row count unchanged, `month_ready` fired once (the core idempotency assertion).
> - A retry after Tier 1 committed but Tier 2 failed → the retry **resumes Tier 2 only**, refreshes the view, does not re-create rows or re-fire `month_ready`.
> - The manual action after a partial cron success is safe (same core).
> - A wrong `X-Internal-Secret` → 401/403, timing-safe.
>
> Show me the idempotent core (the three-way months-row branch) and the shared endpoint.

`▶ /ponytail` — the three-way months-row branch (absent / partial / complete) is the whole idempotency story; it should read as one decision table, not nested ifs across two functions.

**Verify:**
```bash
pnpm --filter @skaly/api test routes/internal-rollover services/RolloverService
pnpm typecheck
```

---

## SPRINT 13 — STEP 6: Rollover tests — failure injection at every step

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 13, STEP 6. The rollover test suite — this is the unattended, highest-stakes path, so it's tested against failure, not success. Read `docs/12-TESTING-STRATEGY.md`, ADRs 035/036/037.
>
> **WHAT TO BUILD** — `apps/api/test/services/Rollover.failure.test.ts` and the happy-path suite:
>
> 1. **Failure injection at each Tier 1 step:** fail during client-row generation, during the recompute, during the audit write → each rolls back **fully** (no `months` row, no partial period rows), fires `rollover_failed`, returns failure. Assert **zero** partial state after each.
> 2. **⭐ Tier 2 isolation:** Tier 1 commits, Tier 2's `REFRESH` throws → period rows persist, `rollover_success` already fired, `rollover_view_refresh_failed` fires, endpoint returns success. The dashboard is stale; the month is intact.
> 3. **⭐ Idempotency:** two sequential runs → rows created once, `month_ready` once. A resume-after-partial → Tier 2 only.
> 4. **⭐ AI-summary independence:** Anthropic throws past retries → the failure notification exists with the templated body. Anthropic succeeds → the body is enriched.
> 5. **⭐ Deferred-list-to-zero:** every one of the 18 notification types has a producer; the coverage test's deferred assertion is length 0 (ADR-017 closed).
> 6. **The manual-rollover action** hits the idempotent core and is admin-only.
> 7. **Timing sanity:** a representative rollover (20 clients) completes well under the NFR §3.1 5-min budget in the test environment.
> 8. Full API suite + typecheck + lint.
>
> **RULES:** every failure test asserts the **absence** of partial state, not just the presence of an error. This is the path where "it errored" and "it corrupted the month" look identical from the outside — the tests are the only thing that tells them apart.
>
> Show me the Tier 1 rollback tests and the Tier 2 isolation test first.

**Verify:**
```bash
pnpm --filter @skaly/api test
pnpm typecheck && pnpm lint
git add -A && git commit -m "Sprint 13: two-tier rollover (ADR-035) + four notification types + AI failure summary (ADR-036) + idempotency (ADR-037); ADR-017 closed (deferred list = 0)"
```

---

## SPRINT 13 — STEP 7: Frontend — rollover notifications + manual action + the window banner

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 13, STEP 7. The user-facing rollover surface. Read `docs/03-UIUX.md` (notification panel, the red-tinted incident notification), `docs/09-ERROR-HANDLING.md` §7 (the `[Manual rollover]` button styling), `docs/decisions/ADR-036`, and the Sprint 10 notification bell/panel.
>
> **WHAT TO BUILD**
>
> 1. **The four rollover notifications render** in the existing bell/panel (Sprint 10) — they arrive via `notify:new` (the pinned invariant; the payload is under `payload`). `month_ready` and `rollover_success` are ordinary; the two failure types are **red-tinted** incident cards showing the full summary text (no truncation, Error-Handling §7).
> 2. **⭐ The `[Manual rollover]` action** inside the failure notification — admin-only, red CTA, POSTs to the idempotent endpoint (STEP 5), shows a pending state, and on completion updates to success (or re-shows the failure). Because the core is idempotent, a double-click is safe — but disable on click anyway.
> 3. **The rollover-window read-only banner** (NFR §3.1 — "API fully operational during 00:01–00:05", but a brief informational banner is good UX): if a user is active during the window, a non-blocking amber banner "Preparing the new month — some data may update momentarily." Clears when `month_ready` arrives. This rides the same self-heal as other real-time state (ADR-022).
> 4. **Frontend tests:** the four types render (failure types red-tinted, full summary shown); the manual action POSTs and disables on click; the window banner appears and clears on `month_ready`; a failure notification with the templated body (AI failed) renders correctly (no assumption the summary is present).
>
> **RULES:** failure summaries render in full, never truncated (Error-Handling §7). The manual action is admin-only. Notifications arrive under `payload` — do not read `data` (the twice-caught bug).
>
> Show me the failure notification card (with the manual action) and the window banner.

`▶ /ponytail` — the failure card handles two states (templated vs enriched) and an action with three states (idle/pending/done). Check it derives from the notification's shape rather than carrying a tangle of local flags.

**Verify:**
```bash
pnpm --filter @skaly/web test
grep -rn "\.data\b" apps/web/src/**/notif* 2>/dev/null   # sanity: consumers read payload, not data
```

---

## SPRINT 13 — STEP 8: Hardening pass

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 13, STEP 8. The pre-launch hardening sweep. Read `docs/13-NFRS.md` §4 (security), `docs/09-ERROR-HANDLING.md` §5.2 (module error boundaries), `docs/10-INFRA-DEPLOYMENT.md` §9 (Vercel headers), and the audit's H-07 (Sentry) / H-08 (CSP) items.
>
> **WHAT TO BUILD / VERIFY**
>
> 1. **CSP (H-08)** — a Content-Security-Policy header (Vercel config + any API responses that need it). Scope `script-src`, `connect-src` (the API + WSS + Supabase + Anthropic if called client-side — it isn't), `img-src` (R2 presigned), `style-src`. Test that the app still loads with it on (CSP breaks things quietly).
> 2. **Sentry (H-07)** — error reporting wired on both API (Fastify error handler → Sentry, with the `traceId` from Error-Handling §4) and web (error boundaries → Sentry). Scrub PII per NFR §4.
> 3. **Error boundaries (Error-Handling §5.2)** — confirm every module has its own boundary (Skaly mark, "Something went wrong loading [Module]", trace ID, [Try again]); failures are isolated.
> 4. **Rate-limit sweep** — confirm the ADR-024 per-user keying is on every route class per API-Contract §2 (login 10/15min, signup 3/24hr, bot 30/min, search inherits 150/min); the internal-rollover route is secret-gated, not rate-limited.
> 5. **Secrets audit** — no secret in the client bundle (`NEXT_PUBLIC_` only for non-secrets), `CRON_SECRET` ≥ 32 chars, timing-safe compares on internal secrets.
> 6. **DOMPurify / no `dangerouslySetInnerHTML`** — the final grep across chat + comments (NFR §4.3).
>
> **RULES:** CSP on and the app still fully works — test every module with it enabled. No secret with a `NEXT_PUBLIC_` prefix.
>
> **Tests:** the app loads and every module works with CSP enabled; a thrown error in one module boundary doesn't take down others; a bad login is rate-limited; `grep` finds no `dangerouslySetInnerHTML` and no secret in the web bundle.
>
> Show me the CSP config and the Sentry wiring.

`▶ /ponytail` — the CSP directive list will accrete `unsafe-inline` escape hatches under pressure. Ask him which are truly needed (nonces beat `unsafe-inline`), because a CSP full of holes is theatre.

**Verify:**
```bash
pnpm --filter @skaly/web build && pnpm --filter @skaly/web test
curl -sD - http://localhost:3000 | grep -i content-security-policy
grep -rn "NEXT_PUBLIC_" apps/web/src | grep -iE "secret|key|token" | grep -v ANON   # expect: nothing sensitive
```

---

## SPRINT 13 — STEP 9: Full-system E2E — the month-boundary journey

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 13, STEP 9. The end-to-end month-boundary journey — the capstone E2E. Read `docs/12-TESTING-STRATEGY.md`. Reuse the Sprint 3–12 `loginAs` and config; **period fixtures via `priorIstPeriod()`**, no pinned dates (A6).
>
> **WHAT TO BUILD** — `tests/e2e/rollover.spec.ts`:
>
> 1. **Successful rollover:** trigger the internal endpoint (with the test secret) → assert the new period's rows exist across attendance/tasks/shoot/pipeline/calendar → an admin's bell shows `rollover_success`, all staff see `month_ready` → the dashboard reflects refreshed data.
> 2. **⭐ Idempotent retry:** trigger twice → rows created once, one `month_ready` (assert counts).
> 3. **⭐ View-refresh failure isolated:** (if injectable in E2E) force the refresh to fail → the month's rows still exist, `rollover_view_refresh_failed` shows, the portal is fully usable.
> 4. **⭐ Manual rollover from a failure notification:** simulate a failed rollover → an admin clicks `[Manual rollover]` in the notification → the rollover completes → the button reflects success.
> 5. **The window banner:** a user active during a simulated window sees the amber banner; it clears on `month_ready`.
> 6. **Recovery-code login** (the carried Sprint 11 path, now that staging proved enrollment): a valid code signs an admin in, consumed once.
>
> Run headed once, then headless (chromium + webkit).
>
> **RULES:** independent, re-runnable; reset the `months`/period state in teardown. Do not assert exact AI-summary prose — assert the notification exists, is red-tinted, and carries the manual action.
>
> Show me the successful-rollover spec and the idempotent-retry spec first.

**Verify:**
```bash
pnpm exec playwright test tests/e2e/rollover.spec.ts
pnpm exec playwright test      # ENTIRE suite green
```

---

## SPRINT 13 — STEP 10: NFR verification at scale

### 10.1 — The numbers (Manual + Prompt)

> **WHERE WE ARE**
>
> Sprint 13, STEP 10. The final NFR verification — measured, not asserted. Read `docs/13-NFRS.md` §1 (all budgets) + §3.1 (rollover < 5 min, API operational during the window), and the Sprint 12 report-perf harness.
>
> **WHAT TO BUILD / MEASURE**
>
> 1. **Rollover < 5 min at representative volume** — seed 20 clients + a realistic prior month; time a full rollover (Tier 1 + Tier 2). Assert < 5 min (NFR §3.1). Record Tier 1 vs Tier 2 split.
> 2. **⭐ API operational during the rollover window** — while a rollover runs, hit `/v1/health` and a couple of read endpoints; assert they respond (Tier 2's `CONCURRENTLY` is what makes the dashboard readable throughout). This is NFR §3.1's "API fully operational during 00:01–00:05."
> 3. **k6 at 50 concurrent users** (NFR §2.1) — the module read/write budgets (§1.2): GET module p95 < 300ms, PATCH < 200ms, bot TTFT < 2s, dashboard < 200ms. Run against a representative seed.
> 4. **Report perf re-confirm** (the Ruling-4 gate item) — the representative-volume p95 < 10s / p99 < 20s. If Sprint 12's number held, re-run to confirm on `main`; if it missed, this is where the worker gets profiled.
>
> **RULES:** measure on realistic data at 50 VUs. A miss is a **finding** (and a potential launch blocker), not a number to adjust.
>
> Show me the k6 script and the rollover-window responsiveness probe.

**Verify:**
```bash
k6 run tests/perf/load-50vu.js        # budgets per NFR §1.2
pnpm --filter @skaly/api test:perf rollover
```

---

## SPRINT 13 — STEP 11: ⭐ THE PRE-LAUNCH GATE (manual)

This is a gate, not a step. Each item is pass/fail. **Do not tag production until every one passes.**

### 11.1 — ⚠️ Backup restore drill (HARD BLOCKER — Infra §7, NFR §3.2)

A backup never restored is a hypothesis. Run the real drill once:
```bash
# 1. Take/locate the latest real production-shape backup in R2 (backups/{date}/)
# 2. Spin up a TEMP Postgres (Docker or a throwaway Railway db)
# 3. Restore the real dump:
gunzip -c db-backup.sql.gz | psql "$TEMP_DATABASE_URL"
# 4. VERIFY: row counts on the key tables match the source within RPO tolerance
psql "$TEMP_DATABASE_URL" -c "SELECT 'staff', count(*) FROM staff UNION ALL SELECT 'tasks', count(*) FROM tasks UNION ALL SELECT 'attendance_logs', count(*) FROM attendance_logs UNION ALL SELECT 'audit_log', count(*) FROM audit_log;"
# 5. Spot-check integrity: a known recent row is present; a materialised view refreshes
# 6. DESTROY the temp instance
```
**Pass = a real backup restored cleanly, row counts verified, within RTO < 2hr / RPO < 24hr (NFR §3.2).** This is the one item that cannot be faked — the entire disaster-recovery story is unproven until a restore has actually happened once.

### 11.2 — Report perf (BLOCKER IF MISSED — NFR §1.2)

- The STEP 10 / Sprint 12 representative-volume result: **p95 < 10s, p99 < 20s.**
- **Pass** → closed. **Miss** → launch blocker; the worker render (not the accept) is profiled and fixed before tagging.

### 11.3 — Instance count → Redis adapter decision (CONDITIONAL)

- Decide the launch instance count. At 50 users (full team, NFR §2.1), **single-instance is correct** → the Socket.io Redis adapter **stays deferred** (post-launch backlog; Infra §10 tripwire for the first second instance).
- **Pass** = the decision is made and recorded. Multi-instance launch → the adapter is a blocker; single-instance → deferred with the note.

### 11.4 — Recovery-code redemption on staging (VERIFY)

- Confirmed in STEP 1.1's staging pass: enrollment **and** a real recovery-code redemption end-to-end. The sole-admin-lockout case works.
- **Pass** = a code was actually redeemed on staging, not just generated.

### 11.5 — Production readiness sweep

```
[ ] All env vars set in Railway + Vercel (Infra §6) — TZ=Asia/Kolkata, CRON_SECRET ≥32, model strings, R2, Supabase, REDIS_URL
[ ] Model strings re-verified against GET /v1/models (they move)
[ ] CSP on and every module works (STEP 8)
[ ] Sentry receiving events from both API and web
[ ] The cron service scheduled: rollover 00:01 IST, backup 02:00 IST, attachment sweep 04:00 IST, retention 03:00 IST monthly — no overlaps
[ ] Health check green: curl https://api.skaly.in/v1/health → {"status":"ok"}
[ ] Full suite + Playwright green on main
```

**The gate passes only when 11.1–11.5 all pass.** A single fail stops the launch.

`▶ /ponytail` — before the deploy, a final review of the rollover service and the failure path specifically. This is the code that runs alone at midnight; it gets the last look.

---

## SPRINT 13 — STEP 12: Production deploy + live smoke + close-out (manual)

### 12.1 — Deploy via the release-tag pipeline (Infra §3)

Do **not** hand-deploy. Follow the pipeline:
```bash
git checkout main && git pull                      # Sprint 13 merged, CI green
git tag v1.0.0 && git push origin v1.0.0
```
Then per Infra §3:
```
1. Railway deploys API to production + runs migrations on the production DB
2. Vercel promotes the staging build to production
3. Health check: curl https://api.skaly.in/v1/health → {"status":"ok"}
4. Smoke: login, attendance load, a bot query
5. portal.skaly.in is live
```

### 12.2 — Live production smoke (real, against production)

1. **Auth:** admin login → MFA → `/home`. A team_member login (no MFA) → `/home`.
2. **Each module loads:** attendance, tasks, shoot planner, content dropper, calendar, dashboard, chat, bot.
3. **A real write round-trips:** edit an attendance cell → it persists and appears in a second session live.
4. **The bot answers** a query and **executes a confirmed mutation** (through the two-turn card).
5. **A report generates** off the event loop → `report_ready` → downloads.
6. **Notifications + presence** work across two sessions.
7. **Rollover readiness:** confirm the cron is scheduled and the endpoint is reachable (do **not** force a production rollover mid-month — verify the schedule and the secret, and let the first real rollover run at 00:01).
8. **Sentry** shows no unexpected errors from the smoke.

### 12.3 — Close-out

```
LAUNCH
  [ ] Push backlog cleared: ADR-031 staging done, Sprints 11 + 12 on main
  [ ] ADR-035/036/037 committed; POST-LAUNCH-BACKLOG.md seeded
  [ ] Idempotency + view-unique-index migrations run (additive, reversible)

ROLLOVER (ADR-035/036/037)
  [ ] Tier 1 (rows + recompute + months insert) is ONE atomic transaction; commit = boundary
  [ ] Tier 2 (view refresh) POST-COMMIT, CONCURRENTLY, never rolls back Tier 1 (TESTED)
  [ ] ⭐ Tier 1 failure rolls back FULLY — no months row, no partial rows (TESTED each step)
  [ ] Recompute called (not reimplemented), System Actor, source='manual' honoured
  [ ] Retention is a temporally-separate neighbor, never a rollover passenger
  [ ] Four notification types fire to correct audiences via notify:new (payload under `payload`)
  [ ] ⭐ Failure notification written FIRST (templated), enriched by AI — never depends on it (TESTED)
  [ ] AI summary uses SDK retry; templated body survives API-down (TESTED)
  [ ] ⭐ [Manual rollover] action — idempotent, shares the cron's core, admin-only
  [ ] ⭐ Running rollover twice creates rows ONCE, month_ready ONCE (TESTED)
  [ ] Retry-after-partial RESUMES Tier 2 only (TESTED)
  [ ] Timing-safe internal-secret compare
  [ ] ⭐ ADR-017 CLOSED — all 18 types have producers, deferred list = 0 (TESTED)

HARDENING
  [ ] CSP on; every module works with it (TESTED)
  [ ] Sentry on API + web, PII scrubbed
  [ ] Per-module error boundaries isolate failures
  [ ] Rate limits per API-Contract §2; internal-rollover secret-gated
  [ ] No secret in the web bundle; no dangerouslySetInnerHTML (grep clean)

NFRs (MEASURED)
  [ ] Rollover < 5 min at representative volume
  [ ] ⭐ API operational during the rollover window (CONCURRENTLY, TESTED)
  [ ] k6 50 VUs: module budgets met (§1.2)
  [ ] Report perf p95 < 10s / p99 < 20s

PRE-LAUNCH GATE (all pass, or no launch)
  [ ] ⭐ Backup restore drill — REAL backup restored, row counts verified (HARD BLOCKER)
  [ ] Report perf confirmed (blocker if missed)
  [ ] Instance count decided; Redis adapter deferred if single-instance
  [ ] Recovery-code redemption verified on staging

DEPLOY
  [ ] Tagged v1.0.0; deployed via the release-tag pipeline (not hand-deployed)
  [ ] Migrations run on production; health check green
  [ ] Live smoke passed; Sentry clean
  [ ] portal.skaly.in is live

  [ ] /ponytail run at each build step + a final review of the rollover service
```

### 12.4 — Ship it
```bash
# after the tag deploys and smoke passes
git checkout main && git pull
```
`portal.skaly.in` is live. The 14-week build is complete.

---

## POST-LAUNCH (from `docs/POST-LAUNCH-BACKLOG.md`)

Not this sprint — but recorded so "deferred" has a home:
- **2-year audit-log archival** to R2 cold storage (NFR §5.2) — year-two.
- **Id-based mention resolution** — carry the composer's selected `staffId` through send instead of re-deriving by name; load-bearing only if two active staff share a display name in production.
- **Socket.io Redis adapter** — the moment a second API instance is added (Infra §10).
- **Phase 2 mobile** — Expo, FCM/APNs push, offline read-only cache.
- **Monthly restore drill** — the STEP 11.1 drill becomes a recurring monthly exercise (Infra §7), not a one-off.

---

## TROUBLESHOOTING — SPRINT 13 SPECIFIC

### `REFRESH MATERIALIZED VIEW CONCURRENTLY` fails
The view has no unique index. `CONCURRENTLY` requires one (STEP 2). Without it, drop `CONCURRENTLY` only as a last resort — the plain refresh takes `ACCESS EXCLUSIVE` and blocks dashboard reads during the rollover window, breaking NFR §3.1.

### A view-refresh failure rolled back the whole rollover
The `REFRESH` is inside Tier 1's transaction. It must be **post-commit** (ADR-035). A refresh failure degrades the dashboard; it must never undo the month.

### `rollover_view_refresh_failed` fired but `rollover_success` didn't
The tiers are entangled — `rollover_success` must fire on Tier 1's commit, before Tier 2. The reverse pairing (refresh-failed without success) is impossible when the tiers are correct; if you see it, the success notification is wrongly gated on Tier 2.

### Running rollover twice created duplicate period rows
The `months` idempotency guard is missing or outside Tier 1. The row must be inserted **inside** Tier 1 (so it commits with the period rows) and checked create-if-absent at entry (ADR-037).

### The failure notification never arrived because the AI summary threw
The notification is being written *after* the summary, or *depends* on it. Write the templated row **first**, then enrich (ADR-036). The notification is the invariant; the summary is enrichment.

### Rollover notifications don't reach the frontend
They were wired as `rollover:*` socket events instead of `notify:new` types, or the consumer reads `data` instead of `payload`. This is the bug caught twice already (`report_ready`, live comments) and pinned on `useNotifySocket`. Types over `notify:new`; payload under `payload`; the consumer test fires the server emit.

### The manual-rollover button double-ran the rollover
It hit a separate "force" path instead of the shared idempotent core, or wasn't disabled on click. One endpoint, idempotent; the button disables on click as belt-and-braces (ADR-037).

### An admin's manual `coming_shoot_date` got wiped at rollover
The recompute inside Tier 1 isn't the shared ADR-034 function, or the cron path lost the `source='manual'` guard. One function, called by both trigger and rollover, guard inside it.

### CSP broke the app after deploy
A directive is too strict (usually `connect-src` missing the WSS or Supabase origin, or `script-src` missing a nonce). Test every module with CSP on **before** tagging (STEP 8) — CSP fails quietly.

### The backup restore drill "passed" but nobody restored a real backup
Then it didn't pass. A synthetic dump proves the restore command's syntax, not that the production backup is valid. Use a **real** R2 backup (STEP 11.1) — this is the one gate item that cannot be faked.

---

## END OF SPRINT 13 DETAILED GUIDE — END OF BUILD

*Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1..12-DETAILED.md`. Source-of-truth precedence when documents differ: the numbered spec docs (`01`–`14`) + the schema win, then this guide's reconciliations and the decisions it executes (in `docs/decisions/`, ADR-006–037), then the Master Build Guide's shorthand. This is the final sprint and the launch. Rollover is the highest-stakes transaction in the product because it runs unattended at midnight and its failure is discovered by the business owner the next morning — so every decision here favours a loud, recoverable, non-destructive failure over an elegant success: the two-tier boundary keeps a dashboard-refresh failure from undoing a month, the templated-first notification keeps a failed AI summary from swallowing the incident, and the idempotency keeps a retry from doubling the month. The pre-launch gate is a gate, not a checklist item — and its one unfakeable line is the backup restore drill, because a backup you have never restored is a hypothesis. When 11.1–11.5 pass and the release tag deploys clean, `portal.skaly.in` is live and the fourteen-week build is done. The last of ADR-017's eighteen notification types now has a producer; there is nothing deferred that isn't written down in the post-launch backlog. Ship it.*
