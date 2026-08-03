# SPRINT 12 — COMMENTS + BACKGROUND JOBS: DETAILED PROMPT-BY-PROMPT GUIDE

## Scaly Business Portal • Sprint 12 of 13

**Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1..11-DETAILED.md` + `SPRINT-8_1` / `SPRINT-10_1` patches**
**Same Goal / Prompt / Verify framework as Sprints 0–11**
**Tooling interfaces verified as of July 2026** — Fastify 5, Kysely (`.stream()` via `pg-query-stream`, CTEs, `sql` template for batched deletes), Socket.io v4 (`notify:new` typed delivery — **not** bespoke events), TanStack Query v5 (shared query keys, `setQueryData` patch), `@aws-sdk/client-s3` (`ListObjectsV2Command`, `DeleteObjectsCommand`, `HeadObjectCommand`), DOMPurify, Framer Motion 11, Playwright latest. **ADR series lives in `docs/decisions/`, not `docs/adr/`.**

> **Risk note:** Sprint 12 is deceptively split. The comment system (STEPS 3–4, 9) is ordinary CRUD with one sharp edge — the visibility predicate that Sprint 9's search has been waiting three sprints for. The three background jobs (STEPS 5–7) are where the danger lives: each writes to shared state on a schedule with no user watching, and each has a specific way to become a silent outage — an unscoped R2 sweep deleting backups, a duplicate recompute erasing a manual override, a monster DELETE locking the messages table during live chat. Test the jobs against their failure modes, not their happy paths.

---

## USING THE `/ponytail` PLUGIN IN THIS SPRINT

Placement as established in Sprint 9: **between the build prompt and the test prompt** — on the implementation, before anything is written against its shape. Absent from manual steps, ADR authoring, migrations, and branch creation.

**Where he earns his keep this sprint:** the comment visibility predicate (STEP 3 — one fragment, and it must stay one), the three cron job bodies (STEPS 5–7 — they share a "loop, act, audit, handle partial failure" skeleton and should not each reinvent it), and the comment thread renderer (STEP 9). The recompute extraction in STEP 6 is explicitly his kind of move — a function that already exists inline and needs to become callable.

---

## WHAT YOU'RE BUILDING IN SPRINT 12

The last operational feature and the jobs that keep the data honest over time. By the end of this week:

- **The three pre-Sprint-12 decisions are recorded** as **ADR-032** (comment visibility predicate), **ADR-033** (attachment orphan sweep), **ADR-034** (single-implementation `coming_shoot_date` recompute), and **ADR-030 is amended** with the retention job's schedule + batching.
- **The comment system exists** — `POST /v1/comments`, threads, soft delete, and the visibility rule that Sprint 9's search `comments` category has been returning empty on for three sprints. `new_comment` gets its first real producer — the fifth of ADR-017's six deferred notification types, delivered as a `notify:new` **type**, not a bespoke socket event (the exact mistake Sprint 11 caught with `report_ready`).
- **Sprint 9's search comments category goes live** — same visibility predicate, proven by a parity test.
- **The attachment orphan cron runs** — sweeping R2 keys with no `task_attachments` row older than an hour, **scoped to the attachments prefix only** so it can never touch a CV, a report, or a backup, auditing every deletion to the System Actor.
- **The `coming_shoot_date` rollover recompute runs** — the *same function* Trigger 1 uses, differing only in actor and scope, honouring the `source='manual'` guard so no admin override is ever silently erased. Parity-tested against the trigger.
- **ADR-030's message retention job runs** — session-scoped, single-statement-per-conversation, **batched** so a 12-month purge never locks `messages` during live chat, on a schedule well clear of the 00:01 rollover window.
- **Two Sprint 11 carries land:** the `['months']` query-key unification (so a lock/unlock proactively flips grids read-only — UX only; the backend 423 stays the boundary), and the representative-volume report perf pass (NFR §1.2 at n≥100 on realistic data).
- **Tests prove it**: the visibility predicate shared and parity-checked; each cron against its specific failure mode; the recompute parity; the retention job seeded from Sprint 9's teardown case (a parent+child straddling the cutoff, neither errored nor split).

**Estimated time:** 5 working days (Week 13 per `06-IMPLEMENTATION-PLAN.md` §15; owners TL + D1 + D2). Day 1 pre-flight + comment migration + the visibility predicate; day 2 comment service/routes + search wiring; day 3 the three cron jobs (the hard day); day 4 job tests + the two carries; day 5 comment frontend + E2E + close-out.

**Prerequisites — verify the gate before any code:**

- **⚠️ Sprint 11 is pushed and merged.** It was tagged `sprint-11` locally but held pending the STEP 13.1 manual walkthrough and **ADR-031's staging MFA verification** (local Supabase can't issue a TOTP factor, so the server-enroll branch was unit-mocked only). Both must be cleared and Sprint 11 on `main` — Sprint 12 builds on the settings/reports surface and the notification registry it completed.
- The **A1 rate-limit hotfix (ADR-024)** and **Sprint 10.1 self-heal (ADR-022)** are live — every cron this sprint emits notifications, and a missed one must self-correct.
- `NotificationService` with the 18-type registry (ADR-017); `report_ready` already proved the `notify:new`-typed delivery path that `new_comment` will reuse.
- `SearchService` with the four-category search (ADR-015) — the `comments` category exists and returns empty pending this sprint's write path.
- `AuditService` writing with the System Actor UUID (`00000000-…-0`) for unattended writes; the R2 client with named expiry constants; the Railway cron service pattern (rollover + backups already run on it).
- Trigger 1's `coming_shoot_date` recompute from Sprints 5/7 — STEP 1 determines whether it's an extracted function or inline.
- `pnpm typecheck`, `pnpm lint`, and the full suite green on `main`.

---

## THE PRE-SPRINT-12 DECISIONS — WHERE THEY LAND

| Decision | Ruling | Executed in |
|---|---|---|
| **Comment visibility = one shared predicate** | `commentVisibility(currentUser)` used by both `CommentService.list` and `SearchService`. team_member: own + manager/admin authors, record-visibility gated, peers hidden. freelancer: own shoot rows only. Author role joined at read time. → **ADR-032** | STEP 1 (record) + STEP 3 + STEP 4 |
| **↳ `new_comment` is a `notify:new` type** | Not a bespoke socket event — the mistake Sprint 11 caught with `report_ready`. Fan-out per participant (ADR-006), never the author; `linkBuilder` returns an in-app route. | STEP 3 |
| **↳ Search comments category goes live** | Same predicate, proven by a parity test that was seeded-only until now. | STEP 4 |
| **Attachment orphan sweep** | R2 key with no `task_attachments` row older than 1h. **Prefix-scoped to attachments only** (asserted in code — the bucket also holds CVs/reports/backups). Audited to System Actor. Dangling DB→R2 refs handled lazily at download. → **ADR-033** | STEP 1 (record) + STEP 5 |
| **`coming_shoot_date` recompute = one function** | Cron and Trigger 1 call the same `recomputeComingShootDate`; differ only in actor and client scope; both honour the `source='manual'` guard and skip the version bump. Parity-tested. → **ADR-034** | STEP 1 (record) + STEP 6 |
| **Message retention job** | Built as **ADR-030** specifies (already recorded pre-Sprint-11). Amended: **03:00 IST monthly, clear of rollover, batched by whole-conversation** so it never locks `messages` during live chat. | STEP 1 (amend) + STEP 7 |
| **Carry: `['months']` key unification** | Lock/unlock proactively flips grids read-only. **UX only — the backend 423 stays the enforcement boundary.** `month:lock_changed` gets its web consumer. | STEP 8 |
| **Carry: representative-volume report perf** | NFR §1.2 at n≥100 on realistic data; the async accept is fine, the request→ready path needs a real measurement. | STEP 10 |

---

## READ FIRST (Open in Antigravity Split View)

`@`-reference with `@docs/07-API-CONTRACT.md`, and note the ADR path is `docs/decisions/`.

| Doc | Sections | Why |
|---|---|---|
| `docs/07-API-CONTRACT.md` | `/v1/comments/*`, `/v1/search` (the comments category shape), §1.1 envelopes, §2 rate limits | Exact shapes |
| `docs/05-BACKEND-SCHEMA.md` | `comments` (**`search_vector` GENERATED + GIN, migration 025; `record_type`/`record_id`; `parent_id`**), `messages` (**`parent_id` NO ACTION**), `bot_sessions` (`last_activity_at`), `task_attachments`, `content_pipelines` (`coming_shoot_date`, `source`) | Column truth |
| `docs/08-AUTH-MATRIX.md` | §3–§4 (who may comment where), §8 (freelancer isolation — the comment predicate must honour it) | The visibility spec |
| `docs/04-APPFLOW.md` | Comment flow (post, thread, mention), the read-only period flip | Every interaction |
| `docs/02-TRD.md` | §9.4 + ADR-018 (bot archive — retention deletes whole conversations), §8 (socket — `notify:new` typed delivery) | The retention boundary + delivery pattern |
| `docs/13-NFRS.md` | **§1.2 (reports p95 < 10s / p99 < 20s at representative volume)**, §2.2 (~15k messages at 12mo), §5.1–5.2 (retention: bot messages 12 months) | The numbers |
| `docs/10-INFRA-DEPLOYMENT.md` | §1 (**R2 holds attachments + CVs + reports + backups — the reason the sweep must be prefix-scoped**), §4 (cron service pattern), §7 (backup strategy) | The failure mode behind ADR-033 |
| `docs/11-THIRD-PARTY-INTEGRATIONS.md` | §4.1 (**R2 versioning — 90-day retention, why an over-aggressive sweep is recoverable**), §4.3 (expiry constants) | R2 behaviour |
| `docs/09-ERROR-HANDLING.md` | §7 (rollover failure AI summary — the recompute runs inside this window), §6 (bot copy) | The rollover context |
| `docs/decisions/` | **ADR-006, 011, 012, 015, 017, 018, 022, 030** + **032/033/034** (created STEP 1) | The rulings this sprint executes |
| `docs/06-IMPLEMENTATION-PLAN.md` | §15 | Sprint 12 checklist |
| `docs/12-TESTING-STRATEGY.md` | Job/cron + search-parity sections | The tests you must reproduce |

---

## CONSISTENCY RECONCILIATIONS — LOCK THESE BEFORE YOU PROMPT

1. **The `comments` table and its `search_vector` already exist** (migration 025 — GENERATED tsvector + GIN). Sprint 12 does **not** create the table or the index; it builds the write path, the read path, and wires the search category. If a prompt suggests a migration for comments search, it is wrong.
2. **`new_comment` is a notification *type* (ADR-017's enum), delivered via `notify:new`.** It is **not** a `comment:new` socket event. Sprint 11 shipped a bug where the reports panel listened for a non-existent `report_ready` socket event; `report_ready` is a type over `notify:new`. Do not repeat it. Grep for any `comment:new` / `emit('comment` before wiring.
3. **The visibility predicate is one function, shared** (ADR-032). Not "the same WHERE written in two services." `CommentService.list` and `SearchService.searchComments` import and apply the identical fragment. This is the ADR-018 single-resolver discipline; a second implementation drifts and only the hiding failure is visible.
4. **team_member comment visibility is own + manager/admin authors, NOT own-only and NOT all.** Auth-Matrix: peers' comments are not visible; supervisors' are. Record-visibility (can the user read the underlying task/cell/shoot at all?) is a precondition that composes with it.
5. **`report_ready`'s `linkBuilder` returns an in-app route** (`/settings/reports?reportId=`), never a presigned URL (audit M-08). `new_comment`'s `linkBuilder` follows the same rule — an in-app route to the record, never a raw link.
6. **`messages.parent_id` stays `ON DELETE NO ACTION`** (ADR-030). The retention job does not alter the FK. It works *because* of NO ACTION's statement-end check — do not "harden" it to RESTRICT (which would break the batched delete) and do not switch to CASCADE (silent thread-reply loss) or SET NULL (re-orphans bot replies, the ADR-018 bug).
7. **Retention deletes whole conversations, batched.** ADR-030 requires a parent + its children in one statement; it does **not** require the entire 12-month purge in one statement. Batch by conversation — bounded chunks — or a single monster DELETE locks `messages` during live chat.
8. **The attachment sweep is prefix-scoped, asserted.** R2 holds attachments, CVs, reports, and **backups** (Infra §1). "Delete R2 keys with no `task_attachments` row" without a prefix filter deletes every backup. The prefix scope is a code assertion, not a comment.
9. **`coming_shoot_date` recompute is one function** (ADR-034 / ADR-012 §4). The cron does not reimplement it; it calls Trigger 1's function with the System Actor over all active clients. Both honour `source='manual'` and skip the version bump (ADR-013).
10. **The `['months']` unification is UX, not enforcement** (ADR-029 pattern). The proactive read-only flip is a nicety; the backend `423 PERIOD_LOCKED` on write remains the boundary. `month:lock_changed` gets a consumer; the lock check does not move to the client.
11. **Frontend path `apps/web/app/(portal)/`** (no `src/`). Comment UI attaches to existing module records (tasks, calendar cells, shoot rows), not a standalone page.
12. **DOMPurify on comment content at render** (NFR §4.3), same as chat — content stored raw, rendered as text with a linkifier, no `dangerouslySetInnerHTML`.

---

## AUDIT + ADR ITEMS THIS SPRINT MUST HANDLE

| ID | What | Where |
|---|---|---|
| **ADR-032 (new)** | Comment visibility predicate, shared and parity-tested. | STEP 1 + 3 + 4 |
| **ADR-033 (new)** | Attachment orphan sweep, prefix-scoped, audited, lazy dangling-ref handling. | STEP 1 + 5 |
| **ADR-034 (new)** | Single-implementation `coming_shoot_date` recompute; cron reuses Trigger 1's function. | STEP 1 + 6 |
| **ADR-030 (build + amend)** | Session-scoped, batched retention job; 03:00 IST monthly, clear of rollover. | STEP 1 + 7 |
| **ADR-006 (inherited)** | `new_comment` fan-out per participant, never the author. | STEP 3 |
| **ADR-015 (inherited)** | Search comments category live; parity test now real. | STEP 4 |
| **ADR-018 (inherited)** | Retention deletes whole bot conversations bounded by `bot_sessions.last_activity_at`. | STEP 7 |
| **NFR §1.2** | Representative-volume report perf pass (n≥100). | STEP 10 |
| **A6 (Sprint 10 audit)** | Remaining date-pinned fixtures → period-derived. | STEP 8/9 tests |

If you skip the test for any of these, Sprint 12 is not done.

---

## STEP-BY-STEP STRUCTURE

| # | Type | What |
|---|---|---|
| 1 | Manual | Pre-flight — **verify Sprint 11 pushed/merged + ADR-031 staging done**, discover Trigger 1's recompute shape, record ADR-032/033/034, amend ADR-030, branch |
| 2 | Prompt | Comment migration check (table exists) — write path scaffolding only if anything's missing |
| 3 | Prompt | `CommentService` + the shared visibility predicate (ADR-032) + `new_comment` |
| 4 | Prompt | Comment routes + wire the search comments category (ADR-015 parity) |
| 5 | Prompt | ADR-033 — attachment orphan cron (prefix-scoped, audited) + lazy dangling-ref |
| 6 | Prompt | ADR-034 — extract/confirm the recompute, add the rollover cron path |
| 7 | Prompt | ADR-030 — session-scoped batched message retention job |
| 8 | Prompt | Carry — `['months']` query-key unification + `month:lock_changed` consumer |
| 9 | Prompt | Frontend — comment threads on module records + backend/frontend tests |
| 10 | Prompt | Carry — representative-volume report perf pass (NFR §1.2) + job tests |
| 11 | Manual + Prompt | Playwright E2E |
| 12 | Manual | Smoke + measurement + commit + close-out |

---

## SPRINT 12 — STEP 1: Pre-flight (manual)

### 1.1 — ⚠️ Verify the gate: Sprint 11 pushed, merged, and its staging item cleared

```bash
git checkout main && git pull
git log --oneline -15 | grep -i "sprint 11\|sprint-11"
git tag | grep sprint-11        # tagged; confirm it's also on main
```

Sprint 11 was held at close-out pending two things — confirm both are done:
- **STEP 13.1 manual walkthrough** — A4 re-hire end-to-end, `rejection_note` off the wire, the report link regenerating an hour later, the recovery-code path by hand.
- **ADR-031 staging MFA verification** — the server-enroll branch was unit-mocked only because local Supabase can't issue a TOTP factor; it needs one pass against real Supabase on staging, which also confirms the two intended E2E skips are the can't-run-locally perf probes.

```bash
pnpm install && docker compose up -d && docker compose ps
pnpm --filter @skaly/api db:status          # 0 pending
pnpm typecheck && pnpm lint && pnpm --filter @skaly/api test
pnpm exec playwright test                    # green
```

**Do not proceed on an unmerged Sprint 11.** Sprint 12 builds on its notification registry and settings surface.

### 1.2 — Discover what already exists (scopes STEPS 2, 3, 5, 6, 7)

```bash
# comments table + search_vector (migration 025) — should exist
psql "$DATABASE_URL" -c "\d comments"
grep -rn "CommentService\|/v1/comments" apps/api/src || echo "NO comment service — STEP 3 builds it"

# ⭐ is Trigger 1's recompute an extracted function or inline? (decides STEP 6)
grep -rn "recomputeComingShootDate\|coming_shoot_date" apps/api/src/services apps/api/src/events | grep -v test

# ensure new_comment is NOT already wired as a bespoke socket event
grep -rn "comment:new\|emit('comment\|report_ready'" apps/api/src apps/web/src   # report_ready should be notify:new only

# existing cron jobs on the Railway cron service
grep -rn "rollover\|cron\|internal/backup" apps/api/src/routes

# month:lock_changed emitter with no consumer (Sprint 11 carry)
grep -rn "month:lock_changed\|months.*lock" apps/api/src apps/web/src
```

Write down what you find. The single most important line is whether the `coming_shoot_date` recompute is already a callable function — if it's inline in the shoot-confirm handler, STEP 6 opens by extracting it, and the cron reuses the extraction rather than copying the logic.

### 1.3 — Record ADR-032, ADR-033, ADR-034; amend ADR-030 (Prompt)

> **WHERE WE ARE**
>
> Sprint 12, STEP 1.3. Recording the three pre-Sprint-12 rulings and amending ADR-030. **The ADR series lives in `docs/decisions/`.** Read `docs/decisions/ADR-030` (message retention — you're amending it), `docs/decisions/ADR-012` §4 (the recompute), `docs/decisions/ADR-015` (search scoping — the comment predicate mirrors its parity discipline), `docs/decisions/ADR-018` (bot archive — retention deletes whole conversations), and `docs/10-INFRA-DEPLOYMENT.md` §1 + `docs/11-THIRD-PARTY-INTEGRATIONS.md` §4.1.
>
> My STEP 1.2 census found: **[paste — especially the recompute's shape]**.
>
> **WHAT TO BUILD** — three new files in `docs/decisions/`, plus an amendment to ADR-030:
>
> **`ADR-032-comment-visibility.md`**
> ```
> # ADR-032 — Comment visibility is one shared predicate
> Status: Accepted • Pre-Sprint 12
> Cross-refs: 07-API-CONTRACT (/v1/comments, /v1/search), AUTH-MATRIX §3-4 §8,
>             ADR-011 (freelancer isolation), ADR-015 (search parity), ADR-018 (single impl)
>
> Context: Sprint 9's search has a comments category that has returned empty for three
>   sprints (no write path). Sprint 12 adds it. Search already queries comments, so the
>   visibility rule must be identical in the module view and in search, or one leaks/hides
>   relative to the other — and only the hiding failure is visible.
>
> Decision:
>   1. ONE function, commentVisibility(currentUser), returning a Kysely WHERE fragment.
>      CommentService.list and SearchService.searchComments both import and apply it.
>      Not "the same logic in two places" — the same function. This is the ADR-018
>      single-resolver discipline; a second implementation drifts silently.
>   2. Rule (author role JOINed at read time, never denormalised onto the comment row):
>        admin / manager  -> all comments
>        team_member      -> author_id = self OR author.role IN ('admin','manager')
>                            (own + supervisors; PEERS HIDDEN)
>        freelancer       -> comments only on records they own (their shoot rows),
>                            and there own + supervisors
>   3. Record-visibility is a PRECONDITION that composes: you cannot see a comment on a
>      record you cannot read. For team_member on tasks/calendar this is usually satisfied
>      (they read all); for freelancer it is the isolating filter.
>   4. new_comment is a notification TYPE delivered via notify:new — NOT a comment:new
>      socket event (the report_ready mistake Sprint 11 caught). Fan-out per participant
>      (record assignee + prior commenters), never the author (ADR-006). linkBuilder returns
>      an in-app route to the record, never a URL (M-08).
>
> Rule: search returns exactly the comments the module view shows the same user. A
>   parity test asserts row-set equality; it was seeded-only until this sprint.
> ```
>
> **`ADR-033-attachment-orphan-sweep.md`**
> ```
> # ADR-033 — Attachment orphan sweep is prefix-scoped and audited
> Status: Accepted • Pre-Sprint 12 (completes ADR-007's deferral)
> Cross-refs: ADR-007, INFRA §1 (R2 holds attachments+CVs+reports+backups),
>             THIRD-PARTY §4.1 (versioning, 90-day), §4.3 (UPLOAD_EXPIRY = 900)
>
> Context: an R2 object whose task_attachments row never materialised (presign issued,
>   upload completed, confirm never called) is a genuine orphan wasting bytes. An object
>   mid-upload looks identical.
>
> Decision:
>   1. Sweep = R2 keys under the ATTACHMENTS PREFIX ONLY with no matching task_attachments
>      row, whose LastModified is older than 1 HOUR (well past UPLOAD_EXPIRY_SECONDS = 900).
>   2. PREFIX SCOPE IS A CODE ASSERTION, NOT A COMMENT. The bucket also holds CVs, reports,
>      and backups. An unscoped "delete keys with no attachments row" deletes every backup.
>      This is the single most dangerous line in the sprint.
>   3. Age comes from R2 LastModified (the orphan has no DB row to carry a timestamp).
>   4. Never delete on a DB-side "pending" flag alone — the crash being cleaned up after is
>      exactly the one that fails to set it.
>   5. Every deletion audited to the System Actor (key, reason, age).
>   6. R2 versioning (90-day) means a delete writes a delete-marker; an over-aggressive
>      sweep is recoverable within 90 days. This LOWERS risk; it does NOT excuse the scoping.
>   7. The OTHER orphan direction (DB row with no R2 object — a broken link) is handled
>      LAZILY at download time (presign requested, HEAD fails -> mark the row), NOT by a
>      cron HEAD-storm.
>
> Rule: a scheduled deleter with no user watching gets a scope it cannot exceed, asserted
>   in code, and an audit trail for every byte it removes.
> ```
>
> **`ADR-034-coming-shoot-date-recompute.md`**
> ```
> # ADR-034 — coming_shoot_date recompute has one implementation
> Status: Accepted • Pre-Sprint 12 (executes ADR-012 §4)
> Cross-refs: ADR-012 (Trigger 1), ADR-013 (version-bump rule), 05-BACKEND-SCHEMA
>
> Context: the daily rollover recompute and the live Trigger 1 both write
>   content_pipelines.coming_shoot_date. Two implementations of one recompute is the
>   permission-resolver bug (8.1) in a different table — and it drifts SILENTLY because
>   both write a plausible value.
>
> Decision:
>   1. ONE function: recomputeComingShootDate(clientId, period, actor, trx).
>      Trigger 1 calls it (one client, on shoot confirm, human actor).
>      The rollover cron calls it (all active clients for the new period, System Actor).
>      Same guards, same result, differ only in actor + scope.
>   2. Semantics (ADR-012): coming_shoot_date = MIN(slot_date WHERE status='Confirmed'
>      AND slot_date >= today), guarded against source='manual', orthogonal write,
>      NO VERSION BUMP (ADR-013).
>   3. The source='manual' guard is the part that drifts if duplicated — one copy forgets
>      it and an admin's override silently vanishes at rollover. It lives in the one function.
>   4. If STEP 1 finds the recompute inline in the shoot-confirm handler, EXTRACT it first;
>      the cron reuses the extraction, never a copy.
>
> Rule: parity-tested — cron-recompute and trigger-recompute produce identical output for
>   the same state, including the manual-override case.
> ```
>
> **Amend `ADR-030`** — append a build-detail section:
> ```
> ## Amendment (Sprint 12 build)
> Schedule: 03:00 IST, MONTHLY, on the existing cron service, well clear of the 00:01
>   rollover window. A long DELETE holding locks while rollover's atomic transaction is
>   open is the one way to turn two safe jobs into an outage.
> Batching: delete in BOUNDED CHUNKS, each chunk a set of WHOLE conversations in one
>   statement. ADR-030 requires a parent+children in one statement (so NO ACTION's
>   statement-end check lets them delete together); it does NOT require the entire 12-month
>   purge in one statement. A single monster DELETE locks messages during live chat.
> Scope: this job is the 12-month message cleanup (bot + chat via whole-conversation delete,
>   plus expired bot_sessions envelopes). NOT the 2-year audit-log archival (separate, later)
>   and NOT the 30-day report/backup R2 lifecycle (R2 lifecycle rules, Infra §7).
> ```
>
> Show me the three new files and the ADR-030 amendment.

**Verify:**

```bash
ls docs/decisions/ADR-03{2,3,4}*.md
grep -n "Amendment (Sprint 12" docs/decisions/ADR-030*.md
git add docs/decisions/ && git commit -m "docs(decisions): ADR-032 comment visibility, 033 attachment sweep, 034 recompute single-impl; amend 030 retention schedule+batching"
```

### 1.4 — Branch

```bash
git checkout -b sprint-12-comments-jobs
```

**Verify gate:** Sprint 11 merged, ADR-031 staging done, full suite green, census complete (recompute shape known), three ADRs + one amendment committed. Proceed.

---

## SPRINT 12 — STEP 2: Comment schema check

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 12, STEP 2. Confirming the comment schema before building on it. Read `docs/05-BACKEND-SCHEMA.md` (`comments` — `id`, `record_type`, `record_id`, `parent_id`, `author_id`, `content`, `search_vector` GENERATED + GIN from migration 025, `deleted_at`).
>
> My STEP 1.2 census showed: **[paste the `\d comments` output]**.
>
> **WHAT TO BUILD**
>
> - **If the `comments` table and its `search_vector` GIN index exist (they should — migration 025):** no migration. Confirm the columns match what `CommentService` (STEP 3) needs — `record_type` enum covering the commentable modules (tasks, content_calendar, shoot_schedules per Auth-Matrix), `parent_id` FK to `comments(id)` for threading, `author_id` FK to `staff(id)`. Report any gap; do **not** invent columns the schema doesn't have.
> - **Only if a genuine column is missing:** a single additive migration (with its reverse), commented as additive per NFR §3.1.
> - Confirm `GRANT SELECT, INSERT, UPDATE ON comments` exists (soft delete is an UPDATE); add it if missing.
>
> **RULES:** additive only. Do not recreate the table or the `search_vector` index — they exist. Do not add a `comment:new` anything.
>
> Show me the column reconciliation, then any migration (or confirm none needed).

**Verify:**

```bash
psql "$DATABASE_URL" -c "\d comments" | grep -i "search_vector\|parent_id\|record_"
pnpm --filter @skaly/api db:status
```

---

## SPRINT 12 — STEP 3: `CommentService` + the shared visibility predicate (ADR-032)

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 12, STEP 3. The comment write/read path and the visibility predicate Sprint 9's search has waited three sprints for. Read `docs/decisions/ADR-032` (follow it exactly), `docs/08-AUTH-MATRIX.md` §3–§4 + §8, `docs/04-APPFLOW.md` (comment flow), `apps/api/src/services/NotificationService.ts` (the 18-type registry — `new_comment` is one of them), and `apps/api/src/lib/queries.ts` (`softDelete`, `softDeletable`).
>
> **WHAT TO BUILD**
>
> 1. **⭐ `apps/api/src/lib/comment-visibility.ts`** — the single predicate, exported as a Kysely expression-builder fragment:
>    ```ts
>    export function commentVisibility(user: RequestUser) {
>      return (eb: ExpressionBuilder<DB, 'comments'>) => {
>        // JOINs comments -> staff for author.role at read time
>        // admin/manager   -> no restriction
>        // team_member     -> eb('comments.author_id','=',user.staffId)
>        //                       OR author.role IN ('admin','manager')
>        // freelancer      -> restricted to records they own (shoot rows),
>        //                       then own + supervisors
>      };
>    }
>    ```
>    This is the **only** place the rule is written. STEP 4 imports it; nothing reimplements it.
>
> 2. **`CommentService.create(input, currentUser, db)`** — one transaction:
>    a. Validate `{ recordType, recordId, content, parentId? }`. Assert the target record exists and the user can access it (a comment on an invisible record is nonsense).
>    b. Insert `{ record_type, record_id, author_id, content, parent_id? }`. `search_vector` is GENERATED — do not set it.
>    c. **Fan out `new_comment` per participant** — the record's assignee (for tasks) plus prior distinct commenters on the same `(record_type, record_id)` — **excluding the author** (ADR-006). One notification per recipient, via `NotificationService` → `notify:new` typed delivery. **Not** a `comment:new` socket event.
>    d. Return the comment with the author's display name.
>
> 3. **`CommentService.list({ recordType, recordId }, currentUser, db)`** — applies `commentVisibility(currentUser)` and `softDeletable`, threaded (parents with nested replies, oldest first).
>
> 4. **`CommentService.remove(id, currentUser, db)`** — `softDelete` from `lib/queries.ts`. Author, or admin/manager. A soft-deleted parent keeps its thread (tombstone in the UI), same as chat.
>
> **RULES**
>
> - The visibility fragment is written once. If STEP 4 needs the same rule and you're tempted to re-type it, import instead.
> - `new_comment` via `notify:new` type, `linkBuilder` returning an in-app route to the record (M-08). Grep to confirm no `comment:new` event exists.
> - Never notify the author of their own comment.
> - Content stored raw (rendered/sanitised at display, STEP 9).
>
> **Tests:**
> - `create` inserts the comment + fans out `new_comment` to the assignee and prior commenters, **not** the author (TESTED distinct counts).
> - **⭐ Visibility:** a team_member sees own + a manager's comment on the same record, but **not** a peer team_member's; a freelancer sees comments only on their own shoot rows; admin sees all. Assert against `CommentService.list`.
> - A soft-deleted comment vanishes from `list` but its replies survive.
> - `search_vector` is not settable (GENERATED) — inserting with it errors or is ignored.
>
> Show me `comment-visibility.ts` first, then `create` with the fan-out.

`▶ /ponytail` — the visibility fragment is the sprint's highest-value target: it must read as one rule with role branches, not three near-duplicate queries. And the fan-out (assignee ∪ prior commenters, minus author, dedup) is his kind of set expression.

**Verify:**

```bash
pnpm --filter @skaly/api test services/CommentService lib/comment-visibility
pnpm typecheck
```

---

## SPRINT 12 — STEP 4: Comment routes + wire the search comments category (ADR-015 parity)

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 12, STEP 4. Comment routes and making Sprint 9's search comments category live. Read `docs/07-API-CONTRACT.md` (`/v1/comments/*`, the comments category in `/v1/search`), `docs/decisions/ADR-015` (the parity discipline) + `ADR-032`, and `apps/api/src/services/SearchService.ts` (the comments query that has returned empty).
>
> **WHAT TO BUILD**
>
> 1. **Routes** (all gated by record-access; the service applies the visibility predicate):
>    - `GET /v1/comments?recordType=&recordId=` → `CommentService.list`
>    - `POST /v1/comments` → `create`
>    - `DELETE /v1/comments/:id` → `remove`
> 2. **Zod** `packages/shared/src/schemas/comments.ts`, `.strict()`; content `min(1).max(2000)`; `recordType` the enum from the schema.
> 3. **⭐ Wire the search comments category** — in `SearchService.searchComments`, replace whatever placeholder returns empty with a real query: `comments.search_vector @@ websearch_to_tsquery('english', $1)`, ranked by `ts_rank`, **applying the exact same `commentVisibility(currentUser)` fragment** imported from STEP 3. Not a re-typed WHERE — the import.
> 4. **Route tests:** every role's comment access matches Auth-Matrix; `.strict()` rejects unknown fields; envelopes per §1.1.
> 5. **⭐ Search-parity test (ADR-015, now real):** for a given user and a search term, `SearchService`'s comment rows **equal** what `CommentService.list` returns for the records those comments belong to — same predicate, same rows. This is the test that proves "written once" held. It was seeded-only; now it runs against live data.
>
> **RULES:** the search comments query imports the predicate — it does not re-implement it. The route does not filter; the service does.
>
> Show me the search comments query (with the imported predicate), then the parity test.

`▶ /ponytail` — check that `SearchService.searchComments` and `CommentService.list` genuinely share the fragment and haven't diverged into two shapes that happen to agree today.

**Verify:**

```bash
pnpm --filter @skaly/api test services/SearchService services/CommentService routes/comments
pnpm --filter @skaly/api dev    # /docs lists the comment routes; CMD+K comments category now returns results
```

---

## SPRINT 12 — STEP 5: Attachment orphan cron (ADR-033)

**Goal:** A scheduled deleter that can never exceed its scope.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 12, STEP 5. The attachment orphan sweep. Read `docs/decisions/ADR-033` (follow it exactly), `docs/10-INFRA-DEPLOYMENT.md` §1 (**R2 holds attachments + CVs + reports + backups**) + §4 (cron service), `docs/11-THIRD-PARTY-INTEGRATIONS.md` §4.1 (versioning) + §4.3 (`UPLOAD_EXPIRY_SECONDS` = 900), and `apps/api/src/lib/r2.ts`.
>
> **HARD CONSTRAINT:** the sweep is scoped to the attachments prefix ONLY, asserted in code. The bucket also holds backups. An unscoped sweep deletes every backup. This is the most dangerous line in the sprint.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/src/jobs/attachment-orphan-sweep.ts`**:
>    a. `ListObjectsV2Command` over the **attachments prefix only** (e.g. `task-attachments/`). Assert the prefix is non-empty and is the attachments prefix before the first call — a bug that drops the prefix must fail loudly, not sweep the whole bucket.
>    b. For each key: does a `task_attachments` row reference it? Batch the lookup (one `WHERE r2_key IN (…)` per page, not a query per object).
>    c. Delete a key only if **no row references it AND `LastModified` is older than 1 hour** (well past the 900s presign window). Age from R2 `LastModified`, not any DB timestamp.
>    d. `DeleteObjectsCommand` in batches; R2 versioning turns each into a delete-marker (90-day recoverable — Infra note, not a safety excuse).
>    e. **Audit every deletion** to the System Actor (`00000000-…-0`): key, reason (`orphan`), age.
>    f. Log a summary (scanned, orphaned, deleted, skipped-too-recent).
>
> 2. **Register on the Railway cron service** — **daily**, clear of the rollover window (e.g. 04:00 IST). Same `X-Internal-Secret` pattern as rollover/backup.
>
> 3. **Lazy dangling-ref handling** (the OTHER orphan direction) — in the attachment *download* path, if the presign target `HEAD`s as missing, mark the `task_attachments` row (a `missing_at` timestamp or soft-delete) and return a clean error. **Not** a cron HEAD-storm over every row.
>
> **RULES**
>
> - Prefix scope asserted, not commented. Fail loudly if the prefix is empty.
> - Age from R2 `LastModified`. Never a DB "pending" flag.
> - Every deletion audited. This is an unattended deleter; the audit trail is how anyone ever finds out what it removed.
> - Idempotent — safe to run twice back-to-back.
>
> **Tests:**
> - An orphan (no row) older than 1h in the attachments prefix → deleted + audited.
> - An orphan **younger** than 1h → skipped (mid-upload protection).
> - A key **with** a `task_attachments` row → never touched regardless of age.
> - **⭐ A key under a DIFFERENT prefix (a seeded "backup/" or "cvs/" key) with no attachments row → NEVER touched** (the guard that matters most — assert the sweep didn't even consider it).
> - **⭐ An empty/missing prefix throws before any delete** (the fail-loud assertion).
> - Lazy path: a download whose object is gone marks the row and returns a clean error.
> - Idempotent: two runs delete the same set once.
>
> Show me the prefix assertion and the sweep loop first, then the audit call.

`▶ /ponytail` — the sweep loop (list → batch-lookup → filter-by-age → batch-delete → audit) is a clean pipeline that will accrete edge cases. Keep it a pipeline. The prefix assertion, though, he does not touch — it stays explicit and loud.

**Verify:**

```bash
pnpm --filter @skaly/api test jobs/attachment-orphan-sweep
# manual dry-run against a scratch bucket if available; confirm the summary log and zero backup-prefix touches
```

---

## SPRINT 12 — STEP 6: `coming_shoot_date` rollover recompute (ADR-034)

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 12, STEP 6. The rollover recompute — the same function Trigger 1 uses. Read `docs/decisions/ADR-034` (follow it exactly) + `ADR-012` (Trigger 1 semantics) + `ADR-013` (version-bump rule), `docs/09-ERROR-HANDLING.md` §7 (rollover context), and the recompute code my STEP 1.2 census located: **[paste — extracted function or inline]**.
>
> **WHAT TO BUILD**
>
> 1. **If the recompute is inline in the shoot-confirm handler:** extract it to `recomputeComingShootDate(clientId, period, actor, trx)` first, and repoint Trigger 1 at the extraction. Confirm Trigger 1's tests still pass — you've moved code, not changed behaviour.
>    **If it's already a function:** confirm its signature carries an `actor` (so the cron can pass the System Actor) and leave the trigger's call site untouched.
> 2. **The rollover cron path** — in the rollover job (00:01 IST), after the period rows are created, call `recomputeComingShootDate` for **every active client** for the new current period, actor = System Actor, inside the rollover transaction. Same function, same `source='manual'` guard, same no-version-bump.
> 3. **The guard is the point:** an admin's manually-set `coming_shoot_date` (`source='manual'`) is never overwritten — by the trigger or the cron, because it's one function. Verify the guard is in the shared function, not duplicated at either call site.
>
> **RULES**
>
> - One function. The cron reuses it; it does not reimplement the MIN-of-confirmed-slots logic.
> - System Actor for the cron write; `changed_by_source` per ADR-012's orthogonal-write rule.
> - No version bump (ADR-013 orthogonal-column write).
> - Inside the rollover transaction — a recompute that half-runs and half-fails must roll back with the rest.
>
> **Tests:**
> - **⭐ Parity:** cron-recompute and trigger-recompute produce **identical** `coming_shoot_date` for the same client/period slot state (TESTED across several states — no confirmed slots, one, multiple, all past).
> - **⭐ Manual override survives:** a client with `source='manual'` `coming_shoot_date` is **not** overwritten by the cron recompute (the silent-drift case ADR-034 exists to prevent).
> - The cron recompute writes with the System Actor and does not bump `version`.
> - A recompute failure rolls back the rollover transaction (no half-updated pipeline rows).
>
> Show me the extraction (or the confirmation it's already a function), then the cron call site.

`▶ /ponytail` — the extraction itself is his move: a function that exists inline and needs to become callable without changing what it does. Point him at it before the tests are written against the new signature.

**Verify:**

```bash
pnpm --filter @skaly/api test services/ShootPlannerService jobs/rollover
pnpm typecheck
```

---

## SPRINT 12 — STEP 7: Message retention job (ADR-030)

**Goal:** Delete whole conversations past 12 months, batched, never locking live chat.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 12, STEP 7. ADR-030's retention job — recorded pre-Sprint-11, built now with the Sprint 12 amendment. Read `docs/decisions/ADR-030` **including the amendment** (follow it exactly), `docs/decisions/ADR-018` (bot archive — whole conversations bounded by `bot_sessions.last_activity_at`), `docs/13-NFRS.md` §5.1–§5.2 (bot messages 12 months), and `docs/05-BACKEND-SCHEMA.md` (`messages` — `parent_id` **NO ACTION**).
>
> **HARD CONSTRAINTS (ADR-030):**
> - `messages.parent_id` stays `ON DELETE NO ACTION`. The job does **not** alter the FK. It works *because* NO ACTION checks at statement end — a whole conversation deletes in one statement without splitting a turn-pair.
> - Delete **whole conversations, batched.** ADR-030 requires a parent+children in one statement; it does **not** require the entire purge in one statement. Batch by conversation — a single monster DELETE locks `messages` during live chat.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/src/jobs/message-retention.ts`**:
>    - **Bot conversations:** identify conversations whose `bot_sessions.last_activity_at` is older than 12 months. Delete each conversation's messages as one statement (`WHERE parent_id = $conv OR id = $conv` or the session's message set), the parent and children together. **Batch** — N conversations per iteration, loop until clear. Delete the `bot_sessions` envelope in the same iteration.
>    - **Chat messages:** a reply older than 12 months deletes on age (deleting a child never violates the FK). A **parent** deletes only when its **newest reply** is also older than the cutoff and goes in the same statement. Exclude any parent with a reply newer than the cutoff.
>    - Each batch is one statement satisfying the whole-conversation rule; between batches, other traffic proceeds.
>    - Audit a summary (conversations deleted, messages removed) to the System Actor — not per row (that would be 15k audit rows for one run).
> 2. **Schedule:** register on the cron service — **03:00 IST, monthly**, well clear of the 00:01 rollover window (ADR-030 amendment). A long DELETE holding locks while rollover's transaction is open is the one outage path.
> 3. **Scope discipline:** this job is **only** the 12-month message cleanup (bot + chat + expired `bot_sessions`). It is **not** the 2-year audit-log archival and **not** the 30-day report/backup R2 lifecycle. Do not delete audit rows or R2 objects here.
>
> **RULES**
>
> - Do not touch `messages_parent_id_fkey`. NO ACTION is load-bearing; RESTRICT would break the batched delete, CASCADE loses chat replies, SET NULL re-orphans bot replies.
> - Batched. No single statement covering the whole purge.
> - Whole conversations only — never half a turn-pair.
> - Summary audit, not per-row.
>
> **Tests (⭐ built from Sprint 9's teardown case):**
> - Seed a bot **parent + child straddling the cutoff** (session `last_activity_at` just past 12 months) → the job deletes **both**, in one statement, **neither errors nor splits the pair** (the exact failure Sprint 9's teardowns demonstrated).
> - A conversation with `last_activity_at` just **inside** the window → **whole** conversation retained.
> - Just **past** → whole conversation deleted, envelope gone.
> - A chat parent with one old + one **new** reply → parent **retained** (a reply is newer than the cutoff).
> - A chat parent whose replies are all old → parent + replies deleted together.
> - **Batching:** with N conversations past the cutoff and a small batch size, the job completes in multiple statements and deletes each conversation exactly once.
> - Nothing outside `messages`/`bot_sessions` is touched (no audit rows, no R2 objects deleted).
>
> Show me the bot-conversation batched delete and the chat-parent exclusion first, then the straddling-pair test.

`▶ /ponytail` — the bot-conversation delete and the chat-parent delete share a "select the deletable set, delete in one statement, loop" skeleton around different selection logic. That skeleton is his; the two selection predicates stay distinct.

**Verify:**

```bash
pnpm --filter @skaly/api test jobs/message-retention
pnpm typecheck
```

---

## SPRINT 12 — STEP 8: Carry — `['months']` key unification (ADR-029 pattern)

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 12, STEP 8. The Sprint 11 carry: `month:lock_changed` was emitted with no web consumer. Read `docs/decisions/ADR-029` (the permission-push pattern this mirrors) + `ADR-019` (patch-vs-invalidate), `docs/08-AUTH-MATRIX.md` (period lock), and the Sprint 11 months lock/unlock code.
>
> **WHAT TO BUILD**
>
> 1. **A `month:lock_changed` web consumer** — subscribe (via the Sprint 10 socket client, riding ADR-022's self-heal), and on receipt **invalidate the `['months']` query** (and any per-period lock-state query) so every grid re-derives its read-only state. This is a **patch/invalidate** decision (ADR-019): the payload carries `{ period, locked }`, which fully specifies the change, so **patch** the cached lock state rather than a broad invalidate where the payload suffices.
> 2. **Unify the `['months']` query key** — if lock state is read under inconsistent keys across grids (Sprint 11's carry), consolidate to one key so a single invalidation/patch flips all consumers. Grep for `['months'` usages first.
> 3. **The proactive read-only flip is UX only.** When a period locks, grids that show it flip to read-only *proactively* — but **the backend `423 PERIOD_LOCKED` on write remains the enforcement boundary** (ADR-029's rule, applied here). A missed `month:lock_changed` event means a grid looks editable until the next fetch, and the write still 423s. Fail-safe.
>
> **RULES**
>
> - The lock check does not move to the client. The client flip is a nicety over a server boundary.
> - Ride ADR-022's self-heal — do not add a bespoke reconciliation path for this one event.
> - One `['months']` key.
>
> **Tests:** `month:lock_changed` invalidates/patches the `['months']` key; a locked period flips affected grids read-only without a reload; a write to a locked period still returns 423 (the boundary is unchanged); a missed event self-heals on the next fetch (ADR-022).
>
> Show me the consumer and the key unification.

`▶ /ponytail` — check whether the read-only-flip logic now lives in one place keyed off the unified query, or is scattered per grid.

**Verify:**

```bash
pnpm --filter @skaly/web test
grep -rn "\['months'" apps/web/src   # one key shape
```

---

## SPRINT 12 — STEP 9: Frontend — comment threads + tests

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 12, STEP 9. Comment UI on module records. Read `docs/03-UIUX.md` (comment thread pattern, DM Mono timestamps), `docs/04-APPFLOW.md`, `docs/13-NFRS.md` §4.3 (DOMPurify), and the Sprint 10 chat message renderer (comments share its shape — grouping, mentions, tombstones).
>
> **WHAT TO BUILD**
>
> 1. **`CommentThread`** — attaches to a module record (task detail, calendar cell popover, shoot row), not a standalone page. Renders `GET /v1/comments?recordType=&recordId=` threaded (parent + replies), author + DM Mono timestamp, mention highlight for the current user, soft-deleted → tombstone.
> 2. **Composer** — Enter posts, Shift+Enter newline, `@` mention autocomplete over accessible staff (reuse the chat composer's mention logic — don't fork it).
> 3. **Content rendered as text with a linkifier** — DOMPurify only where HTML is genuinely constructed; **no `dangerouslySetInnerHTML`** (grep clean, per NFR §4.3).
> 4. **Live updates** — a new comment on the open record appears via... **`notify:new` is a notification, not the comment delivery channel.** For the open thread, either refetch on the `new_comment` notification for that record, or (cleaner) a lightweight `['comments', recordType, recordId]` invalidation triggered by the notification. Do **not** invent a `comment:new` socket event.
> 5. **Frontend tests:** thread renders parent + replies; a mention of the current user highlights; a soft-deleted comment shows a tombstone; posting clears the composer; a `<script>` in content renders as literal text; the mention autocomplete lists only accessible staff.
>
> **RULES**
>
> - Reuse the chat composer's mention logic; do not fork it.
> - No `dangerouslySetInnerHTML`.
> - No `comment:new` socket event — comments update off the `new_comment` notification or a query invalidation.
>
> Show me `CommentThread` and the composer.

`▶ /ponytail` — comments and chat now have two message renderers with a lot in common (grouping, mentions, tombstones, linkify). Ask him whether the shared parts want a common primitive before you have two copies to maintain.

**Verify:**

```bash
pnpm --filter @skaly/web test
grep -rn "dangerouslySetInnerHTML" apps/web/src   # expect: nothing
pnpm dev   # comment on a task, @mention someone, see the notification fire; delete → tombstone
```

---

## SPRINT 12 — STEP 10: Carry — representative-volume report perf pass + job tests

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 12, STEP 10. The Sprint 11 carry: the report perf pass at representative volume, plus rounding out job tests. Read `docs/13-NFRS.md` §1.2 (reports p95 < 10s / p99 < 20s) + §2.2 (data volume), and `docs/12-TESTING-STRATEGY.md`.
>
> **Context:** Sprint 11's report async accept measured ~13ms; the request→ready path was ~3s on a **small** local seed. NFR §1.2's targets are for **representative volume** — this pass measures on realistic data, n≥100.
>
> **WHAT TO BUILD**
>
> 1. **A representative-volume seed** for the heaviest report type — realistic row counts per NFR §2.2 (e.g. a full month of attendance × 10 staff, ~100 tasks, 20 clients × 31 calendar cells). Not the minimal fixture the functional tests use.
> 2. **A perf measurement** (k6 or a scripted loop, n≥100 generate→ready cycles): record p95 and p99 of the **full request→ready** duration (not just the 202 accept). Assert p95 < 10s, p99 < 20s.
> 3. **Confirm the API stays responsive during the batch** — the ADR-027 property, re-verified under representative load: `/v1/health` flat while renders run (they're off the event loop in workers, so this must hold).
> 4. **The concurrency cap under load** — fire more than the cap simultaneously; confirm they queue rather than spawning unbounded workers, and the queue drains.
> 5. **Job-suite consolidation** — the attachment sweep, recompute parity, and retention tests all green together; the three crons registered on the cron service with the correct schedules (sweep 04:00 daily, retention 03:00 monthly, both clear of 00:01 rollover).
>
> **RULES:** measure the full path, not the accept. This is a pre-launch gate item (NFR §1.2) — if p95/p99 miss, that's a finding to record, not a number to fudge.
>
> Show me the perf harness and the p95/p99 assertion.

**Verify:**

```bash
pnpm --filter @skaly/api test jobs
# perf run (representative seed):
pnpm --filter @skaly/api test:perf reports   # or the k6 script — p95 < 10s, p99 < 20s
```

---

## SPRINT 12 — STEP 11: Playwright E2E

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 12, STEP 11. E2E for comments and the visible effects of the jobs. Read `docs/12-TESTING-STRATEGY.md`. Reuse the Sprint 3–11 `loginAs` and config; two contexts where a change must reach another session. **Use `priorIstPeriod()` for any period-relative fixture (A6) — no pinned `-15` dates.**
>
> **WHAT TO BUILD** — `tests/e2e/comments.spec.ts`, and job-effect assertions where they surface in the UI:
>
> **comments.spec.ts**
> 1. A team_member comments on a task → a manager sees it and replies → **the team_member sees the manager's reply**; a second team_member (a peer) opening the same task does **not** see the first's comment (the visibility rule, end to end).
> 2. @-mention in a comment → the mentioned user's **bell increments** (`new_comment` via `notify:new`); the notification deep-links to the record (an in-app route, not a raw URL).
> 3. A comment appears in **CMD+K search** results for a user who can see it, and does **not** for a user who can't (search parity, live).
> 4. Soft-delete a comment → tombstone in both contexts.
> 5. A `<script>`-containing comment renders as literal text.
>
> **months (the carry):**
> 6. Lock a period in context A → context B's grid for that period flips read-only **without a reload**; a write attempt still returns the locked copy (the 423 boundary).
>
> Run headed once, then headless (chromium + webkit).
>
> **RULES:** independent, re-runnable; clean up comments and any lock state in teardown. Period fixtures derived, not pinned. Do not assert exact notification prose — assert the bell, the deep-link target, and the visibility outcomes.
>
> Show me the visibility spec and the search-parity spec first.

**Verify:**

```bash
pnpm exec playwright test tests/e2e/comments.spec.ts
pnpm exec playwright test      # ENTIRE suite green
```

---

## SPRINT 12 — STEP 12: Smoke + measurement + close-out (manual)

### 12.1 — Manual walk-through

1. **Comments + visibility:** as a team_member, comment on a task; as a manager, reply; confirm the team_member sees the reply. As a **peer** team_member, confirm the first's comment is **not** visible. As admin, see all. As a **freelancer**, confirm comments appear only on their own shoot rows.
2. **`new_comment`:** @mention someone → their bell fires; the notification opens the **record** (in-app route, not a presigned/raw URL — confirm in the address bar).
3. **Search parity:** search a comment term as a user who can see it (appears) and one who can't (absent).
4. **⭐ Attachment sweep (ADR-033):** seed an orphaned object under the attachments prefix (older than 1h) **and** a dummy object under `backup/` with no attachments row. Run the sweep. Confirm: the orphan is gone and audited to the System Actor; **the backup-prefix object is untouched**; a same-run repeat deletes nothing new. `SELECT * FROM audit_log WHERE staff_id = '00000000-...-0' AND action = 'DELETE' ORDER BY created_at DESC LIMIT 5;`
5. **⭐ Recompute parity (ADR-034):** set a client's `coming_shoot_date` to `source='manual'`. Trigger a rollover recompute (or invoke the cron path). Confirm the manual value is **untouched**. Confirm a non-manual client's value equals what a shoot-confirm trigger would compute.
6. **⭐ Retention (ADR-030):** seed a bot conversation with `last_activity_at` just past 12 months (a parent + child), and a chat parent with one old + one new reply. Run retention. Confirm: the bot pair is deleted together (not split, no error); the chat parent is **retained** (its reply is newer); `messages_parent_id_fkey` is still `NO ACTION`; nothing outside `messages`/`bot_sessions` changed. `SELECT conrelid::regclass, confdeltype FROM pg_constraint WHERE conname = 'messages_parent_id_fkey';` → `a` (NO ACTION).
7. **Months carry:** lock a period → grids flip read-only live in a second window → a write still 423s.
8. **Cron schedules:** confirm on the Railway cron service — sweep 04:00 IST daily, retention 03:00 IST monthly, both clear of 00:01 rollover; recompute runs inside rollover.
9. **⭐ Report perf (NFR §1.2):** the representative-volume run's p95 < 10s / p99 < 20s; `/v1/health` flat throughout.

`▶ /ponytail` — full-sprint review before the close-out checklist.

### 12.2 — Close-out checklist

```
PRE-FLIGHT
  [ ] Sprint 11 pushed + merged; ADR-031 staging MFA verification done; 2 E2E skips confirmed legit
  [ ] Full suite + Playwright green BEFORE Sprint 12 code
  [ ] Trigger 1 recompute shape known (extracted vs inline)
  [ ] ADR-032/033/034 committed to docs/decisions/; ADR-030 amended

COMMENTS (ADR-032)
  [ ] comments table + search_vector NOT recreated (migration 025 exists); additive-only if anything
  [ ] ⭐ commentVisibility() is ONE fragment; CommentService.list AND SearchService import it (not re-typed)
  [ ] team_member sees own + manager/admin; PEERS HIDDEN (TESTED); freelancer own shoot rows only
  [ ] Author role JOINed at read time, not denormalised
  [ ] create fans out new_comment per participant, never the author (TESTED)
  [ ] ⭐ new_comment via notify:new TYPE — NO comment:new socket event (grep clean)
  [ ] linkBuilder returns an in-app route, never a URL (M-08)
  [ ] Soft delete tombstones; replies survive
  [ ] ⭐ Search comments category live; parity test real (search rows == list rows, TESTED)
  [ ] Content raw in DB; no dangerouslySetInnerHTML (grep clean)

ATTACHMENT SWEEP (ADR-033)
  [ ] ⭐ Prefix-scoped to attachments ONLY, ASSERTED in code (empty prefix throws)
  [ ] ⭐ A backup/cvs-prefix key with no attachments row is NEVER touched (TESTED)
  [ ] Orphan > 1h deleted; orphan < 1h skipped (mid-upload); keyed row never touched
  [ ] Age from R2 LastModified, never a DB flag
  [ ] Every deletion audited to the System Actor
  [ ] Dangling DB→R2 refs handled LAZILY at download, not a cron HEAD-storm
  [ ] Idempotent; registered daily 04:00 IST clear of rollover

RECOMPUTE (ADR-034)
  [ ] ONE recomputeComingShootDate function; extracted if it was inline; Trigger 1 repointed
  [ ] Cron reuses it (System Actor, all active clients); does NOT reimplement
  [ ] ⭐ Parity: cron-recompute == trigger-recompute for the same state (TESTED)
  [ ] ⭐ source='manual' override NEVER overwritten by the cron (TESTED)
  [ ] No version bump (ADR-013); inside the rollover transaction

RETENTION (ADR-030 + amendment)
  [ ] messages_parent_id_fkey UNTOUCHED — still NO ACTION (confdeltype = 'a')
  [ ] Whole conversations, BATCHED — no single statement covering the whole purge
  [ ] ⭐ Bot parent+child straddling the cutoff: deleted together, not split, no error (TESTED)
  [ ] Chat parent with a newer reply: retained (TESTED)
  [ ] bot_sessions envelopes deleted with their conversations
  [ ] Summary audit, not per-row
  [ ] Registered 03:00 IST MONTHLY, clear of rollover
  [ ] Scope: messages + bot_sessions only — no audit rows, no R2 objects

CARRIES
  [ ] month:lock_changed has a web consumer; ['months'] key unified (one shape)
  [ ] Locked period flips grids read-only live; write still 423s (boundary unchanged)
  [ ] ⭐ Report perf at representative volume: p95 < 10s / p99 < 20s, n≥100 (MEASURED)
  [ ] /v1/health flat during the perf batch; concurrency cap holds under load
  [ ] A6: remaining pinned fixtures → priorIstPeriod()

TESTS + NFRs
  [ ] Full API, frontend, Playwright suites green
  [ ] Every new test fails without its fix
  [ ] Job tests seeded from the real failure cases (straddling pair, backup-prefix key, manual override)
  [ ] pnpm typecheck + pnpm lint clean
  [ ] /ponytail run at each build step — no outstanding flags
```

### 12.3 — Commit

```bash
git add -A
git commit -m "Sprint 12: comment system + shared visibility predicate (ADR-032) + new_comment; attachment orphan sweep (ADR-033); coming_shoot_date recompute single-impl (ADR-034); session-scoped batched message retention (ADR-030); ['months'] key unification + representative-volume report perf pass"
git push -u origin sprint-12-comments-jobs
```

PR to `main`; CI fully green before merge. Merge, then `git checkout main && git pull`.

### 12.4 — Move to Sprint 13

`MASTER-BUILD-GUIDE-V2-FINAL.md` → PART 9 → **SPRINT 13 — ROLLOVER, HARDENING & LAUNCH**: the full nightly rollover transaction and its four notification types (`month_ready`, `rollover_success`, `rollover_failed`, `rollover_view_refresh_failed` — the **last** of ADR-017's deferred types), the rollover-failure AI summary (Error-Handling §7), the materialised-view refresh, and the pre-launch gate. With Sprint 12 merged, the comment system closed the last deferred feature and all six deferred notification types now have producers except the rollover four, which Sprint 13 delivers.

---

## DECISIONS TO MAKE BEFORE SPRINT 13

- **⚠️ Rollover is the highest-stakes transaction in the product, and it now has three new passengers.** The recompute (STEP 6) runs inside it, the retention job runs adjacent to it, and rollover itself creates the next period's rows for every client. Decide the **atomicity boundary** before building: rollover is specified as a single atomic transaction (NFR §3.1, < 5 min), but the materialised-view refresh (dashboard data) can fail independently and has its own notification type (`rollover_view_refresh_failed`). So the row creation + recompute must be one transaction that either fully commits or fully rolls back, while the view refresh is a **separate, post-commit** step whose failure degrades the dashboard but does not undo the rollover. Confirm that split — a view refresh inside the main transaction means a refresh failure rolls back a successful rollover, which is worse than stale dashboard data.

- **The four rollover notification types and the AI summary.** `month_ready` (success, to all), `rollover_success` (admins), `rollover_failed` and `rollover_view_refresh_failed` (admins, with the Error-Handling §7 Claude-generated plain-language incident summary). These are the last of ADR-017's deferred six. Decide: the failure summary calls the Anthropic API from inside a cron with no user waiting — it must use the SDK retry (Sprint 8 amendment) and, if the API is down after retries, fall back to a **templated** incident message rather than no notification at all. A rollover that fails silently because the *summary* generation also failed is the worst case.

- **Rollover idempotency and the retry policy.** Infra §4 fires the rollover cron with a curl + `X-Internal-Secret`; the endpoint retries 3× on failure (Error-Handling §7). Decide what makes rollover **safe to run twice** — if it partially committed then retried, it must not double-create period rows. A `months` row for the target period as the idempotency key (create-if-absent, skip-if-present) is the natural guard; confirm it exists before Sprint 13 wires the retry.

- **Pre-launch gate items now due.** With Sprint 13 as the last sprint, the deferred pre-launch items come due together: the **representative-volume report perf** result (STEP 10 — if it missed, it's a launch blocker now); the **Socket.io Redis adapter** (only if a second API instance is planned at launch — if launch is single-instance, this stays deferred with a note); and a **backup restore drill** (Infra §7 — the monthly drill should run once against a real backup before launch, not first in anger). Decide which are launch-blocking vs fast-follow.

- **Still deferred, on schedule:** the 2-year audit-log archival to R2 cold storage (NFR §5.2 — genuinely post-launch, a year-two concern); any Phase-2 mobile work (Expo, push — out of MVP scope entirely).

---

## TROUBLESHOOTING — SPRINT 12 SPECIFIC

### CMD+K comments category still returns nothing
The search query wasn't wired to the real predicate, or `new_comment`/comment writes aren't landing rows. Confirm `SearchService.searchComments` imports `commentVisibility` and queries `search_vector`, and that `POST /v1/comments` actually inserts. It has been empty for three sprints — this is the sprint it stops being empty.

### A team_member sees a peer's comment (or can't see a manager's)
The visibility predicate drifted between the two call sites, or was written twice. There must be **one** `commentVisibility` fragment, imported by both `CommentService.list` and `SearchService`. If search and the module view disagree, they're not sharing the fragment.

### `new_comment` notifications never arrive
It was wired as a `comment:new` socket event instead of a `notify:new` type. Grep for `comment:new` / `emit('comment` — the same class of bug Sprint 11 caught with `report_ready`. Notifications are types over `notify:new`.

### The attachment sweep deleted a backup
The prefix scope was a comment, not an assertion, or was dropped. The sweep must `ListObjectsV2` under the attachments prefix **only**, and fail loudly if the prefix is empty. R2 versioning means the backup is recoverable within 90 days — recover it, then add the assertion that would have prevented it.

### The sweep deletes a file someone just uploaded
The 1-hour age gate is missing or reads a DB timestamp. Age comes from R2 `LastModified`, and anything under an hour old is treated as possibly mid-upload (the presign window is 15 minutes; an hour is the safety margin).

### An admin's manual `coming_shoot_date` got overwritten at rollover
The `source='manual'` guard is duplicated and one copy (the cron's) omits it — exactly the drift ADR-034 exists to prevent. There must be one `recomputeComingShootDate` with the guard inside it, called by both the trigger and the cron.

### The retention job errored on a foreign-key violation
Someone changed `messages_parent_id_fkey`, or the delete isn't whole-conversation. It must stay `NO ACTION` (which checks at statement end), and each statement must delete a parent and all its children together. RESTRICT breaks this; parent-first ordering breaks this.

### The retention job locked live chat for minutes
It ran as a single monster DELETE. Batch by conversation — bounded chunks, each a whole-conversation statement — so live traffic proceeds between batches (ADR-030 amendment).

### A grid stays editable after a period is locked
`month:lock_changed` was missed and the self-heal isn't wired, OR the `['months']` key isn't unified so only some consumers invalidated. The write still 423s regardless (the boundary is server-side) — but the proactive flip needs the consumer + one key + ADR-022's self-heal.

### Report perf misses p95 < 10s at representative volume
That's a **finding**, not a number to adjust. Record it — it's a pre-launch gate item (NFR §1.2). The likely cause is the render itself (the worker) rather than the accept; profile the PDF generation on realistic data.

---

## END OF SPRINT 12 DETAILED GUIDE

*Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1..11-DETAILED.md`. Source-of-truth precedence when documents differ: the numbered spec docs (`01`–`14`) + the schema win, then this guide's reconciliations and the decisions it executes (in `docs/decisions/`, ADR-006–034), then the Master Build Guide's shorthand. This sprint closes the last deferred feature — the comment system, whose visibility rule Sprint 9's search waited three sprints for — and builds the three background jobs that keep the data honest over time. The comments are ordinary CRUD; the jobs are not. Each writes to shared state on a schedule with no user watching, and each has one specific way to become a silent outage: an unscoped R2 sweep deleting backups, a duplicated recompute erasing a manual override, a monster DELETE locking the messages table. The tests for the three jobs are written from those failure modes, not their happy paths. Sprint 13 is rollover, hardening, and launch — read the first decision above before starting, because the atomicity boundary between the rollover transaction and the materialised-view refresh has to be settled before the first line of rollover code.*
