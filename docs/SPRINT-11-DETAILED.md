# SPRINT 11 — SETTINGS + REPORTS: DETAILED PROMPT-BY-PROMPT GUIDE

## Scaly Business Portal • Sprint 11 of 13

**Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1..10-DETAILED.md` + `SPRINT-8_1` / `SPRINT-10_1` patches**
**Same Goal / Prompt / Verify framework as Sprints 0–10**
**Tooling interfaces verified as of July 2026** — `@react-pdf/renderer` (`renderToBuffer` / `renderToStream`, `Font.register`, `StyleSheet.create`), Node `worker_threads`, Kysely `.stream()` (**requires `pg-query-stream`**), `csv-stringify` (streaming transform), Fastify 5 (stream responses, `trustProxy`), `@aws-sdk/client-s3` + `s3-request-presigner`, TanStack Query v5 + Table v8 + Virtual, shadcn/ui (`table`, `tabs`, `switch`, `dialog`, `alert-dialog`, `select`, `popover`), Next.js 15 App Router, Framer Motion 11, Playwright latest.

> **Risk note:** Sprint 11 is the widest sprint by surface area — seven settings panels plus reports — but most of it is CRUD over services that already exist. The two genuinely hard parts are **off-loop PDF rendering** (STEP 6: the first CPU-bound work on the API server) and **streaming export** (STEP 5: the first unbounded response). Everything else is breadth, not depth. Budget accordingly: do not let seven easy panels eat the two hard days.


> **⚠️ ADR NUMBERING CORRECTED.** This guide's cross-refs ran **three low**. The five
> ADRs it creates were numbered 023–027 and are **026** (re-onboarding), **027**
> (report-generation), **028** (audit-export-streaming), **029** (permission-change-push)
> and **030** (message-retention-fk) in `docs/decisions/`. Its inherited references
> shifted too: 017→**020**, 018→**021**, 019→**022**, 021→**024** (rate-limit keying),
> 022→**025** (subscription ordering).
>
> `ADR-031` (recovery codes) was ALREADY correct and is deliberately unchanged, as are
> 007, 011, 012, 014 and 015 — checked one by one rather than shifted wholesale.

---

## USING THE `/ponytail` PLUGIN IN THIS SPRINT

Placement as established in Sprint 9: **between the build prompt and the test prompt** — on the implementation, before anything is written against its shape. Absent from manual steps, ADR authoring, migrations, and branch creation.

**Where he earns his keep this sprint:** the seven settings panels (STEPS 9–11 — they will be seven copies of the same table-plus-dialog and should mostly be one), the permission toggle matrix (STEP 10 — a grid of booleans that will want to become a grid of components), the CSV serialiser (STEP 5), and the report worker's message protocol (STEP 6). Seven near-identical panels is the single largest compressible surface in the whole build; give him room there.

---

## WHAT YOU'RE BUILDING IN SPRINT 11

The operational portal is complete. Sprint 11 gives admins the controls, and everyone the reports. By the end of this week:

- **The five pre-Sprint-11 decisions are recorded** as **ADR-026** (re-onboarding), **ADR-027** (async off-loop reports), **ADR-028** (streaming export), **ADR-029** (permission push), **ADR-030** (message-retention FK — recorded now, built Sprint 12).
- **Audit finding A4 is fixed** — an offboarded employee can be re-hired. Today the signup-approval path finds the soft-deleted row, rejects with *"Account already exists at approval time"*, and that sentence is untrue: the account does not exist, it was deleted. Sprint 11 makes approval **detect and offer reinstatement**, and adds the partial unique index that migration 030 already established as the house pattern for soft-delete + uniqueness.
- **Clients can be reactivated** — the one-way destructive action gets its undo, reusing `create`'s existing three-way period backfill.
- **Reports generate without blocking the API** — 202 + `reportId`, rendered off the event loop, delivered via `report_ready` + a 24h presigned link. `report_ready` is the first of Sprint 10's six deferred notification types to get a real producer.
- **The audit log exports by streaming CSV** — no buffered 50k-row response on the same instance that is now also rendering PDFs.
- **All seven settings panels work**: Staff, Clients, Permissions, Signup Requests, Holidays, Months, Audit Log — each gated exactly as Auth-Matrix §3 specifies.
- **Permission changes push** — `permission_changed` → the affected user's UI re-derives, riding 10.1's self-healing mechanism. The backend's per-request invalidation remains the enforcement boundary; the push is UX.
- **⭐ The recovery-code redeem path finally exists** — carried since Sprint 8 STEP 8.4. Codes have been generated and stored for three sprints with no way to spend them, while MFA is mandatory for admin and manager. Sprint 11 closes it, next to its counterpart (admin MFA reset) in the same sprint.

**Estimated time:** 5 working days (Week 12 per `06-IMPLEMENTATION-PLAN.md` §14; owners TL + D1 + D2). Day 1 pre-flight + migration + re-onboarding; day 2 settings backend + permission push; day 3 audit export + reports (the two hard ones); day 4 recovery codes + settings frontend; day 5 remaining panels + E2E + close-out.

**Prerequisites — the gate is wider than usual this sprint:**

- **⚠️ The A1 hotfix is deployed** — `trustProxy: true` **and** a `staffId`-keyed `keyGenerator` with IP fallback (ADR-024). Without it the entire organisation shares one 150 req/min bucket, and Sprint 11 adds the most request-heavy screens in the product (seven panels, each polling lists). Sprint 11 will *look* broken without it, in exactly the misleading way the audit documented.
- **⚠️ Sprint 10.1 has landed and Sprint 10 is merged.** 10.1 fixes A2 (a missed realtime event is permanent on every surface, because the global query config has no self-healing path — ADR-025 subscribe-before-fetch with in-flight replay) and A3 (E2E results untrustworthy because the raised rate limit silently reverted). Sprint 11's permission push (ADR-029) has the identical "what if the event is missed" property and **rides A2's mechanism** — building it first would mean building the same fix twice.
- Sprint 10's chat, notifications, presence, and grid subscriptions green; all `// TODO(Sprint 10)` markers gone.
- `PermissionService` the single resolver (8.1); `ClientService.create` + `deactivate` (Sprint 9); `AuditService` writing on every mutation; `NotificationService` with the 18-type registry (ADR-020).
- R2 client configured with the named expiry constants (`UPLOAD_EXPIRY_SECONDS` 900, `DOWNLOAD_EXPIRY_SECONDS` 3600, `REPORT_EXPIRY_SECONDS` 86400).
- `pnpm typecheck`, `pnpm lint`, and the full suite green on `main`.

---

## THE PRE-SPRINT-11 DECISIONS — WHERE THEY LAND

| Decision | Ruling | Executed in |
|---|---|---|
| **Client + staff re-onboarding** | Soft-deleted identity entities are re-onboardable. Clients → reactivate (no migration). Staff → reinstate + partial unique index (fixes **A4**). One principle, two levels. → **ADR-026** | STEP 1 (record) + STEP 2 + STEP 3 |
| **↳ Approval detects, not rejects** | The signup-approval path must surface *"previously employed — reinstate?"* rather than rejecting with a false statement. | STEP 3 |
| **↳ `reactivate_client` bot tool** | A bot that can destroy but not undo is a footgun. Thin wrapper through the ADR-014 confirmation machine. | STEP 3 |
| **↳ No new notification enum value for client reactivation** | Admins do it and see the result immediately. The enum stays at 18 (ADR-020). | STEP 3 |
| **Reports: async + off the event loop** | 202 + `reportId`; render in a worker; `report_ready` + 24h presigned link; persisted record; documented concurrency cap. **202 alone is the trap** — it moves *when* the block happens, not *whether*. → **ADR-027** | STEP 1 (record) + STEP 2 + STEP 6 |
| **Audit export streams CSV** | Cursor-based, no buffered response, safe because `audit_log` is append-only at the DB role level. → **ADR-028** | STEP 1 (record) + STEP 5 |
| **Permission change pushes** | `permission_changed` → refetch `/v1/staff/me` → re-derive nav. **UX layer only** — backend per-request invalidation stays the boundary. Rides ADR-025's self-healing path. → **ADR-029** | STEP 1 (record) + STEP 4 |
| **Message retention FK** | Keep `NO ACTION`; the Sprint 12 job is session-scoped and single-statement, bounded by `bot_sessions.last_activity_at`. **Recorded now, built Sprint 12.** → **ADR-030** | STEP 1 (record only) |
| **Recovery-code redeem path** | No longer deferred. Built this sprint, beside admin MFA reset. | STEP 8 |

---

## READ FIRST (Open in Antigravity Split View)

| Doc | Sections | Why |
|---|---|---|
| `docs/08-AUTH-MATRIX.md` | **§3 (all seven `/settings/*` rows)**, **§4 (Settings & Admin endpoint map)**, §5 (bot tool defaults — what the Permissions UI toggles), §6 (override precedence + key naming + the Redis cache), §10 (MFA enforcement + recovery codes) | The access spec for every panel |
| `docs/07-API-CONTRACT.md` | Settings endpoints, `POST /v1/reports/generate`, `GET /v1/audit-log`, §1.1 envelopes, §2 rate limits | Exact shapes |
| `docs/05-BACKEND-SCHEMA.md` | `staff` (**`staff_email_unique` — the A4 defect**), `user_permissions`, `months`, `audit_log`, `signup_requests` (**`rejection_note` — never transmitted**), migration 030 (the partial-index precedent) | Column truth |
| `docs/03-UIUX.md` | Settings layout + panel patterns, tables, toggles, the audit log view, report cards | Every visual rule |
| `docs/04-APPFLOW.md` | Signup approval/rejection, month lock/unlock, permission toggle, report generation + delivery | Every interaction |
| `docs/13-NFRS.md` | **§1.2 (reports p95 < 10s / p99 < 20s)**, §2.2 (~50k audit rows), §3.1 (**"additive changes only"** — read before STEP 2), §4.2 (audit append-only, CV access), §5.1–5.3 (retention, audit requirements) | The numbers and the constraints |
| `docs/09-ERROR-HANDLING.md` | §2 — `UNLOCK_REASON_REQUIRED`, `ALREADY_PROCESSED`, `INVALID_ROLE`, `MFA_LOCKED`, `PERIOD_LOCKED` | The codes these panels throw |
| `docs/11-THIRD-PARTY-INTEGRATIONS.md` | §2.2 (`inviteUserByEmail`, `admin.createUser`, `signOut`), §2.3 (MFA enroll/verify), §4.3 (**`REPORT_EXPIRY_SECONDS` = 24h**) | Supabase + R2 call shapes |
| `docs/10-INFRA-DEPLOYMENT.md` | §4 (**`healthcheckTimeout = 30`** — why PDFs must leave the event loop), §6 (env vars) | The constraint behind ADR-027 |
| `docs/06-IMPLEMENTATION-PLAN.md` | §14 | Sprint 11 checklist |
| `docs/adr/` | **ADR-011, 014, 017, 021, 022**, + **023–027** (created STEP 1) | The rulings this sprint must not violate |

