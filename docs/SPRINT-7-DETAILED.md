# SPRINT 7 — CONTENT CALENDAR + TRIGGER 2: DETAILED PROMPT-BY-PROMPT GUIDE

## Scaly Business Portal • Sprint 7 of 13

**Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1/2/3/4/5/6-DETAILED.md`**
**Same Goal / Prompt / Verify framework as Sprints 0–6**
**Tooling interfaces verified as of January 2026** — Next.js 15 (App Router), TanStack Table v8 + **TanStack Virtual v3**, TanStack Query v5, Zustand 5, shadcn/ui on Tailwind 4 (`@theme`), Framer Motion 11, date-fns v4 (+ `@date-fns/tz` for IST), Playwright latest, k6, Lucide React.

> **Risk note:** the pre-build audit flags Sprint 7 as the **highest-risk sprint in the plan** (🟡 High — virtual scroll + column highlight + 31×N grid). Steps 7–9 are where that risk lives. Do not compress them.

---

## USING THE `/ponytail` PLUGIN IN THIS SPRINT

This guide invokes **`/ponytail`** at each step's **Verify gate** — after the build passes its checks, before you proceed or commit — as a per-step review/checkpoint pass. Look for the `▶ /ponytail` line inside each **Verify** block.

> **Placement is still an assumption** (same as Sprint 6). I've slotted it in as a per-step review/checkpoint. **If `/ponytail` does something else in your setup, tell me its function and I'll re-place it precisely** — it's a thin, one-edit layer over the build steps.

---

## WHAT YOU'RE BUILDING IN SPRINT 7

Sprint 6 fired `pipeline:posted` into the void. Sprint 7 **catches it** — closing the second and final cross-module loop — and builds the most performance-sensitive grid in the portal. By the end of this week:

- **The pre-Sprint-7 decisions are executed and recorded**: ADR-013 (the system-write version-bump principle), ADR-012's citation amended, and the Trigger 2 consumer built with all three corrections (null-safe guard, period derived from `postedAt`, no-op on missing cell).
- **`ContentCalendarService`** is real: `getGrid` returning all days × active clients for the period; `updateCell` with **`optimisticUpdate`** (C-02 — `content_calendar` *is* versioned) and the **service-layer auto-reset** that flips `source` to `'manual'` **in the same UPDATE** (the frontend never sends `source`).
- **Trigger 2 consumer** is wired: the `pipeline:posted` listener sets the target cell to `status='Posted'`, `source='pipeline_trigger'` — **guarded** so a manual cell is never clobbered — and broadcasts `content-calendar:updated` to `org:all`. **This is where the Testing-Strategy §5.1 "pipeline posted triggers content_calendar cell to Posted" test finally passes.**
- **The mid-month client backfill debt is closed**: a client activated mid-period now gets its `content_pipelines` row **and** its `content_calendar` cells (the carried `// TODO(Sprint 6/7)` from Sprint 5).
- **The calendar grid** renders per UI/UX §11: sticky 80px date column, dynamic client columns (min 90px), 48px rows, **today's row** in `--accent-gold-06` with auto-scroll on load, **TanStack Virtual v3 column virtualization**, the 200px cell popover (6-value status dropdown + note textarea, 800ms debounce, closes on outside click), the **6px gold dot + "Auto-updated from Content Dropper"** tooltip on `pipeline_trigger` cells, and the **positioned-overlay** gold column highlight (not the class-based variant every prior module used).
- **Optimistic updates + 409 handling**: status changes apply immediately and revert on failure; a stale `version` surfaces the inline "Updated by [Name] — [Refresh row →]".
- **Team members get a read-only grid** (`pointer-events: none`); freelancers get 403.
- **Performance is measured, not assumed**: the k6 load script runs against staging and the NFR targets (<1.5s FCP, <2.0s TTI, 60fps scroll) are verified.

