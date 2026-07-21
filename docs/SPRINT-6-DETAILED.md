# SPRINT 6 — CONTENT DROPPER + TRIGGER 1 & 2: DETAILED PROMPT-BY-PROMPT GUIDE

## Scaly Business Portal • Sprint 6 of 13

**Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1/2/3/4/5-DETAILED.md`**
**Same Goal / Prompt / Verify framework as Sprints 0–5**
**Tooling interfaces verified as of January 2026** — Next.js 15 (App Router), TanStack Table v8 + TanStack Query v5, Zustand 5, shadcn/ui on Tailwind 4 (`@theme`), Framer Motion 11, date-fns v4 (+ `@date-fns/tz` for IST), Playwright latest, Lucide React.

---

## USING THE `/ponytail` PLUGIN IN THIS SPRINT

This guide invokes **`/ponytail`** at each step's **Verify gate** — after the build passes its checks, before you proceed or commit — as a per-step review/checkpoint pass. Look for the `▶ /ponytail` line inside each **Verify** block.

> **Placement is an assumption.** I've slotted `/ponytail` in as a per-step review/checkpoint because that's the most common role for a "run at each step" plugin. **If `/ponytail` does something else in your setup (code review, context save, test runner, git helper, doc-gen), tell me its function and I'll re-place it precisely** — it's a thin, one-edit layer over the actual build steps. Until then, run it where marked and skip it if it doesn't fit.

---

## WHAT YOU'RE BUILDING IN SPRINT 6

Sprints 4–5 built modules that *emit* events into the void. Sprint 6 is where the wiring **closes the loop**: it consumes Sprint 5's `shoot:confirmed` / `shoot:reset` and produces `pipeline:posted` for Sprint 7. Its new patterns are the **event-driven orthogonal recompute** and the **derived-status stage pipeline**. By the end of this week:

- **The pre-Sprint-6 decisions are executed and recorded** (ADR-012): the Trigger 1 listener **recomputes** `coming_shoot_date` (not naive-push), **guarded** by `coming_shoot_source`, via an **orthogonal write** that does *not* bump `version`; and the daily-rollover refresh for time-staleness is locked for Sprint 12.
- **`ContentDropperService`** is real on the `content_pipelines` table: `getGrid` with **derived status** (no stored stage column); `updateStage` for the three manual stages (`raw` / `finals` / `posted`) with **service-layer sequence validation** (`STAGE_SEQUENCE_VIOLATION`), **`optimisticUpdate` / `version`** (C-02 — `content_pipelines` *is* versioned), and **server-set timestamps** (IST, H-02 principle).
- **Trigger 1 consumer** is wired: an EventBus listener on `shoot:confirmed` **and** `shoot:reset` recomputes `coming_shoot_date`. **This is where the Testing-Strategy §4.2 "coming_shoot_date is set after confirm" test finally passes.**
- **Trigger 2 producer** fires: reaching the `posted` stage emits `pipeline:posted { clientId, period, postedAt }` with a **server-side `CURRENT_DATE` (IST)** (audit H-02 — no `posted_date` column). Consumed by the Sprint 7 calendar.
- **Client name inline edit** works: `PATCH /v1/clients/:id { name }` (admin/manager) with cross-module cache invalidation.
- **The Content Dropper grid** renders per UI/UX §10: sticky 200px Client column + Visit Type + Last Shoot + **RAW / Finals / Posted** stage cells (dashed "Click to mark" when empty; timestamp + avatar when filled) + Coming Shoot (↑ indicator + "Set by Shoot Planner" tooltip when `source='trigger'`) + a 3px gold **progress bar** (% of stages complete), with **sequence-violation shake before the API call** and the gold column highlight.
- **Real-time is emitted, not consumed** (ADR-010): `pipeline:posted` fires (in-process for Sprint 7); no frontend socket client. Own-mutation refresh via TanStack Query invalidation.
- **Tests** prove it: stage sequence rejects skips; **Trigger 1 real-EventBus recompute** sets `coming_shoot_date` (source `'trigger'`, and *doesn't* clobber a `'manual'` value, and *doesn't* false-conflict a concurrent stage edit); **Trigger 2** fires `pipeline:posted` with the right server-side payload — plus a Playwright smoke for the full raw → finals → posted sequence.

**Estimated time:** 5 working days (Week 7 per `06-IMPLEMENTATION-PLAN.md` §9; owners TL + D1). Day 1 pre-flight + `ContentDropperService`; day 2 Trigger 1 consumer + Trigger 2 producer + routes; day 3 backend tests; days 4–5 frontend + E2E.

**Prerequisites from Sprint 5** (all green — stop and fix if any is not):

- Sprint 5 close-out fully checked; PR merged; CI green.
- ADR-011 committed; the **Sprint 2 EventBus declares `shoot:confirmed`, `shoot:reset`, `pipeline:posted`** (Sprint 5 added `shoot:reset`).
- Sprint 5 emits `shoot:confirmed` / `shoot:reset` correctly (spy-tested).
- The chassis works: `(portal)` layout + RBAC sidebar, `MonthContext`, `lib/api.ts`, `handleMutationError`, `useColumnHighlight`, `AuditService`, `NotificationService`, `BaseService` (`assertPeriodNotLocked`, **`optimisticUpdate`**, `softDeletable`, `getCurrentPeriod`), the Sprint 3 `generatePeriodRows` (which already creates the `content_pipelines` rows).
- `pnpm typecheck`, `pnpm lint`, and the full suite green on `main`.

---

## THE PRE-SPRINT-6 DECISIONS — WHERE THEY LAND

Ruled at the pre-Sprint-6 gate; **inputs** to this sprint. STEP 1 records ADR-012; the steps below execute the rest.

| Decision | Ruling | Executed in |
|---|---|---|
| **Trigger 1 = recompute, not naive push** | Listener recomputes `coming_shoot_date = MIN(slot_date WHERE Confirmed AND ≥ today)`, `NULL` if none. Never `SET = eventPayload.slotDate`. | STEP 3 |
| **Guard against `'manual'`** | Write only if `coming_shoot_source IN (NULL,'trigger')`; set `'trigger'`. Mirrors calendar M-04. | STEP 3 |
| **Orthogonal write (no version bump)** | The recompute is a targeted `UPDATE coming_shoot_date, coming_shoot_source` that does **not** bump `version` — it's orthogonal to the user-edited stage columns, so it must not false-conflict a concurrent stage PATCH. Only **user** writes (stage PATCH, manual override) use `optimisticUpdate` + bump version. | STEP 2 (stage) + STEP 3 (recompute) |
| **Stage → column mapping** | `raw → raw_received_at`, `finals → finals_ready_at`, `posted → posted_at`. Status **derived** at read time. Timestamps **server-set** (IST). Sequence `raw→finals→posted`. | STEP 2 |
| **Trigger 2 date = server `CURRENT_DATE` IST (H-02)** | `pipeline:posted` carries a server date; `posted_at` is the source; **no `posted_date` column**. | STEP 2 |
| **Time-staleness → Sprint 12 rollover recompute** | Event-driven recompute goes stale as a confirmed date passes; the daily rollover recomputes `coming_shoot_date` for all active clients. Frontend treats a past value as "no upcoming". | Recorded in ADR-012; built Sprint 12 |

---

## READ FIRST (Open in Antigravity Split View)

`@`-reference these with `@docs/04-APPFLOW.md`.

| Doc | Sections | Why |
|---|---|---|
| `docs/04-APPFLOW.md` | §7 (Content Dropper — the definitive stage flow + both triggers) | Every interaction + trigger point |
| `docs/07-API-CONTRACT.md` | §9 (content-dropper GET/stage) + §1.1 envelopes | Exact shapes |
| `docs/03-UIUX.md` | §10 (Content Dropper — 7 columns, stage cells, progress bar), §4.2 (cells), §4.4 (gold highlight), §4.3 (chips) | Every visual rule |
| `docs/08-AUTH-MATRIX.md` | §3–§4 (content-dropper access — admin/manager only; team_member/freelancer ❌) | Who edits |
| `docs/05-BACKEND-SCHEMA.md` | `content_pipelines` (307) — **`version`**, `coming_shoot_source`, the timestamp columns; `content_calendar` (for Trigger 2 target awareness) | Column truth |
| `docs/09-ERROR-HANDLING.md` | §2 (`STAGE_SEQUENCE_VIOLATION`, `STALE_DATA`, `PERIOD_LOCKED`), §3 | Error shapes |
| `docs/06-IMPLEMENTATION-PLAN.md` | §9 | Sprint 6 checklist |
| `docs/12-TESTING-STRATEGY.md` | §4.2 (Trigger 1 coming_shoot_date test — passes now; Trigger 2), §5.4 (lock tests) | The tests you must reproduce |
| `docs/adr/` | **ADR-010, ADR-012** (created STEP 1) | Real-time deferral + recompute semantics |

---

## CONSISTENCY RECONCILIATIONS — LOCK THESE BEFORE YOU PROMPT

The Master Build Guide's Sprint 6 shorthand drifts from the canonical specs in several places. The numbered specs + schema win; the corrections are baked into every prompt — know **why**:

1. **One thing, four names:** table `content_pipelines`, route `/v1/content-dropper`, service `ContentDropperService`, UI "Content Dropper". Every `content_dropper` **table** reference in the Master Guide means `content_pipelines`.
2. **Three manual stages: `raw` / `finals` / `posted`** → `raw_received_at` / `finals_ready_at` / `posted_at`. The Master Guide's "Shoot → Edit → Review → Posted" is the conceptual pipeline; **Shoot = `last_shoot_date`** (shoot-sourced, NOT a manual stage). `updateStage` takes `stage: 'raw' | 'finals' | 'posted'`. Source: `04-APPFLOW.md` §7 + `07-API-CONTRACT.md` §9.
3. **Status is DERIVED at read time** — there is **no stored `stage`/`status` column** (`04-APPFLOW.md` §7: "Pipeline status derived at query time (no stored field)"). `getGrid` computes it from which timestamps are set. Do not add a column.
4. **Stage timestamps are server-set** (`now()` IST) — the client `timestamp` shown in the flow is illustrative and **ignored** (H-02 server-authoritative-time). The endpoint effectively takes `{ stage, version }`.
5. **Sequence `raw → finals → posted`:** `finals` requires `raw_received_at`; `posted` requires `finals_ready_at`; `raw` has no prerequisite. Violation → `400 STAGE_SEQUENCE_VIOLATION`. Source: `04-APPFLOW.md` §7.
6. **`content_pipelines` IS versioned** — stage PATCH uses `optimisticUpdate` (C-02): `version` required, full row returned, `STALE_DATA` (409) on mismatch. (Contrast: shoot slots + tasks are last-write-wins.)
7. **Trigger 1 recompute is orthogonal — no version bump** (ADR-012). The `shoot:confirmed` / `shoot:reset` listener does a targeted `UPDATE coming_shoot_date, coming_shoot_source` that does **not** bump `version`. Only user writes bump it. This prevents a background shoot event false-conflicting a concurrent stage edit.
8. **Trigger 2 date = server `CURRENT_DATE` IST (H-02)** — `pipeline:posted { clientId, period, postedAt }`; `posted_at` is the source; **no `posted_date` column**.
9. **Forward-only stage marking (MVP)** — `04-APPFLOW.md` §7 shows only marking. No un-mark this sprint. (If ever added, un-marking must cascade-clear later stages and respect the sequence.)
10. **`coming_shoot_date` time-staleness → Sprint 12 rollover** (ADR-012) — event-driven recompute goes stale as a confirmed date passes; the rollover recomputes daily. The frontend treats a past `coming_shoot_date` as "no upcoming shoot".
11. **Frontend path `apps/web/app/(portal)/content-dropper/`** (no `src/`), matching Sprints 3–5.
12. **`last_shoot_date` is display-only / manual this sprint** — not a stage, not wired to a trigger. `visit_type` likewise (display; set at generation or a future manual edit).
13. **Stage-cell avatar = row-level `updated_by`** — `content_pipelines` has one `updated_by` column (not per-stage), so the avatar on a filled cell shows the row's last editor. Per-stage attribution lives in `audit_log`.
14. **Real-time (ADR-010): Sprint 6 emits `pipeline:posted` (in-process) only.** The calendar cell write **and** any org-wide socket broadcast are **Sprint 7's** listener (so the broadcast reflects the actual calendar change). No frontend socket client here.

---

## AUDIT + ADR ITEMS THIS SPRINT MUST HANDLE

| ID | What | Where |
|---|---|---|
| **ADR-012 (new)** | Trigger 1 recompute: derived + guarded + **orthogonal write** (no version bump) + rollover-refresh plan. | STEP 1 (record) + STEP 3 (build) |
| **C-02** | Stage PATCH uses `optimisticUpdate` — `version` required, `STALE_DATA` on mismatch. | STEP 2 |
| **H-02** | Trigger 2 uses server `CURRENT_DATE` IST; no `posted_date` field. | STEP 2 |
| **Trigger 1 (consumer)** | `shoot:confirmed` / `shoot:reset` → recompute `coming_shoot_date`. **Testing-Strategy §4.2 test passes now.** | STEP 3 |
| **Trigger 2 (producer)** | `posted` stage → `pipeline:posted { clientId, period, postedAt }`. | STEP 2 |
| **STAGE_SEQUENCE_VIOLATION** | `finals` needs `raw`; `posted` needs `finals`. | STEP 2 |

If you skip the test for any of these, Sprint 6 is not done. They reappear in CI when you push.

---

## STEP-BY-STEP STRUCTURE

| # | Type | What |
|---|---|---|
| 1 | Manual | Pre-flight — Sprint 5 green, confirm `content_pipelines` versioned + `coming_shoot_source`, record ADR-012, branch |
| 2 | Prompt | `ContentDropperService` — getGrid (derived status) + updateStage (sequence + version + server timestamp + **Trigger 2 emit**) |
| 3 | Prompt | **Trigger 1 consumer** — recompute listener (orthogonal write, guarded) on `shoot:confirmed` / `shoot:reset` |
| 4 | Prompt | Routes + client-name inline edit + Zod + registration + Swagger |
| 5 | Prompt | Backend test round-out + full suite |
| 6 | Prompt | Frontend — Content Dropper grid (7 columns, stage cells, progress bar, coming-shoot indicator) |
| 7 | Prompt | Frontend — stage marking + sequence shake + client-name edit + gold highlight + errors |
| 8 | Manual + Prompt | Playwright smoke — raw → finals → posted sequence + violation |
| 9 | Manual | End-to-end smoke + commit + close-out |

---

## SPRINT 6 — STEP 1: Pre-flight (manual)

**Goal:** Solid ground, the recompute semantics recorded before any code references them.

### 1.1 — Confirm Sprint 5 is green

```bash
git checkout main && git pull
docker compose up -d && docker compose ps          # both healthy
pnpm install
pnpm --filter @skaly/api db:status                 # 0 pending
pnpm typecheck && pnpm --filter @skaly/api test    # green before branching
```

### 1.2 — Confirm the schema facts this sprint depends on

```bash
docker compose exec postgres psql -U skaly -d skaly_dev -c "\d content_pipelines" | grep -iE "version|coming_shoot_source|raw_received_at|finals_ready_at|posted_at"
# expect: version, coming_shoot_source, and the three stage timestamp columns all present
docker compose exec postgres psql -U skaly -d skaly_dev -c "SELECT count(*) FROM content_pipelines WHERE period = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM');"
# expect: > 0 (generatePeriodRows already seeded the current period's pipeline rows)
```

### 1.3 — Record ADR-012 (Prompt)

> **WHERE WE ARE**
>
> Sprint 6, STEP 1.3. Recording the pre-Sprint-6 ruling before building. Read `docs/adr/ADR-010` and `docs/05-BACKEND-SCHEMA.md` (`content_pipelines`).
>
> **WHAT TO BUILD** — create `docs/adr/ADR-012-trigger1-recompute.md`:
>
> ```
> # ADR-012 — Trigger 1 recompute: orthogonal write + rollover refresh
> Status: Accepted • Pre-Sprint 6 (build impact: Sprint 6 + Sprint 12)
> Cross-refs: ADR-010, 05-BACKEND-SCHEMA content_pipelines (version, coming_shoot_source),
>   Audit C-02, Audit M-04 (calendar manual guard)
>
> Context: content_pipelines is versioned for concurrent USER edits of the stage columns.
>   The Trigger 1 listener (shoot:confirmed / shoot:reset) writes coming_shoot_date — a
>   system projection on a DIFFERENT column.
>
> Decision:
>   1. RECOMPUTE (not push): coming_shoot_date = MIN(slot_date) over shoot_schedules WHERE
>      client_id, period, slot_status='Confirmed', slot_date >= CURRENT_DATE. NULL if none.
>      Never naive-SET to the event's slotDate (breaks on reset + multi-slot clients).
>   2. GUARD: write only if coming_shoot_source IN (NULL,'trigger') — never clobber a 'manual'
>      override (mirrors calendar M-04). Set coming_shoot_source='trigger'.
>   3. ORTHOGONAL WRITE: the recompute is a targeted UPDATE of coming_shoot_date +
>      coming_shoot_source that does NOT bump content_pipelines.version. It touches a column
>      orthogonal to the user-edited stage fields, so it must not cause a false STALE_DATA on
>      a concurrent stage PATCH. Only USER writes (stage PATCH, manual coming_shoot_date
>      override) use optimisticUpdate and bump version.
>   4. TIME-STALENESS: because recompute is event-driven, a confirmed shoot date passing with
>      no new event leaves the stored value stale. The Sprint 12 daily rollover recomputes
>      coming_shoot_date for all active clients. The frontend treats a past coming_shoot_date
>      as "no upcoming shoot".
>
> Rule: coming_shoot_date is a derived, guarded, orthogonal projection maintained by the
>   Trigger 1 listener and refreshed daily by the rollover. Never naive-pushed, never version-bumps.
>
> Rationale: A naive push breaks on reset/multi-slot; a version bump false-conflicts orthogonal
>   stage edits; event-only recompute goes stale over time. This addresses all three.
> ```
>
> Show me the file.

**Verify:**

```bash
ls docs/adr/ADR-012*.md
git add docs/adr/ADR-012-*.md && git commit -m "docs(adr): record ADR-012 Trigger 1 recompute semantics"
```
`▶ /ponytail` — checkpoint the ADR + green baseline before starting the build.

### 1.4 — Branch

```bash
git checkout -b sprint-6-content-dropper
```

**Verify gate:** Sprint 5 green, schema confirmed, ADR-012 recorded, on `sprint-6-content-dropper`. Proceed.

---

## SPRINT 6 — STEP 2: `ContentDropperService` — grid, stage sequence, Trigger 2

**Goal:** The module brain on `content_pipelines`: derived-status reads, sequence-validated stage writes with optimistic locking and server-set timestamps, and the Trigger 2 emit on `posted`.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 6, STEP 2. Chassis + EventBus ready. Building `ContentDropperService`. Read `docs/04-APPFLOW.md` §7 (the definitive stage flow — status derived, sequence, Trigger 2), `docs/07-API-CONTRACT.md` §9, `docs/08-AUTH-MATRIX.md` §3–§4 (admin/manager only), `docs/05-BACKEND-SCHEMA.md` (`content_pipelines` — **has `version`**, timestamp columns, `coming_shoot_source`), and `docs/adr/ADR-012`.
>
> **HARD CONSTRAINTS:**
> - **Table is `content_pipelines`** (UI "Content Dropper"; route `/v1/content-dropper`; service `ContentDropperService`).
> - **Status is DERIVED** — no stored `stage`/`status` column. Compute it in `getGrid`.
> - **Three stages** `raw`/`finals`/`posted` → `raw_received_at`/`finals_ready_at`/`posted_at`. Timestamps **server-set** (`now()` IST) — ignore any client timestamp (H-02).
> - **`content_pipelines` IS versioned** → stage writes use `BaseService.optimisticUpdate` (C-02).
> - **Trigger 2 date is server `CURRENT_DATE` IST** — no `posted_date` column (H-02).
>
> **WHAT TO BUILD** — `apps/api/src/services/ContentDropperService.ts`:
>
> 1. **`getGrid(period, currentUser, db)`** — returns the API-Contract §9 shape: one row per `content_pipelines` for the period, joined with client name, each with:
>    - the raw columns (`visit_type`, `last_shoot_date`, `raw_received_at`, `finals_ready_at`, `posted_at`, `coming_shoot_date`, `coming_shoot_source`, `version`, `updated_by` → name/avatar),
>    - a **derived `status`**: `posted_at` set → `'Posted'`; else `finals_ready_at` set → `'Review'`; else `raw_received_at` set → `'Editing'`; else `'Awaiting'`,
>    - a derived `stagesComplete` count (0–3, of raw/finals/posted) for the progress bar.
>    Active non-internal clients only (`softDeletable`). Order by client name. camelCase at the boundary.
>
> 2. **`updateStage(id, stage, currentUser, expectedVersion, db)`** — `stage ∈ 'raw' | 'finals' | 'posted'`. **admin/manager only** (route-gated; assert). One transaction:
>    a. Load the pipeline row (404 if missing). `assertPeriodNotLocked(period, trx)`.
>    b. The target timestamp is already set → `400 VALIDATION_ERROR` ("Stage already marked") — forward-only (ADR reconciliation #9).
>    c. **Sequence check (`STAGE_SEQUENCE_VIOLATION` 400):** `finals` requires `raw_received_at IS NOT NULL`; `posted` requires `finals_ready_at IS NOT NULL`; `raw` has no prerequisite.
>    d. `optimisticUpdate('content_pipelines', id, expectedVersion, { [column]: sql\`now()\`, updated_by: currentUser.staffId }, trx)` — sets the mapped timestamp to server time, bumps `version`, returns the full row, throws `STALE_DATA` (409) on version mismatch (C-02).
>    e. `AuditService.log(entity:'content_pipelines', action:'UPDATE', before, after, trx)`.
>    f. **After COMMIT**, if `stage === 'posted'`: **Trigger 2** — `const postedAt = <today's date in Asia/Kolkata, YYYY-MM-DD>; EventBus.emit('pipeline:posted', { clientId: row.client_id, period, postedAt })`. `postedAt` is **server-computed IST `CURRENT_DATE`** — do NOT read it from the client, do NOT add a `posted_date` column (H-02). (The Sprint 7 calendar listener consumes this. No socket broadcast here — Sprint 7's listener broadcasts the actual calendar change.)
>    g. Return the full updated row (with recomputed derived `status`/`stagesComplete`).
>
> **RULES**
>
> - Content Dropper is **admin/manager only** (Auth-Matrix §3–§4); team_member + freelancer never reach the service.
> - Timestamps are server-authoritative (`now()` in SQL / IST). Never trust a client timestamp.
> - `optimisticUpdate` only for stage writes (versioned table).
> - Trigger 2 emits strictly **after COMMIT**.
> - **Verify before moving on.** STEP 5 writes the suite — smoke `updateStage('finals')` without `raw` → 400, and `updateStage('posted')` fires the event (spy) now.
>
> Start with `getGrid` (derived status) and `updateStage` (sequence + optimisticUpdate + Trigger 2). Show me both.

**Verify:**

```bash
pnpm --filter @skaly/api test services/ContentDropperService   # smoke
pnpm typecheck
```
`▶ /ponytail` — review the service before wiring the Trigger 1 listener.

---

## SPRINT 6 — STEP 3: Trigger 1 consumer — the recompute listener

**Goal:** Wire the EventBus listener that makes Sprint 5's `shoot:confirmed` / `shoot:reset` emits actually update `content_pipelines.coming_shoot_date` — recomputed, guarded, orthogonal (ADR-012). This is the step that closes the cross-module loop.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 6, STEP 3. `ContentDropperService` exists. Now the Trigger 1 consumer. Read `docs/adr/ADR-012` (the exact recompute rules), `docs/05-BACKEND-SCHEMA.md` (`shoot_schedules` + `content_pipelines`), and `apps/api/src/lib/EventBus.ts`.
>
> **HARD CONSTRAINTS (ADR-012):**
> - **Recompute, never push:** `coming_shoot_date = MIN(slot_date)` over `shoot_schedules WHERE client_id, period, slot_status='Confirmed', slot_date >= CURRENT_DATE`; `NULL` if none. Never `SET = eventPayload.slotDate`.
> - **Guard:** write only if `coming_shoot_source IN (NULL,'trigger')`; set `'trigger'`. Never clobber `'manual'`.
> - **Orthogonal write — NO version bump:** a targeted `UPDATE content_pipelines SET coming_shoot_date = ?, coming_shoot_source = 'trigger' WHERE period = ? AND client_id = ?` — do **not** touch `version`, do **not** use `optimisticUpdate`. It's orthogonal to the user-edited stage columns and must not false-conflict a concurrent stage PATCH.
>
> **WHAT TO BUILD**
>
> 1. **`ContentDropperService.recomputeComingShootDate(clientId, period, db)`**:
>    - Compute `nextDate = MIN(slot_date)` per the predicate above (a single SQL `SELECT MIN(...)`).
>    - Load the pipeline row's `coming_shoot_source`. If it's `'manual'` → **return without writing** (respect the override).
>    - Else: targeted `UPDATE content_pipelines SET coming_shoot_date = nextDate, coming_shoot_source = 'trigger' WHERE period AND client_id` (**no version bump**). If `nextDate` is null, this sets `coming_shoot_date = NULL` (source stays/becomes `'trigger'`).
>    - Write an `AuditService.log` row with `changed_by_source = 'system'` + `SYSTEM_ACTOR_UUID` (C-04 — this is an automated write) recording the `coming_shoot_date` change. (Audit yes; version bump no.)
>    - Runs inside its own short transaction (the event handler owns it).
>
> 2. **Register the listeners** — `apps/api/src/events/listeners.ts` (create if absent), called once at startup from `server.ts` **after** services are constructed:
>    - `EventBus.on('shoot:confirmed', ({ clientId, period }) => recomputeComingShootDate(clientId, period, db))`
>    - `EventBus.on('shoot:reset', ({ clientId, period }) => recomputeComingShootDate(clientId, period, db))`
>    - Both call the **same** recompute — the event just says "this client/period changed, recompute". (The `slotDate` in the `shoot:confirmed` payload is not used directly — recompute reads the live confirmed set.)
>    - Wrap the handler body in try/catch → log errors (a failed recompute must not crash the process; the rollover will re-derive it in Sprint 12).
>
> **RULES**
>
> - The recompute is idempotent and safe to run repeatedly.
> - It **never** bumps `version` (ADR-012) — this is the whole point.
> - Listeners are registered exactly once (guard against double-registration on hot reload).
> - **Verify before moving on.** STEP 5 writes the real-EventBus tests — smoke: confirm a slot → `coming_shoot_date` set to that date now.
>
> Show me `recomputeComingShootDate` (the targeted no-version UPDATE) and the listener registration.

**Verify:**

```bash
pnpm --filter @skaly/api test services/ContentDropperService   # incl. a quick recompute smoke
pnpm --filter @skaly/api dev   # boot → logs show listeners registered once
pnpm typecheck
```
`▶ /ponytail` — this is the cross-module loop closing; review before routes.

---

## SPRINT 6 — STEP 4: Routes + client-name inline edit + registration

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 6, STEP 4. Services + listener in. Now routes. Read `docs/07-API-CONTRACT.md` §9 and `docs/04-APPFLOW.md` §7 (client name edit).
>
> **WHAT TO BUILD**
>
> 1. **Zod schemas `packages/shared/src/schemas/content-dropper.ts`:** `DropperQuerySchema` (`period` required), `StageUpdateSchema` (`{ stage: enum['raw','finals','posted'], version: int().min(1) }` — **version required** (C-02); note **no client timestamp**, server sets it), `ClientNameSchema` (`{ name: string.min(1).max(120) }`).
>
> 2. **Routes `apps/api/src/routes/content-dropper/`** (register after shoot-planner, per TRD §5.1):
>    - `GET /v1/content-dropper?period=` — `requireRole('admin','manager')` (**team_member + freelancer → 403**). → `getGrid`.
>    - `PATCH /v1/content-dropper/:id/stage` — `requireRole('admin','manager')`; body `StageUpdateSchema`; → `updateStage`. Surfaces `400 STAGE_SEQUENCE_VIOLATION`, `409 STALE_DATA`, `423 PERIOD_LOCKED`.
>
> 3. **Client name inline edit** — `PATCH /v1/clients/:id` — `requireRole('admin','manager')`; body `ClientNameSchema`; updates `clients.name` + `AuditService.log`. (Reuse/extend any existing client route from Sprint 5's slot-count work — keep it one coherent clients route.) Returns the updated client. The frontend invalidates every query keyed by this `clientId` (§7).
>
> 4. Confirm rate-limit headers present (M-06).
>
> **RULES**
>
> - Content Dropper endpoints are admin/manager only at the route (layer 2) AND the service asserts (layer 3).
> - Envelopes per API-Contract §1.1.
>
> Show me the schemas, the routes, then confirm Swagger lists them.

**Verify:**

```bash
pnpm --filter @skaly/api dev   # /docs lists /v1/content-dropper* + the clients name PATCH
pnpm typecheck
```
`▶ /ponytail` — review the route surface before the test round-out.

---

## SPRINT 6 — STEP 5: Backend test round-out + full suite

**Goal:** Every trigger + sequence + lock is proven. **Trigger 1's real-EventBus test — the one that's been waiting since Sprint 5 — passes here.**

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 6, STEP 5. Services + routes + listener exist. Now the full backend suite. Read `docs/12-TESTING-STRATEGY.md` §4.2 (Trigger 1 coming_shoot_date test + Trigger 2) + §5.4 (locks), and `docs/adr/ADR-012`. Real local Postgres, `NODE_ENV=test`. Register the EventBus listeners in the test setup so triggers actually fire.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/test/services/ContentDropperService.test.ts`:**
>    - **Sequence:** `updateStage('finals')` with no `raw_received_at` → `400 STAGE_SEQUENCE_VIOLATION`; `updateStage('posted')` with no `finals_ready_at` → `400`. In order `raw → finals → posted` → each succeeds and stamps a server timestamp.
>    - **Derived status:** after `raw` → status `'Editing'`; after `finals` → `'Review'`; after `posted` → `'Posted'`; `stagesComplete` counts correctly.
>    - **Optimistic lock (C-02):** stale `expectedVersion` → `409 STALE_DATA`; each successful stage bumps `version`.
>    - **Forward-only:** marking an already-set stage → `400`.
>    - **Trigger 2 (spy + payload):** `updateStage('posted')` emits `pipeline:posted` once with `{ clientId, period, postedAt }` where `postedAt` = **server IST `CURRENT_DATE`** (assert it equals today-IST, not a client value). Non-posted stages emit nothing.
>    - **Period lock:** any stage on a locked period → `423`.
>
> 2. **`apps/api/test/events/trigger1.test.ts` — Trigger 1 real EventBus (Testing-Strategy §4.2, passes NOW):**
>    - Create a client + pipeline row + a `Scheduled` shoot slot dated in the future. `ShootPlannerService.confirmSlot(...)` (or `update` to `Confirmed`) → after the event fires, `content_pipelines.coming_shoot_date` = that slot's date, `coming_shoot_source = 'trigger'`. *(This is the exact assertion the Sprint 5 guide deferred here.)*
>    - **Multi-slot:** two confirmed future slots (dates D1 < D2) → `coming_shoot_date = D1` (MIN, order-independent — confirm D2 first then D1, still D1).
>    - **Reset:** reset the earliest confirmed slot → recompute → `coming_shoot_date` = the next remaining confirmed date (or `NULL` if none). `shoot:reset` drives it.
>    - **Manual guard:** set a pipeline's `coming_shoot_source='manual'` + a manual date → confirm a slot → the manual value is **NOT** overwritten (ADR-012 guard).
>    - **Orthogonal write (the subtle one):** cache/read a pipeline row's `version`; fire a `shoot:confirmed` recompute for that client → assert `version` is **unchanged** (the recompute didn't bump it) → then a stage `updateStage` with the *original* `version` still **succeeds** (no false `STALE_DATA`). This proves the orthogonal-write decision.
>
> 3. **`apps/api/test/routes/content-dropper.test.ts` (Fastify `inject`):** team_member GET → 403; freelancer GET → 403; manager stage PATCH in order → 200; out-of-order → 400; stage PATCH without `version` → 400; rate-limit headers present (M-06).
>
> 4. Run the **whole** API suite + typecheck + lint.
>
> **RULES:** register listeners in test setup; assert `postedAt` against today-IST; the orthogonal-write test is mandatory (it guards ADR-012).
>
> Show me the Trigger 1 real-EventBus test and the orthogonal-write test first, then run the suite.

**Verify:**

```bash
pnpm --filter @skaly/api test        # full API suite green — incl. the Trigger 1 coming_shoot_date test
pnpm typecheck && pnpm lint
```
`▶ /ponytail` — full backend review before committing the backend half.

```bash
git add -A && git commit -m "Sprint 6 backend: ContentDropperService + Trigger 1 recompute (ADR-012) + Trigger 2 (H-02) + tests"
```

---

## SPRINT 6 — STEP 6: Frontend — Content Dropper grid structure

**Goal:** The 7-column grid per UI/UX §10 — before stage-marking wiring.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 6, STEP 6. Backend done. Now the grid — rendering only. Read `docs/03-UIUX.md` §10 (Content Dropper — 7 columns, stage cells, progress bar, coming-shoot indicator), §4.2 (cells), §4.3 (chips), and `docs/07-API-CONTRACT.md` §9 (GET payload). Reuse the Sprint 3–5 chassis.
>
> **WHAT TO BUILD** — `apps/web/app/(portal)/content-dropper/page.tsx` + `apps/web/components/modules/content-dropper/` (no `src/`):
>
> 1. Data: `useQuery({ queryKey: ['content-dropper', period], queryFn: () => api.get('/content-dropper', { period }) })`.
> 2. **TanStack Table v8**, columns per UI/UX §10 in order: **Client (sticky left, 200px)** · **Visit Type** · **Last Shoot** (date, DM Mono) · **RAW** · **Finals** · **Posted** · **Coming Shoot**.
> 3. **Stage cells (RAW / Finals / Posted):** empty = dashed border, "Click to mark" (muted); filled = the timestamp (DM Mono) + the `updated_by` avatar (row-level — reconciliation #13).
> 4. **Progress bar:** a 3px gold bar along the row bottom, width = `stagesComplete / 3 * 100%`.
> 5. **Coming Shoot cell:** the date; when `coming_shoot_source === 'trigger'`, show a **"↑" indicator + tooltip "Set by Shoot Planner"**. Treat a `coming_shoot_date` earlier than today as "—" / no-upcoming (reconciliation #10).
> 6. **Derived status chip** (optional per row header): from the API's derived `status` (`Awaiting`/`Editing`/`Review`/`Posted`) using §4.3 colours.
> 7. **Locked period:** stage cells render read-only (`<span>`), the Sprint 3 locked banner shows, no marking.
> 8. Empty state: "No pipelines yet". Accessibility: `role="grid"`, focus ring `var(--accent-gold)`, 44×44 targets.
>
> **RULES:** rendering only — no marking/mutations/highlight yet. All colours/fonts via globals.css; dates in DM Mono.
>
> Build it; I'll eyeball the 7 columns, the progress bars, the empty/filled stage cells, and the ↑ coming-shoot indicator before wiring interactions.

**Verify (manual):** grid renders from seeded pipeline rows; progress bars reflect stages; a client with a trigger-set `coming_shoot_date` (confirm a shoot first) shows the ↑ + tooltip.
`▶ /ponytail` — review the grid structure before interactions.

---

## SPRINT 6 — STEP 7: Frontend — stage marking, client-name edit, highlight, errors

**Goal:** The full APPFLOW §7 interactions — sequence-aware stage marking with the pre-API shake, the Trigger toasts, client-name inline edit, gold highlight, and error routing.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 6, STEP 7. Grid renders. Now interactions. Read `docs/04-APPFLOW.md` §7 (marking + sequence shake + Trigger toasts + client-name edit), `docs/03-UIUX.md` §4.4 (gold highlight), §10, and `docs/09-ERROR-HANDLING.md` §5.1. Reuse `handleMutationError`, `useColumnHighlight`, the api client.
>
> **WHAT TO BUILD** (admin/manager only — the API is the gate):
>
> 1. **Stage marking:** click an empty stage cell (RAW/Finals/Posted) →
>    a. **Client-side sequence pre-check (before the API call, APPFLOW §7):** Finals requires RAW set → else toast "Mark RAW first" + **cell shake**, no request. Posted requires Finals set → else "Mark Finals first" + shake, no request. (The server re-validates — this is UX.)
>    b. If the pre-check passes → **optimistic** `useMutation`: write the timestamp into the `['content-dropper', period]` cache; `PATCH /v1/content-dropper/:id/stage { stage, version }` (**version from the cached row** — C-02); `onSuccess` replace the row with the returned row (new `version`); `onError` revert + `handleMutationError`.
>    c. **`STALE_DATA` (409):** the shared handler shows the inline "Updated by {name} — Refresh row →" (someone else advanced the pipeline) → refresh invalidates `['content-dropper', period]`.
>    d. **Posted success → Trigger 2 toast:** "Posted! Content Calendar updated automatically." (Frontend toast; the calendar write itself is Sprint 7 — the copy is spec-accurate for the end state.)
> 2. **Client-name inline edit:** click the client-name cell → inline input → **800ms debounce** → `PATCH /v1/clients/:id { name }` → on success **invalidate every query key containing this `clientId`** (`['content-dropper', period]`, `['shoot-planner', period]`, `['clients']`, `['attendance']` if it shows clients, etc.) → toast "Client name updated — reflected across all modules."
> 3. **Gold column highlight (UI/UX §4.4):** apply `useColumnHighlight` keyed by stage column (`'raw'`/`'finals'`/`'posted'`) to the stage cells, same five state rules incl. the failure path. Class-based (not virtualised).
> 4. **`handleMutationError`:** add `STAGE_SEQUENCE_VIOLATION` → toast + shake (a belt-and-braces if a race slips past the client pre-check); reuse `STALE_DATA` (inline), `PERIOD_LOCKED`, `PERMISSION_DENIED`, default.
> 5. **Real-time (ADR-010):** no socket subscription. Own-mutation refresh via cache replacement + invalidation. Add `// TODO(Sprint 10): subscribe to pipeline updates on /ws/notify → invalidateQueries(['content-dropper', period])`.
> 6. **Frontend tests:** the client-side sequence pre-check blocks a Finals click with no RAW (shake, no request); stage mutation sends the cached `version` and replaces the row; `STALE_DATA` shows the inline conflict; posted shows the Trigger 2 toast; client-name edit invalidates multi-module keys; highlight failure-path.
>
> **RULES**
>
> - Sequence is checked **client-side before the request** (shake) AND server-side (the real gate).
> - Stage PATCH always sends the cached `version`; the returned row replaces the cache (version chain intact — C-02).
> - Build stage-marking first; show me RAW → Finals → Posted working before the client-name edit.

**Verify (manual):** mark RAW → Finals → Posted on a pipeline (progress bar fills; posted shows the "Content Calendar updated" toast; check `SELECT posted_at FROM content_pipelines WHERE id='...';` is a server timestamp). Try Finals before RAW → shake, no request. Edit a client name → it updates across the shoot-planner + dropper grids. Force a version conflict (bump `version` in psql) → inline "Updated by … — Refresh row →".

```bash
pnpm --filter @skaly/web test
```
`▶ /ponytail` — review the frontend before the E2E pass.

---

## SPRINT 6 — STEP 8: Playwright smoke — stage sequence + violation

### 8.1 — Test logins (manual)

Reuse the Sprint 3–5 `.env.test` admin. (Content Dropper is admin/manager only, so the admin login covers it; optionally add the manager if you have one.)

### 8.2 — Prompt

> **WHERE WE ARE**
>
> Sprint 6, STEP 8. Everything works by hand. Now Playwright. Read `docs/12-TESTING-STRATEGY.md` §6. Reuse the Sprint 3–5 `loginAs` + `playwright.config.ts`.
>
> **WHAT TO BUILD** — `tests/e2e/content-dropper.spec.ts` (add `data-testid`s as needed):
> 1. **Sequence (admin):** `/content-dropper` → mark RAW on a pipeline → RAW cell shows a timestamp + progress bar advances; mark Finals → advances; mark Posted → advances to 100% + "Content Calendar updated" toast.
> 2. **Violation (admin):** on a fresh pipeline, click Finals (no RAW) → assert the shake / "Mark RAW first" toast and that **no** network PATCH was sent (intercept requests). Then a direct `page.request.patch('/v1/content-dropper/{id}/stage', { data: { stage: 'posted', version: 1 } })` on a raw-only pipeline → **400** `STAGE_SEQUENCE_VIOLATION`.
> 3. **Access (team_member):** a direct `GET /v1/content-dropper` with a team_member token → **403**; `/content-dropper` is absent from their sidebar.
> 4. Run headed once, then headless (chromium + webkit).
>
> **RULES:** independent, re-runnable; clean up marked stages (reset via SQL in teardown if needed — there's no un-mark endpoint).
>
> Show me the spec, then run `pnpm exec playwright test tests/e2e/content-dropper.spec.ts --headed`.

**Verify:**

```bash
pnpm exec playwright test tests/e2e/content-dropper.spec.ts    # green, chromium + webkit
```
`▶ /ponytail` — final review before close-out.

---

## SPRINT 6 — STEP 9: End-to-end smoke + commit + close-out (manual)

### 9.1 — Full manual walk-through

```bash
docker compose up -d && pnpm dev
```

1. **Admin — Content Dropper:** grid renders (7 columns, progress bars). Mark RAW → Finals → Posted on a pipeline; each stamps a server timestamp + advances the bar; Posted shows the Trigger 2 toast. `SELECT raw_received_at, finals_ready_at, posted_at FROM content_pipelines WHERE id='...';` — all server timestamps.
2. **Trigger 1 (the loop closes):** go to Shoot Planner, confirm a future shoot for client X → return to Content Dropper → client X's **Coming Shoot** cell now shows that date + ↑ "Set by Shoot Planner". `SELECT coming_shoot_date, coming_shoot_source, version FROM content_pipelines WHERE client_id='X' AND period='<current>';` — date set, source `'trigger'`, and **`version` unchanged** by the recompute (orthogonal write).
3. **Trigger 1 reset:** reset that shoot slot → Coming Shoot updates to the next confirmed date (or clears). Multi-slot: confirm two future dates → the earlier one shows.
4. **Manual guard:** if you've built a manual `coming_shoot_date` override path, set one → confirm a slot → the manual value survives.
5. **Trigger 2 emit:** marking Posted fires `pipeline:posted` (check the API logs / a temporary log). The calendar isn't updated yet — correct, that's Sprint 7.
6. **Client-name edit:** rename a client in the Content Dropper → the new name appears in the Shoot Planner + anywhere else the client shows.
7. **Optimistic lock:** bump a pipeline's `version` in psql, then mark a stage → inline "Updated by … — Refresh row →".
8. **Locked month + access:** lock the prior month → stages read-only, PATCH → 423. team_member/freelancer → no `/content-dropper` in the sidebar; direct GET → 403.
9. **Audit:** `SELECT staff_id, changed_by_source, table_name, action FROM audit_log WHERE table_name='content_pipelines' ORDER BY created_at DESC LIMIT 10;` — stage UPDATEs by users + the recompute rows by the System Actor (`changed_by_source='system'`), `staff_id` never NULL.

`▶ /ponytail` — full-sprint review before the close-out checklist.

### 9.2 — Close-out checklist

Do not start Sprint 7 until **every** box is checked:

```
PRE-SPRINT DECISION EXECUTED
  [ ] ADR-012 committed
  [ ] content_pipelines confirmed: version + coming_shoot_source + 3 stage timestamps present

BACKEND — ContentDropperService
  [ ] getGrid: derived status (no stored column) + stagesComplete; admin/manager only
  [ ] updateStage: raw/finals/posted → the 3 timestamp columns; server-set now() IST
  [ ] sequence: finals needs raw, posted needs finals → STAGE_SEQUENCE_VIOLATION 400 (TESTED)
  [ ] optimisticUpdate / version required; STALE_DATA on mismatch (C-02, TESTED)
  [ ] forward-only: re-marking a set stage → 400
  [ ] Trigger 2: posted emits pipeline:posted {clientId, period, postedAt}; postedAt = server IST CURRENT_DATE; NO posted_date column (H-02, TESTED)

BACKEND — Trigger 1 consumer (ADR-012)
  [ ] recomputeComingShootDate: MIN(slot_date WHERE Confirmed AND ≥ today), NULL if none
  [ ] guard: writes only if coming_shoot_source IN (NULL,'trigger'); sets 'trigger'; never clobbers 'manual' (TESTED)
  [ ] ORTHOGONAL WRITE: targeted UPDATE, NO version bump; concurrent stage edit does NOT false-conflict (TESTED)
  [ ] listeners registered once on shoot:confirmed + shoot:reset; try/catch around handlers
  [ ] Testing-Strategy §4.2 "coming_shoot_date set after confirm" test PASSES (real EventBus)
  [ ] recompute audit rows use System Actor + changed_by_source='system' (C-04)

ROUTES
  [ ] GET + stage PATCH admin/manager only (team_member/freelancer 403); client-name PATCH admin/manager
  [ ] Swagger lists content-dropper routes; rate-limit headers (M-06)

FRONTEND
  [ ] Grid: 7 columns per UIUX §10; sticky client col; stage cells (dashed empty / timestamp+avatar filled)
  [ ] Progress bar (3px gold, stagesComplete/3); Coming Shoot ↑ + tooltip when source='trigger'; past date = no-upcoming
  [ ] Stage marking: client-side sequence pre-check (shake, no request) + server re-validate
  [ ] Optimistic stage mutation: cached version sent; row replaced on success; STALE_DATA inline
  [ ] Posted → "Content Calendar updated" toast
  [ ] Client-name inline edit (800ms debounce) → invalidates ALL clientId-keyed queries + toast
  [ ] Gold highlight on stage columns incl. failure path
  [ ] handleMutationError: STAGE_SEQUENCE_VIOLATION + STALE_DATA (inline) + locked + permission
  [ ] No frontend socket client (ADR-010); // TODO(Sprint 10) marker

TESTS
  [ ] ContentDropperService + trigger1 (real EventBus) + route suites green
  [ ] Orthogonal-write test green (recompute doesn't bump version; stage edit doesn't false-conflict)
  [ ] Frontend hook/component tests green
  [ ] Playwright: sequence + violation (shake + no-request + API 400) + access — chromium & webkit
  [ ] pnpm typecheck + pnpm lint clean
  [ ] /ponytail run at each Verify gate (or its actual function applied) — no outstanding review flags
```

### 9.3 — Final commit

```bash
git add -A
git commit -m "Sprint 6: Content Dropper + Trigger 1 consumer (ADR-012 orthogonal recompute) + Trigger 2 producer (H-02) + client-name edit"
git push -u origin sprint-6-content-dropper
```

Open the PR to `main`; CI must be fully green before merge. Merge, then `git checkout main && git pull`.
`▶ /ponytail` — post-merge checkpoint.

### 9.4 — Move to Sprint 7

Open `MASTER-BUILD-GUIDE-V2-FINAL.md` → PART 9 → **SPRINT 7 — CONTENT CALENDAR + TRIGGER 2**, or the forthcoming `SPRINT-7-DETAILED.md`.

Sprint 7 is where Sprint 6's `pipeline:posted` **comes alive**: it builds the Content Calendar (31×20 cell grid — **TanStack Virtual required** for perf), **wires the Trigger 2 listener** (`pipeline:posted` → the calendar cell for `clientId` + `postedAt`-date → `status='Posted'`, `source='pipeline_trigger'`, **guarded by the M-04 `source='manual'` rule**), and implements the **M-04 auto-reset** (a manual edit of a `pipeline_trigger` cell flips `source` to `'manual'` so future triggers don't overwrite). `content_calendar` **is versioned** (cell PATCH uses `optimisticUpdate`).

If any close-out box is unchecked, **stop**. Sprint 7 depends on Sprint 6's `pipeline:posted` firing correctly with the server-side date.

---

## DECISIONS TO MAKE BEFORE SPRINT 7

- **Trigger 2 consumer = guarded cell write (lock it):** the Sprint 7 `pipeline:posted` listener sets the `content_calendar` cell for `clientId` + `postedAt`-date to `status='Posted'`, `source='pipeline_trigger'` — but **only if that cell's `source !== 'manual'`** (the M-04 guard, exact mirror of `coming_shoot_source`). If the cell doesn't exist for that date, decide: create it, or no-op (recommend: the cell already exists from `generatePeriodRows`, so update-in-place). Unlike the coming_shoot_date recompute, this write targets the **user-visible `status`** column, so it's **not** orthogonal — the `source` guard is what prevents clobbering a manual edit. The listener broadcasts the calendar change to `org:all` (emit now, consume Sprint 10).
- **M-04 auto-reset (manual wins):** when a user manually edits a cell whose `source='pipeline_trigger'`, flip `source` to `'manual'` so future `pipeline:posted` triggers skip it. Lock this before building the calendar cell PATCH.
- **Content Calendar virtualization:** the 31×20 grid (≈620 cells) needs **TanStack Virtual** to hit the 60fps / <1.5s targets (NFR §1.1/§1.4). And the gold column highlight there uses the **positioned-overlay** variant (not the class-based one used in attendance/tasks/shoot/dropper) because virtualized cells recycle — confirm the overlay approach before building.
- **`content_calendar` is versioned** — cell PATCH uses `optimisticUpdate` (C-02), like the pipeline. Confirm the cell status enum + note field against `05-BACKEND-SCHEMA.md` before `updateCell`.
- **Still deferred, on schedule:** frontend socket client + bell-notification display (Sprint 10), `resolvePermission` (Sprint 8), MFA enrollment (ADR-002 → Sprint 8), comment system (later sprint), attachment orphan cron + `coming_shoot_date` rollover recompute (Sprint 12).

---

## TROUBLESHOOTING — SPRINT 6 SPECIFIC

### The Trigger 1 test still fails asserting `coming_shoot_date`
Two usual causes: the EventBus listeners aren't registered in the test setup (register them in `beforeAll`), or `confirmSlot`'s emit runs before commit. The listener must be wired and the emit must fire after commit. This test was deferred from Sprint 5 to here precisely because the listener is a Sprint 6 artifact.

### A background shoot confirmation makes a stage PATCH fail with `STALE_DATA`
The recompute is bumping `version` — it must not (ADR-012). Make `recomputeComingShootDate` a targeted `UPDATE coming_shoot_date, coming_shoot_source` that never touches `version` and never uses `optimisticUpdate`. The orthogonal-write test guards this.

### `coming_shoot_date` gets overwritten even though a user set it manually
The guard is missing. Check `coming_shoot_source` before writing — if `'manual'`, return without writing. Only write when it's `NULL` or `'trigger'`.

### Naive push shows the wrong date after a reset or on a multi-slot client
You did `SET coming_shoot_date = eventPayload.slotDate`. Recompute instead: `MIN(slot_date WHERE Confirmed AND ≥ today)`. The event is a "recompute now" signal, not the value.

### `posted_at` is a client-provided time / someone asked for a `posted_date` column
H-02: the stage timestamp is server-set (`now()` in SQL), and Trigger 2's `postedAt` is server `CURRENT_DATE` IST. There is **no `posted_date` column** — `posted_at` is the source. Ignore any client timestamp.

### Marking Finals succeeds without RAW
The service sequence check is missing or only client-side. Enforce it in `updateStage`: `finals` requires `raw_received_at`; `posted` requires `finals_ready_at`. Return `400 STAGE_SEQUENCE_VIOLATION`.

### Stage PATCH fails with "column version required" or lost updates
`content_pipelines` **is** versioned (unlike shoot slots). Use `optimisticUpdate` with the cached `version`; the frontend must send it and replace the row from the response.

### Listeners fire twice (double recompute) on dev hot-reload
Registration ran more than once. Guard the `EventBus.on(...)` registration (a module-level `registered` flag or register only in the server bootstrap, not on import).

### The "Content Calendar updated" toast shows but the calendar didn't change
Correct for Sprint 6 — the calendar listener is Sprint 7. The toast copy is spec-accurate for the end state; the actual cell write lands next sprint.

### Client-name edit updates the dropper but not the shoot planner
The invalidation isn't broad enough. On a successful name PATCH, invalidate **every** query key containing the `clientId` (dropper, shoot-planner, clients list, any grid showing clients) — APPFLOW §7.

### Stage-cell avatars all show the same person
Expected — `content_pipelines` has one row-level `updated_by`, not per-stage. The avatar reflects the last editor of the row. Per-stage attribution is in `audit_log`, not the grid.

---

## END OF SPRINT 6 DETAILED GUIDE

*Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1/2/3/4/5-DETAILED.md`. Source-of-truth precedence when documents differ: the numbered spec docs (`01`–`14`) + the schema win, then this guide's reconciliations and the ADRs it executes (006–012), then the Master Build Guide's shorthand. Sprint 7 (Content Calendar) wires the Trigger 2 listener that consumes this sprint's `pipeline:posted` emit, with the M-04 manual guard.*