---

## CONSISTENCY RECONCILIATIONS — LOCK THESE BEFORE YOU PROMPT

1. **`PUT /v1/staff/:id/reactivate` is already in Auth-Matrix §4.** Staff reactivation was always specified — it was simply never built, and the A4 defect is that the *signup-approval* path can't reach a soft-deleted row's email. Do not invent a new endpoint; build the one the matrix already names.
2. **A4's real bug is a false message, not a crash.** Approval pre-checks by email with no `deleted_at` filter, finds the soft-deleted row, and marks the request `rejected` with *"Account already exists at approval time"*. It does not 500 (verified in the audit). The fix is product behaviour — detect and offer reinstatement — plus the partial index. Fixing only the index leaves the misleading rejection in place.
3. **The partial index is non-additive but non-breaking.** NFR §3.1 says "additive changes only in MVP". Dropping `staff_email_unique` and recreating it as a partial index **relaxes** a constraint: no existing row can violate the new index that did not violate the old. It is safe without a maintenance window. Say so in the migration comment so nobody blocks on §3.1 or, worse, treats a weaker constraint as a breaking change.
4. **Reinstatement must check for a live row first.** Once the index is partial, a soft-deleted row and an active row can share an email. Reinstating a soft-deleted row whose email is now held by an *active* row would violate the partial index — check and return a clear conflict rather than letting Postgres throw.
5. **202 is not the fix for PDF blocking.** Returning early while `@react-pdf/renderer` still renders synchronously on the same event loop moves *when* the block happens, not *whether*. The render must leave the main thread (`worker_threads` or a separate service). ADR-027 is about the execution model; the 202 is just its contract.
6. **`rejection_note` is never transmitted** (NFR §4.2). It is stored, admin-visible in the settings panel, and must never appear in any API response reaching the rejected user. This is the one field in the whole sprint with an explicit non-transmission rule.
7. **`audit_log` is append-only at the DB role level** (`REVOKE UPDATE, DELETE`, NFR §4.2). No settings panel may offer edit or delete, and the export is safe to stream precisely because rows are immutable.
8. **`GET /v1/audit-log` is admin-only** and stays that way. The role-filtered `/v1/activity-feed` (Sprint 9) is the everyone-else surface. Do not merge them; the separation is a canonical requirement (PRD FR-SET-07 / APPFLOW §3).
9. **Kysely `.stream()` requires `pg-query-stream`.** Without it you get a runtime error, not a type error. Install it explicitly in STEP 5.
10. **CSV escaping is not optional here.** `audit_log.old_value` / `new_value` are JSONB — they contain commas, quotes, and newlines by construction. Hand-rolled `join(',')` produces a corrupt file that opens fine in a text editor and wrongly in Excel. Use a real serialiser.
11. **Permission keys follow Auth-Matrix §6.2 naming** — `bot.tool.{name}`, `module.{module}.read|write`, `chat.access`, `report.generate`, `months.unlock`. The Permissions UI must build keys from that convention, never from free text.
12. **Frontend path `apps/web/app/(portal)/settings/`** (no `src/`), matching Sprints 3–10.
13. **Manager sees Staff read-only** (Auth-Matrix §3: `👁 limited`), and has **no** access to Permissions, Signup Requests, Months, or Audit Log. Four of the seven panels are admin-only; the sidebar must not render them for a manager.

---

## AUDIT + ADR ITEMS THIS SPRINT MUST HANDLE

| ID | What | Where |
|---|---|---|
| **A4 (Sprint 10 audit)** | Offboarded employee can never be re-hired; approval rejects with a false reason. | STEP 2 + STEP 3 |
| **ADR-026 (new)** | Re-onboarding principle; partial index on soft-deletable identity columns. | STEP 1 + 2 + 3 |
| **ADR-027 (new)** | Reports async + off the event loop + persisted record + concurrency cap. | STEP 1 + 2 + 6 |
| **ADR-028 (new)** | Streaming CSV export via cursor. | STEP 1 + 5 |
| **ADR-029 (new)** | `permission_changed` push as a UX layer over per-request invalidation. | STEP 1 + 4 |
| **ADR-030 (new)** | Message retention FK stays `NO ACTION`; job session-scoped + single-statement. **Recorded only.** | STEP 1 |
| **Recovery codes** | Redeem path, carried since Sprint 8 STEP 8.4. | STEP 8 |
| **NFR §1.2** | Reports p95 < 10s / p99 < 20s, **measured**, and the API stays responsive throughout. | STEP 6 + 13 |
| **NFR §4.2** | `rejection_note` never transmitted; audit log immutable in the UI. | STEP 4 + 11 |

If you skip the test for any of these, Sprint 11 is not done.

---

## STEP-BY-STEP STRUCTURE

| # | Type | What |
|---|---|---|
| 1 | Manual | Pre-flight — **verify the A1 hotfix + 10.1 + Sprint 10 merged**, discover the `reports` table, record ADR-026..027, branch |
| 2 | Prompt | Migrations — partial unique index on `staff.email` (A4), `reports` table if absent |
| 3 | Prompt | ADR-026 — client reactivate, staff reinstate, approval detection, `reactivate_client` tool |
| 4 | Prompt | Settings backend — staff admin ops, permissions toggle + **ADR-029 push**, months lock/unlock |
| 5 | Prompt | ADR-028 — audit log query + streaming CSV export |
| 6 | Prompt | ADR-027 — report generation off the event loop + `report_ready` |
| 7 | Prompt | Backend tests |
| 8 | Prompt | ⭐ Recovery-code redeem path |
| 9 | Prompt | Frontend — settings shell + Staff + Clients |
| 10 | Prompt | Frontend — Permissions + Signup Requests + Holidays + Months |
| 11 | Prompt | Frontend — Audit Log (filter + streamed export) + Reports |
| 12 | Manual + Prompt | Playwright E2E |
| 13 | Manual | Smoke + NFR measurement + commit + close-out |

---

## SPRINT 11 — STEP 1: Pre-flight (manual)

### 1.1 — ⚠️ Verify the gate: A1 hotfix, 10.1, and Sprint 10 merged

Sprint 10 was deliberately held at close-out. All three must be true before Sprint 11 code:

```bash
git checkout main && git pull
git log --oneline -20 | grep -i "sprint 10\|10.1\|trustproxy\|rate.limit"
```

**A1 — the deploy blocker (ADR-024):**
```bash
grep -rn "trustProxy" apps/api/src            # expect: trustProxy: true on the Fastify instance
grep -rn "keyGenerator" apps/api/src          # expect: staffId-keyed, IP fallback
curl -sD - -o /dev/null http://localhost:3001/v1/health | grep -i x-ratelimit
```
Both must be present. `trustProxy` alone still lets one office NAT share a bucket; the keyGenerator alone can't see the real client IP for unauthenticated routes. Sprint 11 adds the most request-heavy screens in the product — without this, it will look broken in the misleading way the audit documented.

**A2/A3 — Sprint 10.1 (ADR-025):**
```bash
grep -rn "refetchOnReconnect\|refetchOnMount\|subscribe.*before.*fetch\|replayBuffer" apps/web/src
ls docs/adr/ADR-025*.md
grep -rn "x-ratelimit" tests/e2e/global-setup* playwright.config.ts   # A3's environment assertion
```
Sprint 11's permission push (ADR-029) rides A2's self-healing mechanism. If 10.1 hasn't landed, you would build the same fix twice.

```bash
pnpm install && docker compose up -d
pnpm --filter @skaly/api db:status            # 0 pending
pnpm typecheck && pnpm lint && pnpm --filter @skaly/api test
pnpm exec playwright test                     # green, and trustworthy now that A3 asserts the env
```

**Do not proceed on a red gate.** Everything in Sprint 11 sits on top of it.

### 1.2 — Discover what already exists (scopes STEPS 2, 3, 4, 6, 8)

```bash
# A4 — the constraint
psql "$DATABASE_URL" -c "\d staff" | grep -i -A2 "unique\|email"

# does a reports table exist? (ADR-027 needs a persisted record)
psql "$DATABASE_URL" -c "\dt" | grep -i report || echo "NO reports table — STEP 2 adds one"

# which settings endpoints already exist from earlier sprints?
grep -rn "signup-requests\|/staff/:id/deactivate\|/staff/:id/reactivate\|permissions/:key\|mfa/reset\|months/.*lock" apps/api/src/routes

# recovery codes — stored in Sprint 8, never redeemable
grep -rn "recovery_code\|recoveryCode" apps/api/src | grep -v test

# the client reactivate gap
grep -rn "reactivate" apps/api/src/services/ClientService.ts || echo "NO client reactivate — STEP 3"
```

Write down what you find. Several Sprint-11 endpoints were partially built in Sprints 1–2 (signup approval, staff deactivate); the prompts below say "build or complete", and which one it is depends on this census.

### 1.3 — Record ADR-026 … ADR-030 (Prompt)