**Estimated time:** 5 working days (Week 8 per `06-IMPLEMENTATION-PLAN.md` §10; owners D1 + D2). Day 1 pre-flight + service; day 2 Trigger 2 + backfill + routes; day 3 backend tests; days 4–5 the virtualized frontend + overlay + perf (budget the most time here — it's the risk).

**Prerequisites from Sprint 6** (all green — stop and fix if any is not):

- Sprint 6 close-out fully checked; PR merged; CI green.
- ADR-012 committed; `ContentDropperService` emits `pipeline:posted { clientId, period, postedAt }` **after commit**, with `postedAt` = server IST `CURRENT_DATE` (H-02).
- The Trigger 1 listener works (`coming_shoot_date` recompute, orthogonal, guarded).
- The chassis works: `(portal)` layout + RBAC sidebar, `MonthContext`, `lib/api.ts`, `handleMutationError`, `useColumnHighlight`, `AuditService`, `NotificationService`, `BaseService` (`assertPeriodNotLocked`, **`optimisticUpdate`**, `softDeletable`, `getCurrentPeriod`), `EventBus` + `events/listeners.ts`, the Sprint 3 `generatePeriodRows`.
- `pnpm typecheck`, `pnpm lint`, and the full suite green on `main`.

---

## THE PRE-SPRINT-7 DECISIONS — WHERE THEY LAND

Ruled at the pre-Sprint-7 gate; **inputs** to this sprint.

| Decision | Ruling | Executed in |
|---|---|---|
| **Trigger 2 = guarded cell write** | Update-in-place (cells exist from `generatePeriodRows`); write only when the cell isn't manual; broadcast `content-calendar:updated` to `org:all`. | STEP 3 |
| **↳ Null-safety correction** | Guard is **`source IS DISTINCT FROM 'manual'`** — `source` is nullable and `NULL != 'manual'` is NULL, which would skip every untouched cell. | STEP 3 |
| **↳ Period-derivation correction** | Target period = **`postedAt.slice(0,7)`**, not the event's `period` (a July pipeline posted in August targets an August cell). | STEP 3 |
| **↳ Missing-cell correction** | **No-op + warn.** `content_calendar.period` FKs `months(period)` — a cell can't be created for a month row that doesn't exist. | STEP 3 |
| **Version bump (new principle)** | Trigger 2 writes `status` — the same column users edit — so it **DOES** bump `version` (a 409 for a mid-edit user is correct). Inverse of ADR-012's orthogonal write. → **ADR-013**. | STEP 1 (record) + STEP 3 |
| **Auto-reset (manual wins)** | **Any** user PATCH sets `source='manual'`, in the **same UPDATE statement**, service-layer only — the frontend never sends `source`. Sticky; no un-manual path in MVP. | STEP 2 |
| **Virtualization** | **TanStack Virtual v3 column virtualization** (per Impl-Plan §10 — clients are the unbounded axis; days are capped at 31). Rows render normally. | STEP 7 |
| **Highlight** | **Positioned-overlay** variant — virtualized columns recycle, so a class-based highlight detaches. | STEP 8 |
| **`content_calendar` versioned** | `optimisticUpdate` on cell PATCH (C-02); `version` required; 409 `STALE_DATA` with `currentVersion` + `updatedBy`. | STEP 2 |
| **Carried backfill debt** | Close both halves (pipeline + calendar) for mid-month clients. | STEP 4 |

---

## READ FIRST (Open in Antigravity Split View)

`@`-reference these with `@docs/04-APPFLOW.md`.

| Doc | Sections | Why |
|---|---|---|
| `docs/04-APPFLOW.md` | §8 (Content Calendar — the definitive flow) | Every interaction + the trigger-dot rule |
| `docs/07-API-CONTRACT.md` | Content Calendar (GET/PATCH + the auto-reset note) + §6 (socket events: `content-calendar:updated`) + §1.1 | Exact shapes + the event name |
| `docs/03-UIUX.md` | §11 (Content Calendar — 80px date col, min 90px client cols, 48px rows, today row, popover, gold dot), §4.4 (highlight), §4.3 (chips) | Every visual rule |
| `docs/08-AUTH-MATRIX.md` | §3–§4 (calendar access: admin/manager ✅, team_member 👁 read, freelancer ❌) | Who reads/edits |
| `docs/05-BACKEND-SCHEMA.md` | `content_calendar` (327) — `version`, `source` CHECK, 6-value status CHECK, `UNIQUE(period, client_id, date)`, `period` FK `months` | Column truth |
| `docs/09-ERROR-HANDLING.md` | §2 (`STALE_DATA` 409, `PERIOD_LOCKED` 423), §5.1 | Error shapes |
| `docs/13-NFRS.md` | §1.1 (calendar <1.5s FCP / <2.0s TTI), §1.4 (60fps scroll) | The perf bar |
| `docs/06-IMPLEMENTATION-PLAN.md` | §10 | Sprint 7 checklist |
| `docs/12-TESTING-STRATEGY.md` | §5.1 (Trigger 2 test — passes now), §5.2 (409 test), §6 (overlay E2E), the k6 `content-calendar.js` script | The tests you must reproduce |
| `docs/adr/` | **ADR-010, ADR-012, ADR-013** (created STEP 1) | Real-time deferral + both trigger write semantics |

---

## CONSISTENCY RECONCILIATIONS — LOCK THESE BEFORE YOU PROMPT

1. **The "M-04" label collides across two canonical docs.** `07-API-CONTRACT.md` labels the calendar auto-reset *"(audit M-04)"*, while `14-PRE-BUILD-AUDIT.md` §M-04 is *"Concurrent bot session conflict across devices (Phase 2)"* — two different findings, same ID. **Cite the rule, not the bare ID:** APPFLOW §8 + API-Contract §Content Calendar + the `content_calendar_source` CHECK. Amend ADR-012's `M-04` cross-ref to say "the calendar manual-source guard (APPFLOW §8 / API-Contract §Content Calendar)". *(The earlier "M-04 is purely wrong" framing was itself half-wrong — the API contract does use it. The collision is the real story.)*
2. **The guard must be `source IS DISTINCT FROM 'manual'`.** `source VARCHAR(20) NULL` — untouched cells are NULL, and `NULL != 'manual'` evaluates to NULL (not TRUE). A naive `!=` silently skips the vast majority of cells and the trigger appears dead.
3. **Derive the target period from `postedAt`**, never from the event's `period` field. `UNIQUE(period, client_id, date)` means a mismatched period finds nothing and no-ops silently. *(The canonical Testing-Strategy test queries by `client_id` + `date` only — consistent with this.)*
4. **Missing cell → no-op + warn, never create.** `period` FKs `months(period)`; creating a cell for an un-rolled month throws. Missing = un-rolled period or an un-backfilled mid-month client (STEP 4 closes the latter).
5. **Trigger 2 bumps `version`; Trigger 1 does not.** Same-column system write → normal versioned update. Orthogonal-column system write → targeted update, no bump. This is **ADR-013**.
6. **Status vocabulary is exactly 6 values** (schema CHECK): `No Activity · Under Progress · Ready · Posted · Pending · Rescheduled`. `No Activity` is the default.
7. **Auto-reset happens in the same UPDATE statement, service-side.** Per API-Contract: "The frontend never sends the `source` field — the service layer handles it." Do not accept `source` in the request body; do not do a second UPDATE.
8. **team_member is read-only** (Auth-Matrix: 👁): `GET` allowed, `PATCH` → 403. The grid gets `pointer-events: none` for them (Impl-Plan §10). Impl-Plan also says "comment box remains interactive" — **comments are a later sprint**, so leave a labelled placeholder, don't build them.
9. **Column virtualization, not row.** Impl-Plan §10 says "column virtualisation for 620+ cells"; clients are the unbounded axis while days are capped at 31. Rows (≤31 × 48px) render normally — which also makes today-scroll a plain DOM scroll rather than a virtualizer `scrollToIndex`. *(This revises the earlier "row virtualization primary" suggestion — the spec and the scaling axis both point at columns.)*
10. **Positioned-overlay highlight.** Because virtualized columns unmount/remount, the overlay is a single absolutely-positioned div in the scroll container's inner element, `pointer-events: none`, with `left` taken from the **column virtualizer's virtual item `start`** (not `index × width`), hidden when the active column is scrolled out of range.
11. **Canonical test signature drift:** Testing-Strategy §5.1 calls `ContentDropperService.markStage(pipeline.id, 'posted')` (2 args), but the Sprint 6 as-built is `updateStage(id, stage, currentUser, expectedVersion, db)` — actor and version are required by C-02. **Adapt the test to the as-built signature**; don't weaken the service to match a shorthand test.
12. **Frontend path `apps/web/app/(portal)/content-calendar/`** (no `src/`), matching Sprints 3–6.
13. **Carried emits check:** API-Contract §6 lists `content-dropper:updated | org:all | { clientId, period }` and `client:name_updated | org:all | { clientId, name }`. Verify Sprint 6 emits both; if not, add them (one line each) while you're in that service — the contract lists them and Sprint 10 will subscribe.
14. **Real-time stays emit-only** (ADR-010): Trigger 2's listener **broadcasts** `content-calendar:updated`; no frontend socket client this sprint. Own-mutation refresh via TanStack Query.

---

## AUDIT + ADR ITEMS THIS SPRINT MUST HANDLE

| ID | What | Where |
|---|---|---|
| **ADR-013 (new)** | System-write version principle: same-column → bump; orthogonal-column → no bump. | STEP 1 (record) + STEP 3 |
| **Trigger 2 (consumer)** | `pipeline:posted` → guarded cell write. **Testing-Strategy §5.1 test passes now.** | STEP 3 |
| **C-02** | Cell PATCH uses `optimisticUpdate`; `version` required; 409 with `currentVersion` + `updatedBy` (Testing-Strategy §5.2). | STEP 2 |
| **Calendar auto-reset** | Any user PATCH flips `source='manual'` in the same UPDATE (APPFLOW §8 / API-Contract). | STEP 2 |
| **Carried backfill debt** | Mid-month client gets pipeline row + calendar cells. | STEP 4 |
| **NFR §1.1 / §1.4** | <1.5s FCP, <2.0s TTI, 60fps scroll — measured with k6 + DevTools, not assumed. | STEP 9 |

If you skip the test for any of these, Sprint 7 is not done.

---

## STEP-BY-STEP STRUCTURE

| # | Type | What |
|---|---|---|
| 1 | Manual | Pre-flight — Sprint 6 green, verify schema, amend ADR-012 + record ADR-013, carried-emits check, branch |
| 2 | Prompt | `ContentCalendarService` — getGrid + updateCell (optimisticUpdate + same-statement auto-reset) |
| 3 | Prompt | **Trigger 2 consumer** — guarded cell write (3 corrections) + `content-calendar:updated` broadcast |
| 4 | Prompt | Mid-month client backfill close-out (pipeline + calendar) |
| 5 | Prompt | Routes + Zod + registration + Swagger |
| 6 | Prompt | Backend test round-out + full suite |
| 7 | Prompt | Frontend — virtualized grid structure (column virtualization, today row, sticky date col) |
| 8 | Prompt | Frontend — cell popover + positioned-overlay highlight + optimistic + 409 inline |
| 9 | Manual + Prompt | Playwright + performance verification (k6 + DevTools against the NFR bar) |
| 10 | Manual | End-to-end smoke + commit + close-out |

---

## SPRINT 7 — STEP 1: Pre-flight (manual)

**Goal:** Solid ground, both trigger-write semantics recorded, and the carried emits verified before you build on them.

### 1.1 — Confirm Sprint 6 is green

```bash
git checkout main && git pull
docker compose up -d && docker compose ps          # both healthy
pnpm install
pnpm --filter @skaly/api db:status                 # 0 pending
pnpm typecheck && pnpm --filter @skaly/api test    # green before branching
```

### 1.2 — Verify the schema facts this sprint depends on

```bash
docker compose exec postgres psql -U skaly -d skaly_dev -c "\d content_calendar"
# expect: version INT NOT NULL DEFAULT 1 · source VARCHAR(20) NULL · note TEXT
#         status CHECK 6 values · UNIQUE (period, client_id, date) · period FK months(period)

docker compose exec postgres psql -U skaly -d skaly_dev -c \
  "SELECT count(*) FROM content_calendar WHERE period = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM');"
# expect: > 0  (generatePeriodRows seeded the current period's cells)

# Confirm NULL source is the norm — this is why the IS DISTINCT FROM guard matters:
docker compose exec postgres psql -U skaly -d skaly_dev -c \
  "SELECT source, count(*) FROM content_calendar GROUP BY source;"
# expect: mostly NULL
```

### 1.3 — Carried emits check (manual)

API-Contract §6 lists two events Sprint 6 should emit. Verify:

```bash
grep -rn "content-dropper:updated\|client:name_updated" apps/api/src || echo "MISSING — add both in STEP 4"
```

If missing, note it — STEP 4 adds them (one line each in `ContentDropperService.updateStage` and the client-name PATCH).

### 1.4 — Amend ADR-012 + record ADR-013 (Prompt)

> **WHERE WE ARE**
>
> Sprint 7, STEP 1.4. Two ADR housekeeping items before building. Read `docs/adr/ADR-012`, `docs/07-API-CONTRACT.md` (Content Calendar section), and `docs/14-PRE-BUILD-AUDIT.md` §M-04.
>
> **WHAT TO DO**
>
> 1. **Amend ADR-012's cross-ref.** It currently cites "Audit M-04 (calendar manual guard)". That ID collides: `14-PRE-BUILD-AUDIT.md` §M-04 is "Concurrent bot session conflict across devices (Phase 2)", while `07-API-CONTRACT.md` labels the calendar auto-reset "(audit M-04)". Replace the cross-ref with: `the calendar manual-source guard (APPFLOW §8 / API-Contract §Content Calendar / content_calendar_source CHECK)`, and add a one-line note recording the ID collision so nobody chases the wrong finding.
>
> 2. **Create `docs/adr/ADR-013-system-write-version-semantics.md`:**
> ```
> # ADR-013 — Version semantics for system (trigger) writes
> Status: Accepted • Pre-Sprint 7 (build impact: Sprints 6, 7, 12)
> Cross-refs: ADR-012, Audit C-02, 05-BACKEND-SCHEMA (content_pipelines, content_calendar)
>
> Context: Both cross-module triggers write to versioned tables, but to different KINDS of
>   column. Treating them identically causes either false conflicts or lost updates.
>
> Decision — the deciding question is "does this system write touch a column users edit?"
>   1. ORTHOGONAL column (system-only projection, e.g. content_pipelines.coming_shoot_date):
>      targeted UPDATE, NO version bump, no optimisticUpdate. A concurrent user edit of the
>      stage columns must NOT get a false STALE_DATA. (ADR-012, Trigger 1.)
>   2. SAME column users edit (e.g. content_calendar.status via Trigger 2):
>      normal versioned UPDATE that DOES bump version. A user mid-edit with a stale version
>      SHOULD get 409 — they would be overwriting the trigger's change to the same field.
>      That is optimistic locking working correctly, not a false conflict.
>
> Rule: system writes bump version if and only if they touch a user-editable column.
>   Every trigger/listener states which case it is in a comment at the write site.
> Rationale: version exists to protect concurrent edits of the SAME data. Bumping on an
>   orthogonal write manufactures conflicts; not bumping on a same-column write loses them.
> ```
>
> Show me the ADR-012 diff and the new ADR-013.

**Verify:**

```bash
ls docs/adr/ADR-013*.md
git add docs/adr/ && git commit -m "docs(adr): ADR-013 system-write version semantics; amend ADR-012 cross-ref"
```
`▶ /ponytail` — checkpoint the ADRs + green baseline before the build.

### 1.5 — Branch

```bash
git checkout -b sprint-7-content-calendar
```

**Verify gate:** Sprint 6 green, schema verified, ADRs recorded, carried emits noted, on `sprint-7-content-calendar`. Proceed.

---

## SPRINT 7 — STEP 2: `ContentCalendarService` — grid + cell edit

**Goal:** The module brain: full-period grid reads and version-checked cell writes with the same-statement `source` auto-reset.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 7, STEP 2. Chassis ready. Building `ContentCalendarService`. Read `docs/04-APPFLOW.md` §8, `docs/07-API-CONTRACT.md` (Content Calendar — GET/PATCH + the service-layer auto-reset note), `docs/08-AUTH-MATRIX.md` §3–§4, and `docs/05-BACKEND-SCHEMA.md` (`content_calendar` — **versioned**, 6-value status CHECK, nullable `source`).
>
> **HARD CONSTRAINTS:**
> - **`content_calendar` IS versioned** → `updateCell` uses `BaseService.optimisticUpdate` (C-02). `version` is required.
> - **Auto-reset in the SAME UPDATE:** any user PATCH sets `source='manual'` as part of the same statement. **The frontend never sends `source`** — reject it if present in the body.
> - **Status vocabulary is exactly 6 values** from the schema CHECK — derive the union type from a shared constant, don't hardcode strings at call sites.
>
> **WHAT TO BUILD** — `apps/api/src/services/ContentCalendarService.ts`:
>
> 1. **`getGrid(period, currentUser, db)`** — returns the API-Contract shape: every `content_calendar` cell for the period (all days × all active non-internal clients), plus a `clients` list (id, name — ordered by name, `softDeletable`) so the frontend can build columns, and the period's `locked` flag. Each cell: `{ id, clientId, date, status, note, source, version, updatedAt, updatedBy: { staffId, name } | null }`. camelCase at the boundary. Order cells by date then client name (or return them keyed — the frontend indexes by `clientId+date` either way).
>    - **Roles:** admin, manager, **team_member** (read). Freelancer never reaches here (route 403).
>
> 2. **`updateCell(id, patch, currentUser, expectedVersion, db)`** — `patch = { status?, note? }`, at least one required. **admin/manager only** (route-gated; assert defensively). One transaction:
>    a. Load the cell (404 `RESOURCE_NOT_FOUND` if missing). `assertPeriodNotLocked(cell.period, trx)` → 423.
>    b. Validate `status` ∈ the 6-value constant → else `400 VALIDATION_ERROR`. Validate `note` length (cap at 1000 chars; it's TEXT but bound it).
>    c. **Reject a `source` field if present in the patch** — `400 VALIDATION_ERROR` ("source is managed by the server"). This is the guard behind API-Contract's "the frontend never sends the source field".
>    d. `optimisticUpdate('content_calendar', id, expectedVersion, { ...patch, source: 'manual', updated_by: currentUser.staffId }, trx)` — **`source: 'manual'` is part of the same UPDATE** (the auto-reset), version bumped, full row returned, `409 STALE_DATA` with `details.currentVersion` + `details.updatedBy` on mismatch (C-02).
>    e. `AuditService.log(entity:'content_calendar', action:'UPDATE', before, after, trx)`.
>    f. Return the full updated cell.
>
> 3. **Shared status constant** — `packages/shared/src/constants/calendar.ts`: `export const CALENDAR_STATUSES = ['No Activity','Under Progress','Ready','Posted','Pending','Rescheduled'] as const;` + the derived type. The Zod schema, the service validation, and the frontend dropdown all import this — one source of truth.
>
> **RULES**
>
> - The auto-reset is unconditional on user PATCH: whether the cell was `NULL`, `'trigger'`... sorry, `'pipeline_trigger'`, or already `'manual'`, a user write leaves it `'manual'`. Sticky — there is no un-manual path in MVP.
> - `optimisticUpdate` only (versioned table). Never a bare UPDATE.
> - **Verify before moving on.** STEP 6 writes the suite — smoke a cell PATCH (version bump + `source='manual'`) and a stale-version 409 now.
>
> Show me the shared status constant, then `getGrid` and `updateCell`.

**Verify:**

```bash
pnpm --filter @skaly/api test services/ContentCalendarService   # smoke
pnpm typecheck
```
`▶ /ponytail` — review the service before wiring the trigger.

---

## SPRINT 7 — STEP 3: Trigger 2 consumer — the guarded cell write

**Goal:** Catch Sprint 6's `pipeline:posted` and update the calendar — with the three corrections that make it actually work. **This closes the last cross-module loop.**

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 7, STEP 3. `ContentCalendarService` exists. Now the Trigger 2 consumer. Read `docs/adr/ADR-013` (version semantics), `docs/04-APPFLOW.md` §7–§8, `docs/07-API-CONTRACT.md` §6 (`content-calendar:updated`), and `apps/api/src/events/listeners.ts` (where Trigger 1 is registered).
>
> **HARD CONSTRAINTS — all three are non-obvious and each one silently breaks the trigger if missed:**
> - **Null-safe guard:** write only when **`source IS DISTINCT FROM 'manual'`**. `source` is nullable and untouched cells are NULL; `source != 'manual'` evaluates to NULL for them and would skip nearly every cell.
> - **Period derived from the date:** target period = **`postedAt.slice(0,7)`**, NOT the event's `period`. (`UNIQUE(period, client_id, date)` — a July pipeline posted on Aug 2 targets an August cell. Using the event's period silently matches nothing.)
> - **Missing cell → no-op + warn, never create.** `content_calendar.period` FKs `months(period)`; a cell can't exist for an un-rolled month.
>
> **WHAT TO BUILD**
>
> 1. **`ContentCalendarService.applyPostedTrigger(clientId, postedAt, db)`**:
>    - `const targetPeriod = postedAt.slice(0, 7)` (postedAt is `YYYY-MM-DD`, server IST from Sprint 6).
>    - Look up the cell: `WHERE client_id = ? AND period = targetPeriod AND date = postedAt`.
>    - **Missing** → `logger.warn({ clientId, postedAt, targetPeriod }, 'Trigger 2: no calendar cell for date — skipping')` and return. (Causes: period not rolled over yet, or a mid-month client not backfilled — STEP 4 fixes the latter.)
>    - **Period locked** → log + skip. A system trigger must not write through a locked period.
>    - **`source === 'manual'`** → log at debug + return (the guard — a human owns this cell).
>    - Otherwise: `UPDATE content_calendar SET status='Posted', source='pipeline_trigger', updated_by = SYSTEM_ACTOR_UUID, updated_at = now(), version = version + 1 WHERE id = ?` — **bumps `version`** (ADR-013 case 2: same-column write; a user mid-edit *should* get a 409). Add a comment at the write site: `// ADR-013 case 2 — same-column system write, version IS bumped.`
>    - `AuditService.log({ actorId: null → SYSTEM_ACTOR_UUID, actorSource: 'system', entity: 'content_calendar', entityId, action: 'UPDATE', before, after })` (C-04).
>    - Return the updated cell (or null when skipped) so the caller knows whether to broadcast.
>
> 2. **Register the listener** in `apps/api/src/events/listeners.ts`, alongside Trigger 1:
>    - `EventBus.on('pipeline:posted', async ({ clientId, postedAt }) => { const cell = await applyPostedTrigger(clientId, postedAt, db); if (cell) io.of('/ws/notify').to('org:all').emit('content-calendar:updated', { clientId, period: cell.period, date: cell.date }); })`
>    - Event name and payload exactly per API-Contract §6: `content-calendar:updated | org:all | { clientId, period, date }`.
>    - Broadcast **only when a write actually happened** (not on skip).
>    - try/catch around the handler body → log; a trigger failure must never crash the process.
>    - Registered exactly once (same guard as Trigger 1).
>
> **RULES**
>
> - Idempotent: re-running for the same client/date produces the same end state (status already `Posted`, source already `pipeline_trigger` — it just bumps version again; that's acceptable, or short-circuit if both already match, your call — document which).
> - No frontend socket client this sprint (ADR-010) — the broadcast is forward-wiring for Sprint 10.
> - **Verify before moving on.** STEP 6 writes the real-EventBus tests — smoke: mark a pipeline Posted in the dropper, confirm today's calendar cell flips.
>
> Show me `applyPostedTrigger` (with all three guards visible) and the listener registration.

**Verify:**

```bash
pnpm --filter @skaly/api test services/ContentCalendarService   # incl. trigger smoke
pnpm --filter @skaly/api dev   # boot → both listeners registered once
pnpm typecheck
```
`▶ /ponytail` — the second loop is closing; review carefully before moving on.

---

## SPRINT 7 — STEP 4: Mid-month backfill close-out + carried emits

**Goal:** Close the `// TODO(Sprint 6/7)` debt so a mid-month client isn't invisible to Trigger 2 (its missing cell is exactly the no-op path above).

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 7, STEP 4. Closing carried debt from Sprint 5/6. Read `apps/api/src/services/period-rows.ts` (the Sprint 3 generators) and find the `// TODO(Sprint 6/7): backfill pipeline + calendar rows for mid-month client` marker in the client-create/reactivate flow.
>
> **WHAT TO BUILD**
>
> 1. **Factor two generators** out of `generatePeriodRows` if they aren't already discrete (mirroring Sprint 5's `generateShootSlotsForClient`):
>    - `generatePipelineRowForClient(clientId, period, trx)` — one `content_pipelines` row, `ON CONFLICT (period, client_id) DO NOTHING`.
>    - `generateCalendarCellsForClient(clientId, period, trx)` — one `content_calendar` cell per **calendar day of that month** (real day count — 28/29/30/31), `status='No Activity'`, `source=NULL`, `version=1`, `ON CONFLICT (period, client_id, date) DO NOTHING`.
>    - `generatePeriodRows` calls both in its loop; the backfill calls them for one client. Same idempotent pattern.
>
> 2. **Wire the backfill:** at the `// TODO(Sprint 6/7)` marker in the client create/reactivate transaction, for active **non-internal** clients call all three backfills together — `backfillClientSlots` (Sprint 5), `generatePipelineRowForClient`, `generateCalendarCellsForClient` — for `getCurrentPeriod().period`, inside the same transaction as the client insert. Remove the TODO.
>
> 3. **Carried emits (from STEP 1.3):** if missing, add the two events API-Contract §6 lists —
>    - `ContentDropperService.updateStage` → after commit: `io.of('/ws/notify').to('org:all').emit('content-dropper:updated', { clientId, period })`.
>    - The client-name PATCH → after commit: `io.of('/ws/notify').to('org:all').emit('client:name_updated', { clientId, name })`.
>    One line each; forward-wiring for Sprint 10.
>
> 4. **Tests** (extend `apps/api/test/services/period-rows.test.ts`): creating an active non-internal client mid-month generates its shoot slots **and** pipeline row **and** calendar cells for the current period; re-running adds nothing; an internal client gets none of the three.
>
> **RULES:** all generators idempotent; internal clients excluded; backfill inside the client-create transaction.
>
> Show me the two new generators and the wired backfill call site.

**Verify:**

```bash
pnpm --filter @skaly/api test services/period-rows
pnpm typecheck
```
`▶ /ponytail` — carried debt closed; review before routes.

---

## SPRINT 7 — STEP 5: Routes + Zod + registration

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 7, STEP 5. Services in. Now routes. Read `docs/07-API-CONTRACT.md` (Content Calendar) and `docs/08-AUTH-MATRIX.md` §3–§4.
>
> **WHAT TO BUILD**
>
> 1. **Zod schemas `packages/shared/src/schemas/content-calendar.ts`:** `CalendarQuerySchema` (`period` required `^\d{4}-\d{2}$`), `CellUpdateSchema` (`{ status?: enum(CALENDAR_STATUSES), note?: string.max(1000).nullable(), version: int().min(1) }` — **version required**; `.refine` at least one of status/note; **`.strict()`** so a stray `source` field is rejected).
>
> 2. **Routes `apps/api/src/routes/content-calendar/`** (register after content-dropper, per TRD §5.1):
>    - `GET /v1/content-calendar?period=` — `requireRole('admin','manager','team_member')` (**freelancer → 403**). → `getGrid`.
>    - `PATCH /v1/content-calendar/:id` — `requireRole('admin','manager')` (**team_member → 403**); body `CellUpdateSchema`; → `updateCell`. Surfaces `409 STALE_DATA`, `423 PERIOD_LOCKED`, `400 VALIDATION_ERROR`.
>
> 3. Confirm rate-limit headers (M-06).
>
> **RULES:** route `requireRole` is layer 2, the service asserts at layer 3. Envelopes per API-Contract §1.1.
>
> Show me the schemas, the routes, then confirm Swagger lists them.

**Verify:**

```bash
pnpm --filter @skaly/api dev   # /docs lists /v1/content-calendar*
pnpm typecheck
```
`▶ /ponytail`

---

## SPRINT 7 — STEP 6: Backend test round-out + full suite

**Goal:** Both canonical tests pass, and each of the three Trigger 2 corrections has a test that would fail without it.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 7, STEP 6. Now the full backend suite. Read `docs/12-TESTING-STRATEGY.md` §5.1 (the Trigger 2 test) + §5.2 (the 409 test) and `docs/adr/ADR-013`. Real local Postgres, `NODE_ENV=test`. Register the EventBus listeners in test setup so triggers actually fire.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/test/services/ContentCalendarService.test.ts`:**
>    - **Canonical 409 (Testing-Strategy §5.2):** a cell at `version: 3`, PATCH with `version: 2` as manager → **409**, `error.code === 'STALE_DATA'`, `details.currentVersion === 3`, and `details.updatedBy` present.
>    - **Auto-reset:** PATCH a cell whose `source='pipeline_trigger'` → the response row has `source === 'manual'` and `version` bumped, achieved in **one** UPDATE (assert only one write, e.g. version incremented by exactly 1).
>    - **`source` rejected in body:** PATCH with `{ status, source: 'pipeline_trigger', version }` → `400 VALIDATION_ERROR`.
>    - **Status validation:** an off-enum status → 400. All 6 valid values accepted.
>    - **Locked period** → 423. **team_member PATCH** → 403 (route). **freelancer GET** → 403.
>
> 2. **`apps/api/test/events/trigger2.test.ts` — the real-EventBus tests (Testing-Strategy §5.1 passes here):**
>    - **Canonical:** a pipeline with `raw_received_at` + `finals_ready_at` set → `ContentDropperService.updateStage(pipeline.id, 'posted', manager, version, db)` *(adapt the canonical 2-arg `markStage` call to the as-built signature — reconciliation #11)* → the `content_calendar` cell for `client_id` + today (IST) has `status === 'Posted'` and `source === 'pipeline_trigger'`.
>    - **Null-safety guard (correction 1):** the target cell starts with `source = NULL` → the trigger **writes** it. *(This test fails if the guard used `source != 'manual'` — it would skip NULL cells.)*
>    - **Manual guard:** set the cell's `source='manual'` + a manual status → mark Posted → the cell is **unchanged** (status and version both).
>    - **Period derivation (correction 2):** create a pipeline in period P (e.g. the prior month) with calendar cells existing in the **current** month; fire the posted stage so `postedAt` = today → assert the **current-month** cell is updated, not a cell in the pipeline's period. *(This fails if the listener used the event's `period`.)*
>    - **Missing cell (correction 3):** delete the target cell → mark Posted → the listener **no-ops** (no throw, no row created) and logs a warning; the pipeline write still succeeded.
>    - **Version bump (ADR-013):** capture the cell's `version` before → after the trigger it is **+1** (contrast with Trigger 1, which must not bump — the Sprint 6 orthogonal test still guards that).
>    - **Broadcast:** the listener emits `content-calendar:updated` to `org:all` with `{ clientId, period, date }` on a real write, and **not** on a skip (spy on the socket emit).
>    - **Locked period skip:** lock the target period → mark Posted → cell unchanged, warning logged.
>
> 3. **`apps/api/test/routes/content-calendar.test.ts` (Fastify `inject`):** manager GET 200 / PATCH 200; team_member GET 200 / PATCH 403; freelancer GET 403; PATCH without `version` → 400; rate-limit headers present.
>
> 4. Run the **whole** API suite + typecheck + lint.
>
> **RULES:** each of the three corrections gets a test that would fail without the fix. Assert against today-IST for the cell date.
>
> Show me the canonical Trigger 2 test, the null-safety test, and the period-derivation test first, then run the suite.

**Verify:**

```bash
pnpm --filter @skaly/api test        # full suite green — incl. the Trigger 2 canonical test
pnpm typecheck && pnpm lint
```
`▶ /ponytail` — full backend review before committing the backend half.

```bash
git add -A && git commit -m "Sprint 7 backend: ContentCalendarService + Trigger 2 consumer (ADR-013) + mid-month backfill close-out"
```

---

## SPRINT 7 — STEP 7: Frontend — virtualized grid structure

**Goal:** The calendar grid per UI/UX §11 with **column virtualization** — rendering only, before popover/highlight. This is the perf-critical step.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 7, STEP 7. Backend done. Now the grid — rendering only. Read `docs/03-UIUX.md` §11 (80px sticky date column, client columns min 90px, 48px rows, today row `--accent-gold-06` + auto-scroll, 6px gold dot), `docs/04-APPFLOW.md` §8, `docs/13-NFRS.md` §1.1 + §1.4 (the perf bar), and `docs/06-IMPLEMENTATION-PLAN.md` §10. Reuse the Sprint 3–6 chassis.
>
> **ARCHITECTURE DECISION (locked — build to this):** virtualize **columns**, not rows. Impl-Plan §10 specifies column virtualisation; clients are the unbounded axis while days are capped at 31. Rows (≤31 × 48px) render normally, which also keeps today-scroll a plain DOM scroll.
>
> **WHAT TO BUILD** — `apps/web/app/(portal)/content-calendar/page.tsx` + `apps/web/components/modules/content-calendar/` (no `src/`):
>
> 1. Data: `useQuery({ queryKey: ['content-calendar', period], queryFn: () => api.get('/content-calendar', { period }) })`. Index cells into a `Map` keyed `` `${clientId}:${date}` `` for O(1) cell lookup during render — do **not** `.find()` per cell (620 finds per render is the perf killer).
> 2. **Layout:** a horizontally-scrolling container. **Date column sticky left, 80px** (DM Mono, "07 Jul" + weekday). **Client columns dynamic, min 90px**, header = client name (truncate + tooltip). **Row height 48px.**
> 3. **Column virtualization — TanStack Virtual v3:**
>    ```ts
>    const colVirtualizer = useVirtualizer({
>      horizontal: true,
>      count: clients.length,
>      getScrollElement: () => scrollRef.current,
>      estimateSize: () => COLUMN_WIDTH,   // 90
>      overscan: 3,
>    });
>    ```
>    Render the inner track at `width: colVirtualizer.getTotalSize()` and position each virtual column absolutely at its `virtualItem.start` (offset by the 80px sticky date column). Rows map over all days; each row renders only the virtual columns.
> 4. **Today's row:** background `var(--accent-gold-06)`; on mount, scroll it into view (plain DOM — `todayRowRef.current?.scrollIntoView({ block: 'center' })` — rows aren't virtualized).
> 5. **Cell rendering:** status chip using the §4.3 colour mapping across the 6 statuses; a note indicator (small dot/icon) when `note` is non-empty; **a 6px gold dot at the chip's top-right when `source === 'pipeline_trigger'`**, with tooltip "Auto-updated from Content Dropper".
> 6. **Role handling:** `team_member` → the grid container gets `pointer-events: none` (Impl-Plan §10) and no popover; a labelled **"Comments — coming soon"** placeholder area stays outside that container (comments are a later sprint). `freelancer` never reaches the page (sidebar + 403).
> 7. **Locked period:** cells render as inert `<span>`s + the Sprint 3 locked banner.
> 8. Empty state + accessibility: `role="grid"`, `aria-rowindex`/`aria-colindex` on cells (important for a virtualized grid), focus ring `var(--accent-gold)`, 44×44 targets.
>
> **RULES**
>
> - Rendering only — no popover, no mutations, no highlight overlay yet.
> - Cell lookup is O(1) via the Map. No per-cell array scans.
> - Keep the virtual track and the sticky column in one scroll container so they stay aligned.
>
> Build it; I'll check alignment, today-row scroll, the trigger dots, and scroll smoothness before wiring interactions.

**Verify (manual):** grid renders; horizontal scroll is smooth; the sticky date column stays aligned with rows; today's row is gold-tinted and in view on load; cells that Trigger 2 set show the 6px gold dot + tooltip. Open DevTools → Performance → record a horizontal scroll → **confirm ~60fps** (NFR §1.4). If it stutters, check the Map lookup and `overscan`.
`▶ /ponytail` — review the virtualization before layering the overlay.

---

## SPRINT 7 — STEP 8: Frontend — popover, positioned-overlay highlight, optimistic + 409

**Goal:** The full APPFLOW §8 interaction set, including the **positioned-overlay** highlight — the variant that survives column recycling.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 7, STEP 8. Grid renders and scrolls at 60fps. Now interactions. Read `docs/04-APPFLOW.md` §8, `docs/03-UIUX.md` §11 + §4.4 (highlight state rules), `docs/09-ERROR-HANDLING.md` §5.1, and `docs/06-IMPLEMENTATION-PLAN.md` §10 (overlay approach). Reuse `handleMutationError`, the api client, and the Sprint 0 `useColumnHighlight` store.
>
> **WHAT TO BUILD** (admin/manager only — the API is the gate):
>
> 1. **Cell popover (200px, below the cell; APPFLOW §8):** click a cell → popover with a **status dropdown (the 6 shared values)** + a **note textarea**. Status select → immediate PATCH. Note → **800ms debounce** → PATCH. Closes on outside click / Esc. Never navigates.
> 2. **Optimistic update:** `useMutation` writes the new status/note into the `['content-calendar', period]` cache immediately (UIUX §11: "Status changes immediately; reverts on API failure with toast"); body is `{ status?, note?, version }` with **`version` from the cached cell** — and **never `source`** (server-managed). `onSuccess` **replace** the cell in cache with the returned row (new `version`, `source: 'manual'` → the gold dot disappears, which is the visible confirmation of the auto-reset). `onError` revert + `handleMutationError`.
> 3. **409 inline conflict (APPFLOW §8):** `STALE_DATA` → inline message on the cell: **"Updated by {details.updatedBy.name} — [Refresh row →]"** (gold link) → click invalidates `['content-calendar', period]`. Reuse the Sprint 3 inline-conflict component.
> 4. **Positioned-overlay gold column highlight (the Sprint 7 special):**
>    - A **single absolutely-positioned `div`** rendered inside the scroll container's **inner track** (so it scrolls with content), `pointer-events: none`, z-index **below** the popover.
>    - Its `left` comes from the **column virtualizer's virtual item `start`** for the active column (plus the 80px sticky offset), `width` = that item's `size`, `top: 0`, `height: totalRowsHeight`. **Do not compute `index × width`** — read the virtual item.
>    - If the active column is **not currently in `getVirtualItems()`** (scrolled out of range), hide the overlay rather than clamping it to the edge.
>    - Drive `activeColumn` from the existing `useColumnHighlight` store keyed by `clientId`, set on popover open / control focus, cleared per the §4.4 state rules — including the **failure path** (overlay stays, then clears 1.5s after the error toast).
>    - Give it `data-testid={`column-highlight-${clientId}`}` to match the Testing-Strategy E2E convention.
> 5. **`handleMutationError`:** reuse `STALE_DATA` (inline), `PERIOD_LOCKED`, `PERMISSION_DENIED`, `VALIDATION_ERROR`, default. No new codes needed.
> 6. **Real-time (ADR-010):** no socket subscription. Add `// TODO(Sprint 10): subscribe to content-calendar:updated on /ws/notify → invalidateQueries(['content-calendar', payload.period])`.
> 7. **Frontend tests:** the note debounce fires one PATCH per burst; the mutation sends the cached `version` and **never** `source`; the returned row replaces the cache and the gold dot disappears; `STALE_DATA` renders the inline conflict with the updater's name; the overlay positions from the virtual item and **hides when its column scrolls out of range** (the virtualization-specific case).
>
> **RULES**
>
> - The overlay must never be attached to a cell element — that's the whole reason for this variant.
> - Cell PATCH always carries the cached `version`; the response replaces the cache (version chain intact).
> - Build the popover + optimistic PATCH first; show me that working before the overlay.

**Verify (manual):** edit a cell's status → chip changes instantly; a Trigger-2 cell's **gold dot disappears** after your edit (auto-reset made visible). Type a note → one PATCH ~800ms after you stop. Bump a cell's `version` in psql then edit → inline "Updated by … — Refresh row →". Open a popover and scroll horizontally → the gold overlay tracks its column and **hides** when that column leaves the viewport (not stuck at the edge).

```bash
pnpm --filter @skaly/web test
```
`▶ /ponytail` — review the overlay + interactions before E2E and perf.

---

## SPRINT 7 — STEP 9: Playwright + performance verification

**Goal:** Prove the highlight in a real browser (the Testing-Strategy E2E) and prove the NFR perf bar with numbers, not vibes.

### 9.1 — Playwright (Prompt)

> **WHERE WE ARE**
>
> Sprint 7, STEP 9. Now E2E. Read `docs/12-TESTING-STRATEGY.md` §6 (the overlay E2E pattern — `getByTestId('column-highlight-…')`). Reuse the Sprint 3–6 `loginAs` + `playwright.config.ts`.
>
> **WHAT TO BUILD** — `tests/e2e/content-calendar.spec.ts`:
> 1. **Cell edit (admin):** `/content-calendar` → click a cell → popover opens → pick "Ready" → chip updates and the popover closes on outside click.
> 2. **Gold overlay (canonical pattern):** focus/open a cell in a known client column → `getByTestId('column-highlight-{clientId}')` **is visible**; blur/close → **not visible**. Then scroll horizontally until that column is off-screen → overlay **not visible** (the virtualization case).
> 3. **Trigger 2 round-trip:** via API, mark a pipeline Posted for client X (`POST`/`PATCH` the dropper stage) → reload the calendar → today's cell for X shows **Posted** + the gold dot; then edit that cell in the UI → the **dot disappears** (auto-reset).
> 4. **Conflict:** patch a cell via `page.request` to bump its version, then edit the same cell in the UI → the inline "Updated by … — Refresh row →" appears.
> 5. **Roles:** team_member → grid visible but no popover opens (assert `pointer-events: none` via computed style) and `page.request.patch('/v1/content-calendar/{id}', …)` → **403**. freelancer → `GET /v1/content-calendar` → **403**.
> 6. Run headed once, then headless (chromium + webkit).
>
> **RULES:** independent, re-runnable; clean up edited cells.
>
> Show me the spec, then run `pnpm exec playwright test tests/e2e/content-calendar.spec.ts --headed`.

### 9.2 — Performance verification (manual — this is the risk gate)

**Frontend (DevTools, against local or staging):**

1. **FCP / TTI:** Lighthouse or the Performance panel on `/content-calendar` with a full period loaded → **FCP < 1.5s, TTI < 2.0s** (NFR §1.1).
2. **Scroll:** record a horizontal scroll → **60fps** sustained, no long tasks > 50ms (NFR §1.4).
3. **Cell count sanity:** with ~20 clients, confirm only the visible + overscan columns are in the DOM (inspect the track — you should see ~13–16 columns, not 20+, and no more than 31 rows).

**Backend (k6, per Testing-Strategy):**

```bash
# tests/k6/content-calendar.js exists in the Testing Strategy — run against staging
k6 run tests/k6/content-calendar.js
# Target: GET /v1/content-calendar p95 < 300ms at 50 VUs (NFR §1.2 "GET module data")
```

If FCP or scroll misses: check (a) the O(1) Map lookup is actually in place, (b) `overscan` isn't inflated, (c) cells aren't re-rendering on every scroll tick (memoize the cell component), (d) the overlay isn't triggering layout thrash (it should be `transform`/`left` on a single element, not per-cell class churn).

**Verify:**

```bash
pnpm exec playwright test tests/e2e/content-calendar.spec.ts   # green, chromium + webkit
```
`▶ /ponytail` — final review before close-out. This is the sprint's risk gate: don't pass it on assumption.

---

## SPRINT 7 — STEP 10: End-to-end smoke + commit + close-out (manual)

### 10.1 — Full manual walk-through

```bash
docker compose up -d && pnpm dev
```

1. **Admin — calendar:** grid renders, today's row gold + scrolled into view, horizontal scroll smooth. Edit a cell (status + note) → instant update, note debounced.
2. **Trigger 2 (the loop closes):** go to Content Dropper → mark a pipeline `raw → finals → posted` for client X → return to the calendar → **today's cell for X is `Posted` with the gold dot + "Auto-updated from Content Dropper"**.
   ```sql
   SELECT status, source, version, updated_by FROM content_calendar
   WHERE client_id='<X>' AND date = (now() AT TIME ZONE 'Asia/Kolkata')::date;
   -- status='Posted', source='pipeline_trigger', updated_by = System Actor UUID, version bumped
   ```
3. **Auto-reset made visible:** edit that same cell in the UI → the **gold dot disappears**; `SELECT source` → `'manual'`.
4. **Manual guard:** mark the same pipeline's client Posted again (or re-fire the trigger) → the manual cell is **unchanged**.
5. **Cross-month derivation:** if the prior month is available, mark a *prior-period* pipeline Posted today → the **current** month's cell updates (not a prior-month cell).
6. **Mid-month client:** create a new active non-internal client → it appears as a calendar column with cells for the whole month, a pipeline row, and shoot slots (all three backfills).
7. **Conflict:** bump a cell's `version` in psql → edit it → inline "Updated by … — Refresh row →".
8. **Roles:** team_member → grid read-only (no popover), PATCH → 403. freelancer → no `/content-calendar` in the sidebar; GET → 403.
9. **Locked month:** lock the prior month → cells inert, PATCH → 423; fire a trigger targeting it → skipped + logged.
10. **Audit:** `SELECT staff_id, changed_by_source, table_name, action FROM audit_log WHERE table_name='content_calendar' ORDER BY created_at DESC LIMIT 10;` — user UPDATEs plus trigger rows by the System Actor (`changed_by_source='system'`), `staff_id` never NULL.

`▶ /ponytail` — full-sprint review before the close-out checklist.

### 10.2 — Close-out checklist

Do not start Sprint 8 until **every** box is checked:

```
PRE-SPRINT DECISIONS EXECUTED
  [ ] ADR-013 committed (system-write version semantics); ADR-012 cross-ref amended (M-04 collision noted)
  [ ] content_calendar schema verified: version, nullable source, 6-value status CHECK, period FK months

BACKEND — ContentCalendarService
  [ ] getGrid: all days × active non-internal clients + clients list + locked flag; admin/manager/team_member
  [ ] updateCell: optimisticUpdate (C-02); version required; 409 STALE_DATA w/ currentVersion + updatedBy (TESTED)
  [ ] Auto-reset: any user PATCH sets source='manual' in the SAME UPDATE (TESTED)
  [ ] source rejected if sent in the request body (400)
  [ ] 6-value status constant shared across schema/service/frontend
  [ ] Locked period → 423; team_member PATCH → 403; freelancer GET → 403

BACKEND — Trigger 2 consumer
  [ ] Guard is source IS DISTINCT FROM 'manual' — NULL-source cells ARE written (TESTED)
  [ ] Target period derived from postedAt, NOT the event's period (cross-month TESTED)
  [ ] Missing cell → no-op + warn, never created (TESTED)
  [ ] Locked target period → skip + log (TESTED)
  [ ] Write bumps version (ADR-013 case 2) — TESTED; Sprint 6's Trigger 1 no-bump test still green
  [ ] Audit row: System Actor + changed_by_source='system' (C-04)
  [ ] Broadcasts content-calendar:updated to org:all on write only, payload { clientId, period, date }
  [ ] Testing-Strategy §5.1 "pipeline posted triggers content_calendar cell to Posted" PASSES

BACKEND — carried debt
  [ ] Mid-month client backfill closed: shoot slots + pipeline row + calendar cells (TESTED); TODO removed
  [ ] content-dropper:updated + client:name_updated emits present (API-Contract §6)

FRONTEND
  [ ] Column virtualization (TanStack Virtual v3, horizontal); rows render normally
  [ ] Sticky 80px date col aligned; client cols min 90px; 48px rows
  [ ] Today row --accent-gold-06 + auto-scroll into view on load
  [ ] O(1) cell lookup via Map (no per-cell .find())
  [ ] 6px gold dot + "Auto-updated from Content Dropper" tooltip on pipeline_trigger cells
  [ ] Popover 200px: 6-value status dropdown + note textarea (800ms debounce), closes on outside click
  [ ] Optimistic update + revert-on-fail with toast; cached version sent; source NEVER sent
  [ ] 409 → inline "Updated by [Name] — [Refresh row →]"
  [ ] Positioned-overlay highlight from the virtual item's start; hides when column scrolls out of range
  [ ] team_member: pointer-events:none grid + comments placeholder (not built); freelancer blocked
  [ ] No frontend socket client (ADR-010); // TODO(Sprint 10) marker

TESTS + PERF
  [ ] ContentCalendarService + trigger2 + route suites green; each of the 3 corrections has a failing-without-fix test
  [ ] Frontend tests green (debounce, no-source, cache replace, overlay hide-on-scroll-out)
  [ ] Playwright: cell edit + overlay visible/hidden + trigger round-trip + conflict + roles — chromium & webkit
  [ ] NFR verified with numbers: FCP < 1.5s, TTI < 2.0s, 60fps scroll, k6 GET p95 < 300ms
  [ ] pnpm typecheck + pnpm lint clean
  [ ] /ponytail run at each Verify gate — no outstanding review flags
```

### 10.3 — Final commit

```bash
git add -A
git commit -m "Sprint 7: Content Calendar + Trigger 2 consumer (guarded cell write, ADR-013) + virtualized grid + overlay highlight"
git push -u origin sprint-7-content-calendar
```

Open the PR to `main`; CI must be fully green before merge. Merge, then `git checkout main && git pull`.
`▶ /ponytail` — post-merge checkpoint.

### 10.4 — Move to Sprint 8

Open `MASTER-BUILD-GUIDE-V2-FINAL.md` → PART 9 → **SPRINT 8 — AI BOT (QUERY TOOLS)**, or the forthcoming `SPRINT-8-DETAILED.md`.

**Both cross-module triggers are now live.** Every grid module is built. Sprint 8 turns to the AI Management Bot: the Anthropic tool-calling loop, the 11 query tools, `resolvePermission` (deferred since Sprint 3 — now due), and the C-01 streaming contract.

**⚠️ Read the first decision below before starting Sprint 8 — there's a sequencing conflict that must be resolved first.**

---

## DECISIONS TO MAKE BEFORE SPRINT 8

- **⚠️ C-01 vs ADR-010 — the bot has no delivery channel. Resolve this first.** API-Contract §Bot (audit C-01) is explicit: `POST /v1/bot/message` returns **202 with only `{ messageId, sessionId }`**, and the bot's actual response — streaming tokens, tool results, cards — is delivered **exclusively** via Socket.io `bot:message` to `user:{staffId}`. But ADR-010 defers the frontend socket client to Sprint 10. **As sequenced, Sprint 8's bot would be unusable — the UI would have no way to receive a single token.** Two options: **(a)** pull the frontend socket client forward into Sprint 8 (the `/ws/notify` connection + `bot:message` subscription + the C-05 token-refresh handshake it depends on), leaving Sprint 10 to attach the *remaining* module subscriptions and the bell UI; or **(b)** build Sprint 8 backend-only and defer the entire bot UI to Sprint 10. **Recommendation: (a).** The rationale for deferring was "build the client once, with C-05" — that still holds if it's built in Sprint 8; Sprint 10 becomes "attach remaining consumers", which is additive. Option (b) leaves a whole sprint's work unverifiable end-to-end. Decide before Sprint 8 day 1 and amend ADR-010.
- **`resolvePermission` is now due (deferred from Sprint 3).** `ROLE_DEFAULTS` exists; Sprint 8 needs the resolver: read `perms:{staffId}` (Redis, 5-min TTL, JSON array of `{permissionKey, value}`) → fall back to `ROLE_DEFAULTS[key][role]`; the admin override endpoint **deletes the Redis key** on write (Auth-Matrix §6.3). Build it against its first real consumer (bot tool gating) exactly as planned. Confirm the 🔧 keys (`bot.tool.update_task_status`, `chat.access`) resolve correctly for an overridden team_member.
- **Bot tool scoping vs the 🔐 rows.** `ROLE_DEFAULTS` encodes 🔐 (own-data) as `true` — the *gate* passes and the **tool implementation** applies the scope. Sprint 8's query tools must therefore apply the same isolation the REST layer does: `list_tasks`/`get_attendance` scoped to self for team_member, `get_shoot_schedule` scoped via the ADR-011 freelancer predicate. Lock that the tools reuse the **existing service methods** (which already isolate) rather than issuing their own queries — otherwise ADR-011 is silently bypassed by the bot.
- **Bot model + streaming:** `claude-sonnet-4-6` in production / `claude-haiku-4-5-20251001` in dev (THIRD-PARTY §3.1), `max_tokens: 1024`, `stream: true` (NFR §1.3 — TTFT < 2s is the metric, not total time). Confirm the streaming path emits incrementally over `bot:message` rather than buffering.
- **Still deferred, on schedule:** MFA enrollment wiring (ADR-002 → Sprint 8), remaining socket subscriptions + bell UI (Sprint 10), comment system (later sprint), attachment orphan cron + `coming_shoot_date` rollover recompute (Sprint 12).

---

## TROUBLESHOOTING — SPRINT 7 SPECIFIC

### Trigger 2 fires but no calendar cell changes (the classic)
Almost always one of the three corrections. In order of likelihood: (1) the guard is `source != 'manual'` instead of `IS DISTINCT FROM` — NULL-source cells (nearly all of them) evaluate to NULL and get skipped; (2) the lookup used the event's `period` instead of `postedAt.slice(0,7)`; (3) the cell genuinely doesn't exist (un-backfilled mid-month client — STEP 4) and the no-op is correct. Check the warn log first.

### The trigger works for cells a user has touched, but not fresh ones
That's the null-safety bug, precisely. `source IS DISTINCT FROM 'manual'`.

### A cross-month post updates nothing
Period derivation. A pipeline in `2026-07` posted on `2026-08-02` needs the `2026-08` cell. Derive from `postedAt`, never from the event's `period`.

### A user editing a cell gets a 409 right after a trigger fired
Correct behaviour (ADR-013 case 2) — the trigger changed `status`, the same column they're editing. They refresh and re-apply. Contrast with Trigger 1, which must *not* bump version.

### The gold dot doesn't disappear after a manual edit
The auto-reset isn't in the UPDATE, or the frontend isn't replacing the cached cell with the response. `source: 'manual'` must be part of the same `optimisticUpdate` patch, and `onSuccess` must replace (not merge) the cache entry.

### `source` shows up in a PATCH body
The Zod schema isn't `.strict()`. Per API-Contract, the frontend never sends `source` — reject it explicitly so a client can't force a provenance value.

### The highlight overlay is offset, or jumps while scrolling
You computed `left` as `index × columnWidth`. Read the **virtual item's `start`** from `colVirtualizer.getVirtualItems()` and add the 80px sticky offset. If the item isn't in the list (scrolled out), hide the overlay rather than clamping.

### The highlight disappears/flickers when scrolling horizontally
Expected if it's class-based — virtualized columns unmount. That's exactly why the positioned-overlay variant is mandated here (Impl-Plan §10). Move it out of the cells into a single container-level div.

### Scroll stutters below 60fps
In order: per-cell `.find()` instead of the O(1) Map; the cell component not memoized so all rows re-render per scroll tick; `overscan` set too high; or the overlay recalculating layout on every frame. Profile with the Performance panel — look for long tasks > 50ms.

### Today's row doesn't scroll into view
With rows non-virtualized this is a plain `scrollIntoView` on the row ref after data loads — make sure it runs *after* the query resolves, not on first mount with an empty grid.

### The k6 GET is slow (p95 > 300ms)
The grid query is returning cells one-per-row without an index hit. Confirm the query filters on `period` (indexed via the UNIQUE) and that you're not N+1-ing the `updated_by` staff lookup — join it once.

---

## END OF SPRINT 7 DETAILED GUIDE

*Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1/2/3/4/5/6-DETAILED.md`. Source-of-truth precedence when documents differ: the numbered spec docs (`01`–`14`) + the schema win, then this guide's reconciliations and the ADRs it executes (006–013), then the Master Build Guide's shorthand. **Both cross-module triggers are live as of this sprint.** Sprint 8 (AI Bot — query tools) turns to the Anthropic tool-calling loop, `resolvePermission`, and the C-01 streaming contract — read the first pre-Sprint-8 decision before starting.*