> **WHERE WE ARE**
>
> Sprint 11, STEP 1.3. Recording the five pre-Sprint-11 rulings. Read `docs/adr/ADR-025` for the house format, plus `docs/08-AUTH-MATRIX.md` §4, `docs/13-NFRS.md` §1.2 + §3.1, `docs/10-INFRA-DEPLOYMENT.md` §4, and `docs/05-BACKEND-SCHEMA.md` (`staff`, `messages`, migration 030).
>
> My STEP 1.2 census found: **[paste it]**.
>
> **WHAT TO BUILD** — five files in `docs/adr/`:
>
> **`ADR-026-re-onboarding.md`**
> ```
> # ADR-026 — Soft-deleted identity entities are re-onboardable
> Status: Accepted • Pre-Sprint 11 (fixes Sprint 10 audit A4)
> Cross-refs: 05-BACKEND-SCHEMA (staff, clients, migration 030), AUTH-MATRIX §4, ADR-014
>
> Context: ClientService.deactivate is one-way — no reactivate anywhere. Separately (audit
>   A4), staff_email_unique is UNIQUE(email) with no partial predicate, so a soft-deleted
>   staffer's email still occupies the constraint. The signup-approval path pre-checks by
>   email without a deleted_at filter, finds the dead row, and marks the request rejected
>   with "Account already exists at approval time". It does not crash — but the account does
>   NOT exist, it was deleted. The outcome is wrong and the message is untrue.
>
> Decision — one principle, two levels:
>   1. A unique constraint on a soft-deletable identity column MUST be partial
>      (WHERE deleted_at IS NULL). Migration 030 already established this for holidays;
>      staff is the remaining case. Verified: no other table pairs soft-delete with a
>      non-partial unique index.
>   2. CLIENTS — reactivate(id): clear deleted_at, set active, run the SAME current-period
>      three-way backfill create() runs (slots + pipeline + calendar), audit it.
>      No migration: clients has soft-delete but no colliding unique constraint.
>   3. STAFF — reinstate the ORIGINAL row rather than creating a duplicate, preserving
>      history and the audit trail. PUT /v1/staff/:id/reactivate is ALREADY specified in
>      AUTH-MATRIX §4 — it was never built, not never designed.
>   4. APPROVAL DETECTS, DOES NOT REJECT. When approval finds a soft-deleted staff row for
>      that email, it surfaces "previously employed — reinstate?" to the admin. Fixing only
>      the index would leave the false rejection in place.
>   5. Reinstatement checks for a LIVE row with that email first. Once the index is partial,
>      a dead row and a live row can share an email; reinstating into that collision must
>      return a clear conflict, not a Postgres error.
>   6. Bot parity: add reactivate_client through the ADR-014 confirmation machine. A bot
>      that can destroy but not undo is its own footgun.
>   7. NO new notification enum value for client reactivation — admins act and see the
>      result immediately. The enum stays at 18 (ADR-020). account_reactivated already
>      covers the staff case.
>
> Rule: soft delete means recoverable. If a delete is soft, some path must undo it.
> ```
>
> **`ADR-027-report-generation.md`**
> ```
> # ADR-027 — Report generation is asynchronous AND off the event loop
> Status: Accepted • Pre-Sprint 11
> Cross-refs: NFR §1.2, INFRA §4 (healthcheckTimeout = 30), THIRD-PARTY §4.3
>             (REPORT_EXPIRY_SECONDS = 86400), ADR-020 (report_ready)
>
> Context: @react-pdf/renderer renders SYNCHRONOUSLY on the event loop. A 10-15s render on
>   the single Railway instance blocks every other request, including the health check.
>
> Decision — the async contract AND off-loop execution. Both. Either alone fails:
>   1. POST /v1/reports/generate validates, persists a report record (status 'pending'),
>      returns 202 + reportId. No PDF in the response.
>   2. THE RENDER LEAVES THE MAIN THREAD — worker_threads, or a separate worker service
>      (the cron service already establishes that pattern). Returning 202 while still
>      rendering on the request loop moves WHEN the block happens, not WHETHER. This is
>      the trap, and it looks correct in code review.
>   3. Worker renders -> uploads to R2 -> marks the record 'ready' -> fires report_ready
>      carrying a presigned GET link at REPORT_EXPIRY_SECONDS (24h — chosen precisely so
>      "notification links survive a full working day").
>   4. The persisted record lets the link be regenerated within 24h without re-rendering,
>      and makes failure a 'failed' row plus a notification rather than a lost request.
>   5. Documented concurrency cap (small pool), so five month-end requests do not spawn
>      five CPU-heavy renders on one instance.
>
> Rule: no synchronous CPU-bound work on the request event loop. Ever. This is the first
>   such work in the product and it sets the precedent for every later one.
> ```
>
> **`ADR-028-audit-export-streaming.md`**
> ```
> # ADR-028 — Audit log export streams CSV via cursor
> Status: Accepted • Pre-Sprint 11
> Cross-refs: NFR §2.2 (~50k rows at 12mo), §4.2 (append-only), §5.3, ADR-027
>
> Decision: export streams — Kysely .stream() (requires pg-query-stream) -> CSV transform
>   -> chunked response. No buffered array, no Content-Length, no memory ceiling.
>   Safe to stream because audit_log is append-only at the DB role level
>   (REVOKE UPDATE, DELETE) — rows are immutable, so a long-running cursor cannot observe
>   a mutating row.
>   One WHERE clause feeds two sinks: paginated JSON on screen, streamed CSV on export.
>   CSV escaping uses a real serialiser — old_value/new_value are JSONB and contain commas,
>   quotes and newlines by construction.
>
> Rule: a response whose size is a function of data volume streams. It is less code than
>   paginating an export, not more.
> ```
>
> **`ADR-029-permission-change-push.md`**
> ```
> # ADR-029 — Permission changes push to the affected session (UX layer only)
> Status: Accepted • Pre-Sprint 11 (completes 8.1 STEP 3.4's deferral)
> Cross-refs: AUTH-MATRIX §6.3, ADR-025, 8.1 STEP 3.4
>
> Context: perms:{staffId} has a 5-min TTL AND invalidation-on-write. Enforcement is
>   already correct and immediate — the key is deleted on write, so the user's NEXT request
>   re-loads fresh. There is no window in which a revoked permission still works.
>   What is missing is UX for an IDLE session: a newly granted module does not appear in the
>   sidebar until they navigate; a revoked one stays visible until they act (and then
>   correctly 403s, having offered something that failed).
>
> Decision: on any user_permissions write, emit permission_changed to that staffId's room;
>   the client refetches /v1/staff/me and re-derives nav and access.
>
>   THE PUSH IS AN ENHANCEMENT, NOT THE BOUNDARY. If it is missed (client offline — see
>   audit A2), the user stays visually stale until their next request, where the backend
>   re-checks and corrects. Fail-safe by construction. Enforcement remains server-side and
>   per-request.
>
>   Because it has the identical "what if the event is missed" property, this push rides
>   ADR-025's self-healing mechanism rather than adding its own.
>
> Rule: never move an enforcement decision onto a delivery channel that can drop messages.
> ```
>
> **`ADR-030-message-retention-fk.md`**
> ```
> # ADR-030 — messages.parent_id keeps ON DELETE NO ACTION
> Status: Accepted • Pre-Sprint 11 (RECORDED NOW, BUILT SPRINT 12)
> Cross-refs: NFR §5.2 (12-month retention), ADR-021, 05-BACKEND-SCHEMA (messages)
>
> Context: messages_parent_id_fkey has no ON DELETE action, so it defaults to NO ACTION.
>   Nothing hard-deletes messages today; NFR §5.2's retention job will.
>
> The Postgres detail that decides it, and it is counterintuitive:
>   NO ACTION is NOT RESTRICT. NO ACTION defers its check to the END of the statement;
>   RESTRICT fires per row, immediately. So a single
>     DELETE FROM messages WHERE id IN (parent, child1, child2)
>   SUCCEEDS today under NO ACTION — the children are already gone when the check runs —
>   and would FAIL under RESTRICT. "Hardening" the FK to RESTRICT would BREAK the job.
>   What fails today is two statements, or parent-first ordering.
>
> Decision:
>   1. Keep NO ACTION. Comment the migration with the reason so nobody "upgrades" it.
>   2. ON DELETE SET NULL is ruled out — it re-orphans bot replies, the exact bug ADR-021
>      exists to fix.
>   3. ON DELETE CASCADE is ruled out for chat — parent_id doubles as the thread link, so
>      one hard-deleted parent could silently remove replies still inside their own
>      retention window. That is data loss introduced to solve an ordering problem.
>   4. The Sprint 12 job is SESSION-SCOPED and SINGLE-STATEMENT. Session scoping is not
>      merely so a turn-pair is not split — it is WHAT GUARANTEES the single-statement
>      property, which is the only reason NO ACTION lets the delete through. Delete a whole
>      conversation as one IN-list, bounded by bot_sessions.last_activity_at (ADR-021 §4).
>      This is where bot_sessions earns its keep beyond bookkeeping.
>   5. Chat threads have no session envelope: a reply deletes on age alone (deleting a child
>      never violates the FK), but a parent deletes only when its NEWEST reply is also past
>      the cutoff and goes in the same statement.
>   6. Test from the teardown's fix — Sprint 9's teardowns already demonstrated the failure.
>      Seed a parent and child straddling the cutoff; assert the job neither errors nor
>      splits the pair.
>
> Rule: retention deletes whole conversations, never halves of turns.
> ```
>
> Show me all five.

**Verify:**

```bash
ls docs/adr/ADR-02{3,4,5,6,7}*.md
git add docs/adr/ && git commit -m "docs(adr): ADR-026 re-onboarding, 024 async reports, 025 streaming export, 026 permission push, 027 message retention FK"
```

### 1.4 — Branch

```bash
git checkout -b sprint-11-settings-reports
```

**Verify gate:** A1 hotfix deployed, 10.1 landed, Sprint 10 merged, full suite green, census complete, five ADRs committed. Proceed.

---

## SPRINT 11 — STEP 2: Migrations

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 11, STEP 2. Two migrations. Read `docs/adr/ADR-026` and `ADR-027`, `docs/05-BACKEND-SCHEMA.md` (`staff`, **migration 030** — the partial-index precedent for `holidays`), and `docs/13-NFRS.md` §3.1.
>
> My STEP 1.2 census found: **[paste — especially whether a `reports` table exists]**.
>
> **WHAT TO BUILD**
>
> 1. **`0NN_staff_email_partial_unique.ts`** — fixes audit A4:
>    ```sql
>    ALTER TABLE staff DROP CONSTRAINT staff_email_unique;
>    CREATE UNIQUE INDEX staff_email_unique ON staff(email) WHERE deleted_at IS NULL;
>    ```
>    **Comment the migration** with: this is non-additive but **non-breaking** — it *relaxes* a constraint, so no existing row can violate the new index that did not violate the old. NFR §3.1's "additive changes only" is about breaking changes; this needs no maintenance window. Write that down so nobody blocks on §3.1 later.
>    Mirror migration 030's approach exactly. Include the reverse migration (recreate the full constraint), and note in it that reversing will fail if duplicate emails exist among soft-deleted rows by then.
>
> 2. **`0NN_reports.ts`** — only if STEP 1.2 found no `reports` table:
>    ```
>    id            UUID PK default gen_random_uuid()
>    type          VARCHAR(30)  NOT NULL     -- per API-Contract's report types
>    period        CHAR(7)      NOT NULL
>    status        VARCHAR(10)  NOT NULL DEFAULT 'pending'  -- pending|ready|failed
>    r2_key        TEXT                       -- set on success
>    error_message TEXT                       -- set on failure
>    requested_by  UUID NOT NULL REFERENCES staff(id)
>    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
>    completed_at  TIMESTAMPTZ
>    CHECK (status IN ('pending','ready','failed'))
>    INDEX on (requested_by, created_at DESC)
>    ```
>    Plus `GRANT SELECT, INSERT, UPDATE ON reports TO skaly_app;` in the grants migration, matching the house pattern.
>
> 3. Regenerate Kysely types.
>
> **RULES**
>
> - Every forward migration gets a reverse (Infra §5).
> - Do not touch `messages_parent_id_fkey` — ADR-030 explicitly keeps `NO ACTION`, and the job that depends on it is Sprint 12.
> - No `CONCURRENTLY` needed at this table size; keep the migration transactional.
>
> Show me both migrations, then run them.

**Verify:**

```bash
pnpm --filter @skaly/api db:migrate
psql "$DATABASE_URL" -c "\d staff" | grep -i unique      # partial index present
psql "$DATABASE_URL" -c "\d reports" 2>/dev/null
pnpm --filter @skaly/api db:rollback && pnpm --filter @skaly/api db:migrate   # reverse works
pnpm typecheck
```

---

## SPRINT 11 — STEP 3: Re-onboarding (ADR-026) — fixes A4

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 11, STEP 3. Making soft-deleted identities recoverable. Read `docs/adr/ADR-026` (follow it exactly), `docs/08-AUTH-MATRIX.md` §4 (**`PUT /v1/staff/:id/reactivate` is already specified**), `apps/api/src/services/ClientService.ts` (Sprint 9's `create` — its three-way backfill is what reactivate reuses), and the signup-approval path.
>
> **WHAT TO BUILD**
>
> 1. **`ClientService.reactivate(id, currentUser, db)`** — admin only, one transaction:
>    a. Load including soft-deleted (404 if absent; `ALREADY_PROCESSED` if already active).
>    b. `deleted_at = NULL`, `active = true`.
>    c. Run the **same** current-period three-way backfill `create` runs — shoot slots + pipeline row + calendar cells. If `create` was refactored into a shared `backfillClientPeriodRows(clientId, period, trx)`, call that; if not, this is the moment to extract it rather than copy it.
>    d. `AuditService.log({ entity: 'clients', action: 'UPDATE', … })`.
>    - Internal clients get **no** period rows, same as create.
>    - Route: `PUT /v1/clients/:id/reactivate`, admin only.
>
> 2. **`StaffService.reactivate(id, currentUser, db)`** — admin only, implementing the endpoint Auth-Matrix §4 already names:
>    a. Load including soft-deleted.
>    b. **Check for a live row with the same email first** (ADR-026 §5) — now that the index is partial, a dead and a live row can share an email. Collision → `409 ALREADY_PROCESSED` with a clear message, not a Postgres error.
>    c. `deleted_at = NULL`, `active = true`.
>    d. **Do not** silently restore MFA state — if `mfa_enrolled` was true, leave it; the returning employee re-enrols or an admin resets. Add a comment saying which you chose and why.
>    e. Fire `account_reactivated` (the enum value that already exists for exactly this).
>    f. Audit it.
>
> 3. **⭐ Fix the approval path (A4's real bug).** Today it finds the soft-deleted row and marks the request `rejected` with *"Account already exists at approval time"* — untrue, and the wrong outcome. Change it to **detect and surface**:
>    - Approval checks for an existing staff row by email, **distinguishing live from soft-deleted**.
>    - **Live row** → `409 ALREADY_PROCESSED`, as today. Correct.
>    - **Soft-deleted row** → do **not** reject. Return a distinct response the UI can act on — e.g. `409` with `details: { previousStaffId, deactivatedAt, suggestion: 'reinstate' }` — so the admin sees *"This person previously worked here. Reinstate their account?"* with a button that calls `PUT /v1/staff/:id/reactivate` and marks the signup request approved.
>    - The signup request stays **pending** in this case, not rejected. A pending request an admin can act on beats a rejected one with a false reason.
>
> 4. **`reactivate_client` bot tool** — a thin mutation wrapper through the ADR-014 confirmation machine, mirroring `deactivate_client` (admin only, `isMutation: true`, `readCurrent` for the summary). The registry goes from 22 to 23 tools; update the count anywhere it is asserted.
>
> **RULES**
>
> - Reinstate the original row. Never create a duplicate for a returning employee — the history and audit trail are the reason the row was soft-deleted rather than hard-deleted.
> - No new notification enum value for client reactivation (ADR-026 §7).
> - The backfill is shared code, not copied code.
>
> **Tests:**
> - Client reactivate restores the row **and** generates all three period-row types; internal clients get none; already-active → `ALREADY_PROCESSED`; non-admin → 403.
> - Staff reactivate restores; email collision with a **live** row → 409 (not a DB error); `account_reactivated` fires.
> - **⭐ A4 regression:** soft-delete a staff member, submit a signup request with their email, approve it → the request is **not** rejected, the response carries the reinstate suggestion, and the old `staff.id` is returned. Assert the old false message is gone.
> - Bot `reactivate_client` goes through confirmation and hits the same service.
>
> Show me the approval-path fix first — it is the actual A4 defect — then the two reactivate methods.

`▶ /ponytail` — client reactivate and client create now share a backfill and differ in about four lines. And the approval path has grown a three-way branch; ask him whether it reads as one decision or three.

**Verify:**

```bash
pnpm --filter @skaly/api test services/ClientService services/StaffService routes/signup
pnpm typecheck
```

---

## SPRINT 11 — STEP 4: Settings backend + the permission push (ADR-029)

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 11, STEP 4. The settings API surface. Read `docs/08-AUTH-MATRIX.md` §4 (the endpoint map — **build exactly these**), §5–§6 (what the Permissions UI toggles, key naming, the Redis cache), `docs/adr/ADR-029`, `docs/07-API-CONTRACT.md`, `docs/09-ERROR-HANDLING.md` §2, and `docs/11-THIRD-PARTY-INTEGRATIONS.md` §2.2.
>
> My STEP 1.2 census showed these already exist: **[paste]**. Complete what is partial; build what is missing.
>
> **WHAT TO BUILD**
>
> 1. **Staff admin ops** (all admin-only unless noted):
>    - `GET /v1/staff` — admin full; **manager read-only limited fields** (Auth-Matrix §3 `👁 limited`).
>    - `POST /v1/auth/invite` — Supabase `inviteUserByEmail` with the portal redirect; 24h expiry; `INVITE_EXPIRED` / `INVITE_ALREADY_USED` on redemption.
>    - `PUT /v1/staff/:id/deactivate` — soft delete + **revoke Supabase sessions** (`auth.admin.signOut`), so a deactivated user is logged out, not merely blocked next request.
>    - `PUT /v1/staff/:id/reactivate` — STEP 3.
>    - `PUT /v1/staff/:id/mfa/reset` — `mfa_enrolled = false`; the user re-enrols next login (Auth-Matrix §10).
>
> 2. **Permissions** — `PUT /v1/staff/:id/permissions/:key`, admin only:
>    - Upsert into `user_permissions` with `value: boolean`; **delete the row** to fall back to the role default (the three-state model in Auth-Matrix §6.1 — allow / deny / inherit). A UI that can only set true/false can never restore inheritance.
>    - Validate `:key` against the Auth-Matrix §6.2 convention (`bot.tool.{name}`, `module.{module}.read|write`, `chat.access`, `report.generate`, `months.unlock`) — reject anything else. Never accept free text.
>    - **Invalidate `perms:{staffId}` immediately** on write (existing behaviour — confirm it fires on *every* path this UI can reach, including the delete-to-inherit case).
>    - **⭐ ADR-029:** emit `permission_changed` to that staffId's room. UX layer only — the invalidation above is the enforcement boundary. Ride ADR-025's self-healing path rather than adding a bespoke one.
>
> 3. **Signup requests** — `GET /v1/settings/signup-requests` (admin), `POST .../approve`, `POST .../reject`:
>    - **`rejection_note` is stored and admin-visible, and never transmitted to the rejected user in any response** (NFR §4.2). Assert this in a test, not just a comment.
>    - `ALREADY_PROCESSED` on a second approve/reject.
>    - Approval integrates STEP 3's reinstate detection.
>
> 4. **Months** — `POST /v1/months/:period/lock`, `DELETE /v1/months/:period/lock`, admin only:
>    - Unlock **requires** a `reason` → `UNLOCK_REASON_REQUIRED` (400) when absent; the reason is stored on the row.
>    - `PERIOD_NOT_FOUND` for an unknown period.
>    - Locking is what every service's `assertPeriodNotLocked` has been reading since Sprint 3 — this is the UI that finally sets it.
>
> **RULES**
>
> - Build exactly the endpoints in Auth-Matrix §4. No extras.
> - Permission keys are validated against the convention, never free text.
> - The route does not filter; the service does.
> - `rejection_note` never leaves the admin surface.
>
> **Tests:** each endpoint's role matrix matches Auth-Matrix §4 exactly (including manager 403s on permissions/signup/months); deactivate revokes the Supabase session; permission write invalidates the Redis key **and** emits `permission_changed`; delete-to-inherit restores the role default; an invalid permission key is rejected; unlock without a reason → `UNLOCK_REASON_REQUIRED`; **`rejection_note` appears in no response body** (assert against the serialised JSON).
>
> Show me the permissions endpoint (with the three-state model and the push), then the months lock/unlock.

`▶ /ponytail` — the permission upsert/delete/invalidate/emit sequence is four steps that belong together; check it is one seam, not four call sites. Same for deactivate's soft-delete-plus-session-revoke.

**Verify:**

```bash
pnpm --filter @skaly/api test routes/settings routes/staff
pnpm --filter @skaly/api dev    # /docs lists every Auth-Matrix §4 endpoint
```

---

## SPRINT 11 — STEP 5: Audit log + streaming export (ADR-028)

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 11, STEP 5. The audit log panel's API. Read `docs/adr/ADR-028`, `docs/13-NFRS.md` §2.2 + §4.2 + §5.3, `docs/05-BACKEND-SCHEMA.md` (`audit_log`), and `docs/07-API-CONTRACT.md`.
>
> **WHAT TO BUILD**
>
> 1. **Install the cursor driver** — `pnpm --filter @skaly/api add pg-query-stream`. Kysely's `.stream()` needs it; without it you get a **runtime** error, not a type error.
>
> 2. **`AuditQueryService.list(filters, cursor, limit, db)`** — admin only. Filters per NFR §5.3: date range, actor (`staff_id`), `table_name`, `action`, `record_id`, `changed_by_source`. Keyset pagination on `(created_at DESC, id DESC)`. Joins `staff` for the actor's display name, and resolves the **System Actor UUID** (`00000000-…-0`) to a readable "System" label rather than a blank.
>
> 3. **`GET /v1/audit-log/export`** — admin only, **streams**:
>    ```
>    Kysely .stream() over the SAME filter predicate
>      -> csv-stringify transform (real escaping — old_value/new_value are JSONB and
>         contain commas, quotes and newlines by construction)
>      -> reply.send(stream)
>    ```
>    - `Content-Type: text/csv`, `Content-Disposition: attachment; filename="audit-log-{from}-{to}.csv"`.
>    - **No `Content-Length`** — chunked encoding.
>    - Columns: timestamp (ISO, IST), actor name, actor role, source, table, action, record id, old value, new value, IP.
>    - **One WHERE clause feeds both sinks** — the paginated JSON list and the export must not drift. Extract the predicate builder; do not write it twice.
>
> 4. **No mutation endpoints.** `audit_log` is append-only at the DB role level (`REVOKE UPDATE, DELETE`). There is no edit, no delete, no redact. If a prompt suggests one, it is wrong.
>
> **RULES**
>
> - Streaming, not buffering. A 50k-row buffered response is a memory spike on the instance that is also rendering PDFs.
> - Real CSV escaping. Hand-rolled `join(',')` produces a file that looks fine in a text editor and is corrupt in Excel.
> - Never `SELECT *` — pick columns explicitly so a future schema addition doesn't silently widen the export.
>
> **Tests:** filters compose correctly (date + actor + table together); keyset paginates with no duplicates or gaps; the export streams (assert the response has no `Content-Length` and arrives in multiple chunks); a JSONB value containing a comma, a double quote **and** a newline round-trips through a CSV parser intact; **10k seeded rows export without the process heap growing materially** (this is the assertion ADR-028 exists for); non-admin → 403.
>
> Show me the shared predicate builder, then the streaming handler.

`▶ /ponytail` — the CSV row serialiser will accrete special cases (nulls, JSONB, the System Actor, timezone). One mapping table beats a stack of conditionals.

**Verify:**

```bash
pnpm --filter @skaly/api test services/AuditQueryService routes/audit-log
curl -sD - "http://localhost:3001/v1/audit-log/export?from=2026-01-01" -H "Authorization: Bearer $ADMIN_TOKEN" | head -5
```

---

## SPRINT 11 — STEP 6: Report generation off the event loop (ADR-027)

**Goal:** The first CPU-bound work in the product. Get the execution model right; the PDF layout is the easy half.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 11, STEP 6. Report generation. Read `docs/adr/ADR-027` (follow it exactly), `docs/13-NFRS.md` §1.2 (p95 < 10s / p99 < 20s), `docs/10-INFRA-DEPLOYMENT.md` §4 (`healthcheckTimeout = 30` — the reason this must leave the main thread), `docs/11-THIRD-PARTY-INTEGRATIONS.md` §4.3 (`REPORT_EXPIRY_SECONDS` = 86400), `docs/07-API-CONTRACT.md` (report types + payload), and `docs/03-UIUX.md` (brand — the PDF must look like the portal).
>
> **HARD CONSTRAINT:** `@react-pdf/renderer` renders **synchronously**. Returning 202 while still rendering on the request event loop moves *when* the block happens, not *whether*. The render must leave the main thread. This is the trap and it passes code review.
>
> **WHAT TO BUILD**
>
> 1. **`POST /v1/reports/generate`** — admin + manager (Auth-Matrix §4):
>    - Validate `{ type, period, filters? }`.
>    - Insert a `reports` row, `status: 'pending'`.
>    - Dispatch to the worker.
>    - **Return 202 + `{ reportId }`.** No PDF, no link.
>
> 2. **The worker** — `apps/api/src/workers/report-worker.ts`, run via `worker_threads`:
>    - `new Worker(path, { workerData: { reportId } })`; the worker opens its own DB connection (a pool is not shareable across threads).
>    - Message protocol: `{ ok: true, r2Key }` or `{ ok: false, error }`. Handle `'error'` and `'exit'` events too — a worker that dies without messaging must still mark the row `failed`, or a report sits `pending` forever.
>    - **Concurrency cap:** a small fixed pool (start at 2) with a queue. Document the number and why. Five month-end requests must not spawn five renders.
>    - Hard timeout — terminate and mark `failed` past the NFR §1.2 p99 ceiling.
>
> 3. **The PDF** — `@react-pdf/renderer`:
>    - `Font.register` for the brand faces. **Vendor the TTFs into the repo** rather than fetching from a URL at render time — a network fetch inside a render is an unbounded stall in the middle of your timed operation.
>    - `StyleSheet.create` for the layout; portal-consistent header with the Skaly mark, period label, generated-at timestamp (IST), and page numbers via the `render` prop on a fixed footer.
>    - `renderToBuffer(<ReportDoc {...data} />)` in the worker.
>
> 4. **Completion:** upload to R2 (private) → update the row `status: 'ready'`, `r2_key`, `completed_at` → fire **`report_ready`** with a presigned GET at `REPORT_EXPIRY_SECONDS` (24h). *First real producer for one of ADR-020's six deferred types — update the deferred list assertion from 6 to 5 in the coverage test.*
>
> 5. **`GET /v1/reports/:id`** — status poll; when `ready`, returns a **freshly presigned** link (regenerated from `r2_key`, so a user returning within 24h never triggers a re-render). `GET /v1/reports?limit=` for the panel's recent list.
>
> 6. **Failure:** `status: 'failed'` + `error_message` + a notification. A failed request is a visible row, never a silent nothing.
>
> **RULES**
>
> - No synchronous CPU-bound work on the request event loop. This is the precedent-setting instance.
> - The worker owns its own DB connection.
> - Fonts are vendored, not fetched.
> - Presigned links are regenerated on read, never stored.
>
> **Tests:** generate returns 202 + reportId with `status: 'pending'`; **⭐ the API stays responsive during a render** — fire a generate, then hit `/v1/health` and assert it responds under 100ms while the worker is busy (this is the whole ADR in one assertion); completion sets `ready` + `r2_key` and fires `report_ready`; a worker crash marks `failed`, not `pending`; the timeout marks `failed`; polling a ready report returns a fresh link without re-rendering; concurrency cap holds under 5 simultaneous requests; non-admin/manager → 403.
>
> Show me the dispatch + worker lifecycle (including the `error`/`exit` handling) first, then the PDF document.

`▶ /ponytail` — the worker's lifecycle has four exit paths (success, thrown error, `exit` without message, timeout) that all end in "mark the row and notify". That convergence is his target.

**Verify:**

```bash
pnpm --filter @skaly/api test services/ReportService workers/report-worker
# manual: fire a generate, then in another shell:
while true; do curl -so /dev/null -w "%{time_total}\n" http://localhost:3001/v1/health; sleep 0.5; done
# every sample stays flat. If it spikes to seconds, the render is still on the main thread.
```

---

## SPRINT 11 — STEP 7: Backend tests + full suite

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 11, STEP 7. Rounding out backend tests. Read `docs/12-TESTING-STRATEGY.md` and ADRs 023–026.
>
> **WHAT TO BUILD**
>
> 1. **⭐ A4 regression suite** — soft-delete a staffer, re-apply with their email, approve → not rejected, reinstate suggestion returned, original `staff.id` reused, `account_reactivated` fired. Plus: the partial index permits a **new** active row with a soft-deleted row's email; reinstating into a live-email collision → 409, not a DB error.
> 2. **Role matrix sweep** — a table-driven test over all seven settings surfaces × four roles, asserting exactly Auth-Matrix §3/§4. Four panels are admin-only; manager gets Staff read-only, Clients, Holidays, Reports. This one test protects the entire sprint's access surface.
> 3. **`rejection_note` non-transmission** — assert against serialised response JSON on every endpoint that touches a signup request.
> 4. **Permission three-state** — allow / deny / inherit; delete-to-inherit restores the role default; `perms:{staffId}` invalidated on all three paths; `permission_changed` emitted.
> 5. **Report responsiveness** — the `/v1/health` latency assertion from STEP 6.
> 6. **Export memory** — 10k rows stream without material heap growth.
> 7. **ADR-020 coverage update** — `report_ready` moves from deferred to tested; the deferred list drops 6 → 5. The set-equality registry↔enum test still passes.
> 8. Full API suite + typecheck + lint.
>
> **RULES:** every test fails without its fix. The role matrix is table-driven — seven panels × four roles as data, not 28 hand-written cases.
>
> Show me the A4 regression and the role matrix first.

**Verify:**

```bash
pnpm --filter @skaly/api test
pnpm typecheck && pnpm lint
git add -A && git commit -m "Sprint 11 backend: re-onboarding (ADR-026, fixes A4), settings API + permission push (ADR-029), streaming audit export (ADR-028), off-loop reports (ADR-027)"
```

---

## SPRINT 11 — STEP 8: ⭐ Recovery-code redeem path

**Goal:** Close the availability hole carried since Sprint 8 STEP 8.4.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 11, STEP 8. The recovery-code redeem path. Read `docs/08-AUTH-MATRIX.md` §10 (MFA enforcement + "Lost authenticator: use recovery codes"), `docs/09-ERROR-HANDLING.md` §2 (`MFA_FAILED`, `MFA_LOCKED`), `docs/11-THIRD-PARTY-INTEGRATIONS.md` §2.3, and the Sprint 8 code-generation/storage code.
>
> **Context:** codes have been generated and stored since Sprint 8 with **no way to spend them**, while MFA is mandatory for admin and manager. The only recovery today is another admin resetting MFA (Auth-Matrix §10) — which fails when the locked-out person is the *only* admin. This is why it is no longer deferred, and it sits next to its counterpart (admin MFA reset, STEP 4) in the same sprint.
>
> **WHAT TO BUILD**
>
> 1. **`POST /v1/auth/mfa/recovery`** — accepts `{ code }` in a session that has passed password auth but not TOTP:
>    a. Look up the caller's stored codes.
>    b. **Constant-time compare** against unconsumed codes — a timing-variable compare on an auth secret is the same class of bug as B-03's internal-secret comparison.
>    c. No match → `MFA_FAILED`, and it counts toward the **same** 3-attempt lockout as TOTP (`MFA_LOCKED`, 15 min). A separate counter would be a bypass of the lockout.
>    d. Match → **mark that code consumed** (single-use, in the same transaction as issuing the session), clear the failed-attempt counter, complete the session.
>    e. Audit it — `changed_by_source: 'user'`, action recorded distinctly from a normal TOTP login. A recovery-code login is a security-relevant event.
> 2. **Remaining-count response** — `{ remainingCodes: N }`. When N ≤ 2, the UI nags to regenerate.
> 3. **`POST /v1/auth/mfa/recovery/regenerate`** — authenticated + MFA-verified: invalidate all existing codes, issue a fresh set, return them **once**. Same one-time-display treatment as Sprint 8's enrolment.
> 4. **Frontend** — on the MFA verify screen, a *"Lost your authenticator? Use a recovery code"* link → a code input → success routes to `/home` with a persistent banner: *"You signed in with a recovery code. N remaining — regenerate them in Profile."*
> 5. **Profile section** — remaining count + `[Regenerate codes]` behind a confirmation that names the consequence (all existing codes stop working).
>
> **RULES**
>
> - Single-use, enforced in the DB, in the same transaction as session issuance. A code that can be replayed is worse than no code.
> - Shares the TOTP lockout counter. No separate budget.
> - Codes are never re-displayed after generation, and never logged.
> - Constant-time comparison.
>
> **Tests:** a valid code authenticates and is consumed; the same code a second time → `MFA_FAILED`; 3 failed codes → `MFA_LOCKED`; **mixed TOTP and recovery failures share one counter** (2 bad TOTP + 1 bad code = locked); regenerate invalidates the old set; the remaining count is accurate; an unauthenticated caller cannot enumerate codes; the audit row distinguishes a recovery login.
>
> Show me the redeem endpoint with the constant-time compare and the shared lockout.

`▶ /ponytail` — the redeem path and the TOTP verify path now share lockout, session issuance, and audit. Ask him whether they are one verify seam with two credential types.

**Verify:**

```bash
pnpm --filter @skaly/api test routes/auth-mfa
# manual: enrol MFA, log out, log in, "use a recovery code", verify it works once and not twice.
```

---

## SPRINT 11 — STEP 9: Frontend — settings shell + Staff + Clients

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 11, STEP 9. The settings shell and the first two panels. Read `docs/03-UIUX.md` (settings layout, tables, dialogs), `docs/08-AUTH-MATRIX.md` §3 (**which panels each role sees**), `docs/04-APPFLOW.md`.
>
> **WHAT TO BUILD**
>
> 1. **Shell** — `apps/web/app/(portal)/settings/layout.tsx`: a vertical panel nav rendering **only** the panels the current role may see (Auth-Matrix §3). A manager sees Staff (read-only), Clients, Holidays, Reports — and must not see Permissions, Signup Requests, Months, or Audit Log. Direct URL access to a forbidden panel returns **403, not a redirect** (Auth-Matrix §3's explicit rule).
>    ```bash
>    npx shadcn@latest add table tabs switch dialog alert-dialog select
>    ```
> 2. **Staff panel** — TanStack Table over `GET /v1/staff`: name, email, role, MFA state, active/inactive. Row actions (admin only): Invite, Deactivate, **Reactivate**, Reset MFA. Manager sees the table with **no** row actions.
>    - Deactivate and Reset MFA behind `AlertDialog` confirmations that name the consequence ("they will be signed out immediately" / "they will re-enrol on next login").
>    - Soft-deleted staff shown in a collapsed "Former staff" section with a `[Reinstate]` action — this is the surface that makes A4's fix reachable.
> 3. **Clients panel** — list, create (with the required `shootSlotsPerMonth`, mapping `CLIENT_SHOOT_SLOTS_REQUIRED` to a field error), edit name, adjust slot count, deactivate, **reactivate**. Deactivate's confirmation names the consequence; reactivate's mentions that current-period rows will be regenerated.
> 4. **Frontend tests:** the nav renders exactly the role's panels; a manager's Staff table has no row actions; deactivate requires confirmation; reactivate appears only for soft-deleted rows; the slot-count error maps to the field.
>
> **RULES**
>
> - The nav is derived from the same permission source the backend uses — never a hardcoded role list in the component.
> - Every destructive action names its consequence in the dialog, not just "Are you sure?".
> - 403 on direct URL access, not a redirect.
>
> Show me the shell's role-derived nav, then the Staff panel.

`▶ /ponytail` — before you write panel three of seven, have him look at the shape of the first two. A table + toolbar + row-actions + confirm-dialog pattern extracted now saves five copies; extracted later saves nothing.

**Verify:**

```bash
pnpm --filter @skaly/web test
pnpm dev   # /settings as admin vs manager — different nav, no forbidden panels
```

---

## SPRINT 11 — STEP 10: Frontend — Permissions, Signup Requests, Holidays, Months

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 11, STEP 10. Four more panels, all admin-only except Holidays. Read `docs/08-AUTH-MATRIX.md` §5 + §6, `docs/adr/ADR-029`, `docs/04-APPFLOW.md`, `docs/09-ERROR-HANDLING.md` §2.
>
> **WHAT TO BUILD**
>
> 1. **Permissions panel** — staff selector, then a grouped matrix (Bot Tools / Modules / Features) of **three-state** controls: **Allow / Deny / Inherit**. Inherit is the default and shows the role default it resolves to ("Inherit — denied by role"). A two-state toggle cannot express inheritance and would make it unreachable once set.
>    - Changing a control calls `PUT /v1/staff/:id/permissions/:key`; Inherit issues the delete.
>    - Keys built from the Auth-Matrix §6.2 convention, never typed.
>    - After a change, show the effective result so an admin can verify without impersonating.
> 2. **Signup Requests panel** — pending queue with name/email/role/submitted-at; `[Approve]` / `[Reject]`. Reject opens a note field — the note is **admin-only** and the UI says so explicitly.
>    - **⭐ Reinstate flow (STEP 3):** when approve returns the reinstate suggestion, show *"This person previously worked here (deactivated {date}). Reinstate their account?"* with `[Reinstate]` / `[Create new]`, rather than an error toast. This is the user-visible half of A4's fix.
> 3. **Holidays panel** (admin + manager) — list for the period, add (date + label), remove. Removal's confirmation states that attendance rows for that date revert to working (the H-01 cascade).
> 4. **Months panel** — period list with lock state. Lock is one click; **unlock requires a reason** (`UNLOCK_REASON_REQUIRED` maps to the field). Locked periods show who locked them and when; unlocked ones show the last unlock reason. Make the consequence explicit: locking makes every module read-only for that period.
> 5. **ADR-029 consumption** — subscribe to `permission_changed`; on receipt, refetch `/v1/staff/me` and re-derive nav/access. Ride 10.1's self-healing mechanism (ADR-025) rather than adding a bespoke path.
> 6. **Frontend tests:** three-state control issues PUT/PUT/DELETE correctly and shows the resolved default on Inherit; reject requires a note and the note never renders outside the admin panel; unlock without a reason blocks with a field error; `permission_changed` triggers exactly one `/v1/staff/me` refetch; the reinstate branch renders on the suggestion response.
>
> **RULES**
>
> - Three states, not two. Inherit must remain reachable.
> - `rejection_note` never leaves the admin surface.
> - Reinstate is a first-class branch, not an error state.
>
> Show me the three-state permission control, then the reinstate branch.

`▶ /ponytail` — the permission matrix will want a component per control type. It is one control with three values; make sure it stayed that way.

**Verify:**

```bash
pnpm --filter @skaly/web test
```

---

## SPRINT 11 — STEP 11: Frontend — Audit Log + Reports

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 11, STEP 11. The last two panels. Read `docs/adr/ADR-027` + `ADR-028`, `docs/03-UIUX.md`, `docs/13-NFRS.md` §2.2.
>
> **WHAT TO BUILD**
>
> 1. **Audit Log panel** (admin only) — filter bar (date range, actor, table, action, source) + a **virtualised** table (TanStack Virtual — 50k rows at 12 months). Infinite scroll on the keyset cursor. Old/new value diffs in an expandable row, DM Mono, with only changed keys highlighted.
>    - **`[Export CSV]`** triggers a **browser download of the streamed response** — an anchor to the export URL, or `fetch` + `ReadableStream` → `Blob`. Do **not** buffer the whole body into memory in JS just to hand it to a Blob; that reintroduces the ceiling ADR-028 removed on the server. Show a progress/indeterminate state, since a 50k export takes seconds.
>    - **No edit, no delete controls anywhere.** The table is append-only at the DB role level; the UI must reflect that.
> 2. **Reports panel** (admin + manager) — report type selector, period, optional filters, `[Generate]`.
>    - On 202: show the report as **`pending`** in a recent-reports list with a spinner. Poll `GET /v1/reports/:id`, or — better — let `report_ready` arrive over the socket and patch the row (ADR-022's patch principle; the payload is sufficient).
>    - On ready: `[Download]` using the freshly presigned link. On failed: the error message + `[Retry]`.
>    - Recent reports list with status chips and generated-at timestamps.
>    - Make the async contract legible: *"We'll notify you when it's ready — you can leave this page."* A user who thinks the tab must stay open will keep it open.
> 3. **Frontend tests:** virtualisation renders a windowed subset of 1000 seeded rows; filters compose into the query key; export triggers a download without buffering the body; a `pending` report transitions to `ready` on `report_ready` without a poll; a failed report shows the message and retry; no mutation controls exist in the audit table.
>
> **RULES**
>
> - Never buffer the export body in JS.
> - The audit table is read-only, structurally.
> - Reports are fire-and-forget from the user's perspective — say so in the UI.
>
> Show me the export download handler and the report status flow.

`▶ /ponytail` — the audit diff renderer (JSONB, nested keys, nulls, added/removed) is the last piece of accidental complexity in the sprint.

**Verify:**

```bash
pnpm --filter @skaly/web test
pnpm dev   # generate a report, leave the page, come back — it is ready with a working link
```

---

## SPRINT 11 — STEP 12: Playwright E2E

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 11, STEP 12. E2E for settings and reports. Read `docs/12-TESTING-STRATEGY.md`. Reuse the Sprint 3–10 `loginAs` and config. Two contexts where a change must reach another session.
>
> **WHAT TO BUILD** — `tests/e2e/settings.spec.ts`, `reports.spec.ts`, `mfa-recovery.spec.ts`:
>
> **settings.spec.ts**
> 1. **Role gating:** admin sees seven panels; manager sees four; direct URL to `/settings/permissions` as manager → **403, not a redirect**; team_member has no Settings entry at all.
> 2. **⭐ A4 re-hire, end to end:** admin deactivates a staff member → that person submits a signup request with the same email → admin approves → **the reinstate prompt appears** (not a rejection) → `[Reinstate]` → the account is active again with its original id, and the signup request is approved rather than rejected.
> 3. **Client reactivate:** deactivate a client → it disappears from the grids → reactivate → it returns **and** the current period's shoot slots, pipeline row, and calendar cells are regenerated.
> 4. **⭐ Permission push (ADR-029), two contexts:** admin grants `chat.access` to a freelancer in context A while the freelancer sits idle on `/home` in context B → **B's sidebar gains Chat without a reload**.
> 5. **Month lock:** lock the prior period → in another context, a team member's attendance edit for that period fails with the locked copy → unlock **requires** a reason → after unlock, the edit succeeds.
> 6. **Audit export:** apply filters, click Export, assert a CSV download whose first row is the header and whose row count matches the filtered list.
>
> **reports.spec.ts**
> 1. Generate → 202 → the row appears `pending` → `report_ready` arrives → status flips to `ready` **without a reload** → Download yields a PDF (assert content-type and a non-trivial body length).
> 2. **⭐ API responsiveness:** while a report renders, `page.request.get('/v1/health')` returns 200 in under 500ms. *ADR-027's whole point, asserted from the outside.*
>
> **mfa-recovery.spec.ts**
> 1. Admin enrols MFA → logs out → logs in → "use a recovery code" → a valid code signs them in → the banner shows the remaining count.
> 2. The same code again fails.
> 3. Three bad attempts (mixing TOTP and codes) → `MFA_LOCKED`.
>
> Run headed once, then headless (chromium + webkit).
>
> **RULES:** independent and re-runnable; restore staff/clients/months in teardown. Do not assert exact PDF bytes — assert content-type, a size floor, and that the link resolves.
>
> Show me the A4 re-hire spec and the permission-push spec first.

**Verify:**

```bash
pnpm exec playwright test tests/e2e/settings.spec.ts tests/e2e/reports.spec.ts tests/e2e/mfa-recovery.spec.ts
pnpm exec playwright test      # ENTIRE suite green
```

---

## SPRINT 11 — STEP 13: Smoke + NFR measurement + close-out (manual)

### 13.1 — Manual walk-through

1. **Role gating:** `/settings` as admin (**8** panels — Staff, Clients, Permissions, Signup
   Requests, Holidays, Months, Audit Log, Reports, plus the always-present General; the "7"
   here predates Reports becoming a panel and `ADMIN_PANELS` in `settings.spec.ts` is the
   count that is asserted), manager (4), team_member (no entry). Direct URL to a forbidden
   panel → 403.
2. **⭐ A4:** deactivate a staffer → re-apply with their email → approve → **reinstate prompt, not rejection** → reinstate → original id restored, `account_reactivated` fired. Confirm the old false message is gone.
3. **Client lifecycle:** deactivate → gone from grids, history intact → reactivate → current-period rows regenerated. Then the same via the bot's `reactivate_client`, through the confirmation card.
4. **Permissions:** set Allow → Deny → **Inherit** on a bot tool; verify each in the bot immediately. Inherit must show the resolved role default. Grant `chat.access` to a freelancer with their session idle → **their sidebar updates live**.
5. **Signup:** approve one, reject one with a note. Confirm the note is visible to the admin and **absent from every response body** (DevTools → Network → the raw JSON).
6. **Months:** lock the prior period → every module read-only, mutations return the locked copy → unlock without a reason (blocked) → with a reason (succeeds, reason stored and displayed).
7. **Audit:** filter by actor + table + date; expand a diff; export CSV; open it in a spreadsheet and confirm a JSONB value containing a comma and a quote landed in one cell.
8. **⭐ Reports (ADR-027):** with `while true; do curl -so /dev/null -w "%{time_total}\n" localhost:3001/v1/health; sleep 0.5; done` running, generate a report. **Health latency stays flat.** Report goes pending → notification → ready → download opens a branded PDF. Return an hour later: the link regenerates without a re-render.
9. **⭐ Recovery codes:** log in as admin with MFA → use a recovery code → works once, not twice → remaining count correct → regenerate → old codes dead.
10. **NFR measurement (§1.2), numbers not vibes:** report generation p95 < 10s / p99 < 20s over 10 runs; audit export of 10k rows completes without heap growth; settings panels load < 1.5s.

### 13.1 — MEASURED (2026-07-30)

| Bar | Measured | How |
|---|---|---|
| Report generation p95 < 10s / p99 < 20s | **p50 4532ms · p95 4919ms · p99 4919ms** (min 1943, max 4919), 10/10 `ready` | `scripts/measure-report-nfr.ts 10`, real `defaultSpawn` worker thread + real R2 upload, at 40 clients / 930 calendar cells. With n=10 both percentiles ARE the slowest run — a ceiling check, not a distribution |
| `/v1/health` flat during a render | median **11ms**, max **16ms** | sampled from the Reports panel across a live render; the standing assertion is `test/workers/report-worker.test.ts` (< 500ms) |
| Settings panels < 1.5s | General **507ms**, the other eight **991–1005ms** | click → panel heading swap + 300ms fetch-quiet, prod build |
| NFR §1.1 calendar FCP < 1.5s / TTI-proxy < 2.0s | FCP **276ms**, domInteractive **270ms**, at **40** client columns (2× the 31×20 shape) | `E2E_PERF=1` unskips `content-calendar.spec.ts:406` against `next start` |
| NFR §1.4 scroll 60fps, no long tasks | median **16.7ms**, p95 **16.8ms**, 0 long tasks > 50ms, 2466px scrolled | `content-calendar.spec.ts:437`, same run |
| 10k-row audit export without heap growth | asserted | `test/routes/audit-log.test.ts:371` (row count through the stream, not a `heapUsed` delta — see its comment) |

The report bar is measured on the **render**, not the HTTP call: ADR-030 made
`POST /v1/reports/generate` a 202 that returns in milliseconds, so §1.2's 10s/20s can only
mean generate → `ready`. That is what the harness times.

`▶ /ponytail` — full-sprint review before the close-out checklist.

### 13.2 — Close-out checklist

```
PRE-FLIGHT
  [ ] A1 hotfix deployed — trustProxy: true AND staffId keyGenerator (ADR-024)
  [ ] Sprint 10.1 landed (A2 ADR-025 self-healing, A3 env assertion); Sprint 10 merged
  [ ] Full suite + Playwright green BEFORE Sprint 11 code
  [ ] ADR-026..027 committed

MIGRATIONS
  [x] staff_email_unique is now PARTIAL (WHERE deleted_at IS NULL) — mirrors migration 030
      — verified against the live DB: `CREATE UNIQUE INDEX staff_email_unique ON
      public.staff USING btree (email) WHERE (deleted_at IS NULL)`
  [ ] Migration comment records: non-additive but non-breaking (relaxes a constraint)
  [ ] reports table created (or confirmed pre-existing) + grants
  [ ] Reverse migrations exist and were exercised
  [ ] messages_parent_id_fkey UNTOUCHED (ADR-030 — Sprint 12)

RE-ONBOARDING (ADR-026 / audit A4)
  [ ] ClientService.reactivate + the SHARED three-way period backfill (not copied)
  [ ] Internal clients get no period rows on reactivate
  [ ] StaffService.reactivate; live-email collision → 409, not a DB error
  [ ] ⭐ Approval DETECTS a soft-deleted row and offers reinstate — no false rejection
  [ ] Signup request stays PENDING in that case, not rejected
  [ ] account_reactivated fires on staff reinstate
  [ ] reactivate_client bot tool through the ADR-014 confirmation machine (registry 22 → 23)
  [ ] No new notification enum value for client reactivation (enum stays 18)

SETTINGS BACKEND
  [ ] Every Auth-Matrix §4 endpoint exists; role matrix asserted table-driven (7 × 4)
  [ ] Deactivate revokes the Supabase session
  [ ] Permissions are THREE-state — allow / deny / inherit (delete restores the default)
  [ ] Permission keys validated against the §6.2 convention; free text rejected
  [ ] perms:{staffId} invalidated on all three paths
  [ ] ⭐ permission_changed emitted; consumed via ADR-025's mechanism, not a bespoke path
  [ ] Unlock requires a reason (UNLOCK_REASON_REQUIRED); reason stored + displayed
  [ ] ⭐ rejection_note appears in NO response body (asserted on serialised JSON)

AUDIT EXPORT (ADR-028)
  [ ] pg-query-stream installed; .stream() used
  [ ] One shared predicate feeds both the JSON list and the CSV export
  [ ] Real CSV escaping — JSONB with comma + quote + newline round-trips (TESTED)
  [ ] No Content-Length; chunked
  [ ] 10k rows export without material heap growth (TESTED)
  [ ] No edit/delete controls anywhere in the audit UI

REPORTS (ADR-027)
  [ ] 202 + reportId; no PDF in the response
  [ ] ⭐ Render leaves the main thread (worker_threads / worker service)
  [ ] ⭐ /v1/health stays under 100ms during a render (TESTED — the ADR in one assertion)
  [ ] Worker 'error' AND 'exit' handled — a dead worker marks failed, never leaves pending
  [ ] Hard timeout past the NFR §1.2 p99 ceiling
  [ ] Documented concurrency cap
  [ ] Fonts VENDORED, not fetched at render time
  [ ] report_ready fires with a 24h presigned link; links regenerate without re-rendering
  [ ] ADR-020 coverage updated — deferred list 6 → 5

RECOVERY CODES (carried since Sprint 8 STEP 8.4)
  [ ] POST /v1/auth/mfa/recovery redeems a code
  [ ] Single-use, enforced in the DB, same transaction as session issuance (TESTED twice)
  [ ] Constant-time comparison
  [ ] SHARES the TOTP 3-attempt lockout (mixed failures lock — TESTED)
  [ ] Regenerate invalidates the old set; codes displayed once, never logged
  [ ] Login entry point + remaining-count banner + Profile regenerate
  [x] ⭐ Codes issued AT ENROLLMENT, gated behind "I've saved these" (ADR-031)
      — incl. the 501 fallback path, which used to finish with zero codes
  [x] Live enrollment verified — against REAL Supabase, by `mfa.spec.ts`, not on staging.
      ⭐ THE PREMISE OF THE OLD ITEM WAS WRONG. "Local Supabase 501s" reads as an
      environment limit; it is a LIBRARY one. `AuthService.enrollMfa` 501s because the
      installed @supabase/auth-js 2.108.2 admin client exposes no `mfa.enrollFactor`
      (AuthService.ts:894, shape documented at :120) — staging runs the same SDK and
      would 501 identically and take the same client fallback. There was nothing
      staging could show that this machine could not.
      What WAS unproven is narrower: `mfa.spec.ts` treated the acknowledgment gate as
      optional (`if (await ack.isVisible())`), so a live enrollment finishing with ZERO
      codes passed it — the exact hole ADR-031 closed, invisible to the only test that
      meets real Supabase. Now a hard assertion plus `count(*) = 10` on
      mfa_recovery_codes (unambiguous: resetEnrollment() deletes them in beforeEach).
      Observed on the wire: enroll 501 → fallback → recovery/regenerate → 10 rows.

FRONTEND
  [ ] Nav derived from the permission source, not a hardcoded role list
  [ ] Manager sees 4 panels, no Staff row actions; forbidden URL → 403 not redirect
  [ ] Three-state permission control shows the resolved default on Inherit
  [ ] Reinstate is a first-class branch, not an error toast
  [ ] Destructive dialogs name the consequence
  [ ] Audit table virtualised; export streams without buffering in JS
  [ ] Reports show pending → ready via socket, no poll required; async contract stated in UI
  [x] ⭐ month:lock_changed CONSUMED (MonthLockSync) — it had been broadcast since
      STEP 4 with no listener, so a locked month only reached an open grid as a
      423 after the user had typed. Invalidates BOTH ['months'] (the five grids)
      and ['settings','months'] (the panel): same endpoint, two keys, and
      TanStack prefix-matching does not bridge them
  [x] 07-API-CONTRACT §Reports documents the ADR-030 async contract (202 + reportId),
      not the superseded synchronous 200-plus-downloadUrl shape
  [x] report_ready's linkBuilder returns /settings/reports?reportId= — never a
      presigned URL (M-08), enforced for all 18 types by the link-durability test

TESTS + NFRs
  [x] Full API, frontend, and Playwright suites green — API 837, web 280,
      Playwright 91 passed / 2 skipped (the two chromium-gated content-calendar
      perf checks, §1.1 FCP and §1.4 60fps; nothing accidental)
  [x] Close-out run (2026-07-30): API 838 · web 280 · Playwright 180 passed / 6 skipped
      / 0 failed over 19.7m, BOTH engines (186 tests). The earlier "91 / 2" was a
      one-engine count. All 6 skips deliberate: 2×2 the E2E_PERF-gated calendar perf
      gates, plus 2 webkit-only login cases that mutate shared staff state
      (login.spec.ts:144). Both servers were killed first, so Playwright ran the build
      itself — `next build` output in the log, global-setup reporting `rate limit
      100000` (which only happens when it starts the API rather than reusing one).
  [x] ⭐ AGAINST A FRESH BUILD. The web webServer is `pnpm build && pnpm start`
      with reuseExistingServer, so a `next start` left up from an earlier session
      is reused and the BUILD STEP NEVER RUNS. Three green full-suite runs here
      tested a build that predated the sprint's product changes. Rate limiting
      fails loudly; this fails GREEN. Check the server's CreationDate before
      trusting an E2E result that is meant to exercise a product change.
  [x] A4 re-hire E2E passes end to end — settings.spec.ts:161, green in the close-out run
      on both engines. It asserts the PRESENTATION too, which is what 13.1 #2 was
      watching for: the heading `${name} previously worked here` and the button
      `Reinstate their account` (not a rejection, not an error toast), then the original
      id back with active=true / deleted_at=null and the request `approved`.
  [x] Permission-push two-context E2E passes — on the `subscribed` gate, not a
      frame count (see below)
  [x] ⭐ Socket-consumer test sweep: every event name a frontend consumer subscribes
      to exists in the api's emit list. Only `report_ready` was wrong; the silent
      `handlers.get(x)?.()` no-op is now a throw in the bell and permission-sync
      tests, so a wrong name fails instead of passing
  [x] ⭐ Wait-for-join barrier on EVERY two-context spec, not just settings —
      chat and notifications had the identical latent race. NOT a websocket-frame
      barrier: engine.io joins over long-polling before the upgrade, so the
      room:join ack is invisible to page.on('websocket') on a warm reload
      (measured). The barrier is the app's own `enabled: subscribed` gate.
  [x] Report p95 < 10s / p99 < 20s MEASURED over 10 runs — p95 4919ms / p99 4919ms,
      10/10 ready, at 40 clients. See the 13.1 MEASURED table.
  [x] Every new test fails without its fix — the close-out's own two, checked by
      reverting each: the freelancer comment-scope test returns [] instead of the admin
      comment under the old author-scoped predicate; the RTL timeout fix is a config
      raise with no assertion of its own (the flake it fixes is recorded in
      apps/web/test-setup.ts).
  [x] pnpm typecheck + pnpm lint clean
  [ ] /ponytail run at each build step — no outstanding flags
```

### 13.2 — What the close-out did NOT verify directly

Recorded rather than quietly ticked:

- **13.1's ten items were walked, not all by hand.** Live in the browser: role gating (the
  nav is the asserted `ADMIN_PANELS`), Months (an unlock with an empty reason → `DELETE
  /v1/months/2096-03/lock` 400, dialog stays open with guidance, row still Locked — and a
  stored reason from today rendering in HISTORY), Reports (202 → *Generating* at 679ms →
  *Ready + Download* at 2666ms via socket, no reload), the destructive-dialog copy
  ("They will be signed out immediately … you can reinstate them later from Former
  staff"), and the panel-load timings. Delegated to specs that ran green in the same
  session rather than re-driven by hand: A4 (above), client lifecycle + `reactivate_client`,
  the three-state permission push, the signup rejection-note leak check, audit
  filter/expand/export, and the recovery-code login.
- **The audit CSV was not opened in a spreadsheet.** The comma/quote/newline round-trip
  rests on `test/routes/audit-log.test.ts`, which asserts it on the produced bytes.
- **"Return an hour later: the link regenerates without a re-render"** was not waited out;
  `ReportService.test.ts` covers the cheap-revisit path (ADR-030 §7).
- **Deployment items** (A1 hotfix deployed, reverse migrations exercised) are unchanged from
  when they were ticked; nothing in this session re-proved them.

### 13.3 — Commit

```bash
git add -A
git commit -m "Sprint 11: settings panels + async off-loop reports (ADR-027) + streaming audit export (ADR-028) + re-onboarding (ADR-026, fixes audit A4) + permission push (ADR-029) + recovery-code redeem path"
git push -u origin sprint-11-settings-reports
```

PR to `main`; CI fully green before merge. Merge, then `git checkout main && git pull`.

### 13.4 — Move to Sprint 12

`MASTER-BUILD-GUIDE-V2-FINAL.md` → PART 9 → **SPRINT 12**: the comment system (+ `new_comment`), the attachment orphan cron, the `coming_shoot_date` rollover recompute (ADR-012 §4), and the message retention job (**ADR-030 — already ruled, build it as specified**).

---

## DECISIONS TO MAKE BEFORE SPRINT 12

- **⚠️ The comment system is the last unbuilt dependency of two shipped features.** Sprint 9's global search has a `comments` category that has returned empty for three sprints (no write path), and `new_comment` is one of ADR-020's remaining deferred notification types. Sprint 12 closes both. Decide the visibility rule **before** building, because search already queries it: API-Contract says a team_member sees *own comments + all manager/admin replies in the same record*. That predicate must be written **once** and shared by `CommentService.list` and `SearchService`'s comments query — if they drift, search leaks or hides comments relative to the module view, and only one of those failures is visible.

  **DECIDED AND BUILT (Sprint 11 close-out).** `apps/api/src/lib/comment-visibility.ts` is
  that one predicate; `SearchService.searchComments` now passes it to `.where()` and has no
  role branch of its own. Sprint 12's `CommentService.list` imports the same function — there
  is no second place to get it wrong.

  Writing it once settled the one branch that was wrong: **freelancer scope is by SHOOT ROW,
  not by author.** Search filtered `comments.staff_id = self`, but ADR-015 §2 says "comments
  only on their own shoot rows", and 04-APPFLOW §13 notifies the assigned freelancer of every
  new comment on their shoot — so author-scoping pointed that notification at a comment they
  could not read. Now `module='shoot_planner' AND EXISTS(shoot_schedules WHERE id=record_id
  AND freelancer_id=self)`, mirroring `ShootPlannerService`'s own `freelancer_id = self`
  (ADR-011). Access ends when the assignment does, exactly as `getSlot` already 404s them.
  It was stricter than the owning service, which ADR-015 §2 calls a parity break that fails
  safe — the kind nobody notices.

- **Attachment orphan cron: what counts as an orphan, and how old?** ADR-007 deferred this. An R2 object whose `task_attachments` row never materialised (a presign issued, upload completed, confirm never called) is a genuine orphan. But an object mid-upload looks identical. The presign window is 15 minutes (`UPLOAD_EXPIRY_SECONDS` = 900), so anything unconfirmed for **more than an hour** is safely dead. *Recommendation: sweep R2 keys with no matching row older than 1 hour; log every deletion to `audit_log` with the System Actor. Never delete based on a DB-side "pending" flag alone — the crash you are cleaning up after is exactly the one that fails to set it.*

- **`coming_shoot_date` rollover recompute vs. Trigger 1 (ADR-012 §4).** The daily recompute at rollover and the live Trigger 1 both write `content_pipelines.coming_shoot_date`. Confirm they are the same code path with different actors (System Actor for the cron, the human for the trigger) — two implementations of one recompute is the ADR-014-era permission-resolver bug in a different table, and it would drift silently because both write a plausible value.

- **Retention job scheduling and the rollover window.** ADR-030's message retention and the 12-month cleanup run monthly; rollover runs nightly at 00:01 IST inside a single atomic transaction (< 5 min expected, NFR §3.1). Decide whether retention runs in the same cron service and, if so, that it runs **after** rollover completes — a long DELETE holding locks while rollover's transaction is open is the one way to turn two safe jobs into an outage. *Recommendation: separate schedule, well clear of the rollover window (e.g. 03:00 IST), monthly.*

- **Still deferred, on schedule:** Socket.io Redis adapter verification (before any second API instance); A6 date-derived test fixtures (opportunistic, likely folded into Sprint 12's test pass).

---

## TROUBLESHOOTING — SPRINT 11 SPECIFIC

### Every settings panel intermittently shows "failed to load"
The A1 hotfix isn't deployed. Seven panels each fetching lists is the most request-dense screen in the product; on one shared 150/min bucket the whole org exhausts it in minutes, and a 429 never presents as a 429 — it presents as a load failure. Check `x-ratelimit-limit` and `trustProxy` before debugging any panel.

### `GET /v1/audit-log/export` throws at runtime about a missing cursor
`pg-query-stream` isn't installed. Kysely's `.stream()` needs it and the failure is runtime, not typecheck.

### The exported CSV opens wrong in Excel
Hand-rolled serialisation. `old_value` / `new_value` are JSONB containing commas, quotes, and newlines. Use `csv-stringify`.

### `/v1/health` times out while a report renders
The render is still on the main event loop. The 202 changed *when*, not *whether* — the whole point of ADR-027. Move it to `worker_threads` or a worker service.

### A report sits `pending` forever
The worker died without sending a message. Handle `'error'` **and** `'exit'`, not just the success message, and mark the row `failed` from both.

### Report generation is slow and variable in a way that doesn't match render complexity
`Font.register` is fetching TTFs over the network at render time. Vendor the files into the repo.

### An admin sets a permission to Deny, then can't get back to the role default
The control is two-state. Inheritance needs a third state that **deletes** the `user_permissions` row (Auth-Matrix §6.1).

### A permission change doesn't reach an idle session
Expected if `permission_changed` was missed — and by design harmless: the next request re-checks server-side and corrects. If it *never* corrects even after navigation, the ADR-025 self-healing path isn't wired, which is a 10.1 regression rather than a Sprint 11 bug.

### Re-approving a returning employee still says "Account already exists"
Only the index was fixed, not the approval path. A4's real defect is the false rejection (ADR-026 §4) — the index alone lets a *new* row be created but leaves the misleading message and loses the person's history.

### Reinstating a staff member fails with a Postgres unique violation
The pre-check for a **live** row with that email is missing. Once the index is partial, a dead and a live row can share an email; catch it and return 409 with a clear message (ADR-026 §5).

### A recovery code works twice
Consumption isn't in the same transaction as session issuance, so a concurrent retry slips through. Mark consumed and issue the session atomically.

### Recovery-code failures don't trigger the lockout
A separate counter was added. It must share the TOTP counter, or the lockout is bypassable by alternating credential types.

---

## END OF SPRINT 11 DETAILED GUIDE

*Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1..10-DETAILED.md`. Source-of-truth precedence when documents differ: the numbered spec docs (`01`–`14`) + the schema win, then this guide's reconciliations and the ADRs it executes (011–027), then the Master Build Guide's shorthand. This is the widest sprint by surface area and the shallowest by depth, with two exceptions: report generation is the first CPU-bound work in the product and sets the precedent for every later one, and the audit export is the first response whose size is a function of data volume. Both leave the request path — that is the whole lesson of the sprint. It also closes two long-carried items: the recovery-code redeem path, unspendable since Sprint 8, and audit finding A4, which quietly made every offboarded employee unhireable. Sprint 12 builds the comment system, the two crons, and ADR-030's retention job — read the first decision above before starting, because the comment visibility predicate must be shared with a search query that has been waiting on it since Sprint 9.*
