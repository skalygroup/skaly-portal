# SPRINT 5 — SHOOT PLANNER: DETAILED PROMPT-BY-PROMPT GUIDE

## Scaly Business Portal • Sprint 5 of 13

**Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1/2/3/4-DETAILED.md`**
**Same Goal / Prompt / Verify framework as Sprints 0–4**
**Tooling interfaces verified as of January 2026** — Next.js 15 (App Router), TanStack Table v8 + TanStack Query v5, Zustand 5, shadcn/ui on Tailwind 4 (`@theme`), Framer Motion 11, date-fns v4 (+ `@date-fns/tz` for IST), Playwright latest, Lucide React.

---

## WHAT YOU'RE BUILDING IN SPRINT 5

Sprint 4 gave you the module chassis and the notification/attachment patterns. Sprint 5 is the **first module a fourth role (freelancer) can see**, and the **first producer of a cross-module trigger**. Its two genuinely new patterns are **query-level freelancer isolation** and **emit-now / recompute-in-Sprint-6**. By the end of this week:

- **The pre-Sprint-5 decisions are executed and recorded:** ADR-011 (freelancer row-level isolation) is committed; the Sprint 2 EventBus is extended with a **`shoot:reset`** event; the **derived `coming_shoot_date`** contract (guarded by `coming_shoot_source`) is designed here and implemented in Sprint 6; slot edits are locked to **last-write-wins** (no `version`).
- **`ShootPlannerService`** is real: `getGrid` with **query-level freelancer isolation** (`WHERE freelancer_id = self`, audit M-07 / ADR-011); the four-state slot lifecycle (`Unset → Scheduled → Confirmed → Completed`) via `update`; `reset` (→ `Unset`, `{ confirm: true }` mandatory); **Trigger 1 producer** — `shoot:confirmed` emitted on Confirm; the `shoot_confirmed` notification to the assigned freelancer; and the **`shoot:reset`** emit on reset.
- **Mid-month client backfill** works: a client activated mid-period gets its shoot slots generated for the current period via the **same `generateShootSlotsForClient` core** the Sprint 3 rollover uses.
- **Slot-count adjustment** (audit H-06 family): an admin can change a client's `shoot_slots_per_month`, which reconciles the current period's slots (adds `Unset` slots on increase; safely removes only trailing `Unset` slots on decrease).
- **Routes** match API-Contract §8 exactly, role-gated, Swagger-visible.
- **The shoot planner grid** renders per UI/UX §9: sticky 200px client column, **dynamic slot columns** (= max `shoot_slots_per_month`), **N/A cells** for clients with fewer slots (`opacity: 0.15`, inert, "—"), **week groupings computed at render** from `slot_date` (no stored `week_number`), slot cells (status chip + `slot_date` + pieces badge), and the **slot popover** (date picker + pieces stepper + freelancer dropdown + stage CTA) with the gold column highlight.
- **The freelancer view** shows only their own rows, **read-only** (no popover edit, no reset).
- **Real-time is emitted, not consumed** (ADR-010): the `shoot_confirmed` notification **row is written** in Sprint 5 (durable per-record, like `task_assigned`); the `shoot:confirmed` / `shoot:reset` **events fire**; the coming_shoot_date recompute and the notification bell UI both land later (Sprint 6 / Sprint 10). No frontend socket client.
- **Tests** prove it: freelancer isolation (M-07 — own visible, others' + unassigned blocked), the `shoot:confirmed` event fires on Confirm (**spy** — the coming_shoot_date assertion is Sprint 6), reset-without-`confirm` → 400, mid-month backfill count — plus a Playwright smoke for the schedule → confirm → reset lifecycle and freelancer isolation.

**Estimated time:** 5 working days (Week 6 per `06-IMPLEMENTATION-PLAN.md` §8; owners TL + D2). Day 1 pre-flight + `ShootPlannerService`; day 2 backfill + slot-count + routes; day 3 backend tests; days 4–5 frontend + E2E.

**Prerequisites from Sprint 4** (all green — stop and fix if any is not):

- Sprint 4 close-out fully checked; PR merged; CI green.
- The five pre-Sprint-4 ADRs (006–010) are committed; the **pre-Sprint-5 ADR-011** is ready to commit (STEP 1).
- The chassis works: `(portal)` layout + RBAC sidebar, `MonthContext`, `lib/api.ts`, `handleMutationError`, `useColumnHighlight`, `AuditService`, `NotificationService`, the **Sprint 2 `EventBus`** (declaring `shoot:confirmed` + `pipeline:posted`), `BaseService` (`assertPeriodNotLocked`, `softDeletable`, `getCurrentPeriod`), and the Sprint 3 `generatePeriodRows` / `generateShootSlotsForClient` core.
- `pnpm typecheck`, `pnpm lint`, and the full suite green on `main`.

---

## THE FIVE PRE-SPRINT-5 DECISIONS — WHERE THEY LAND

Ruled at the pre-Sprint-5 gate; **inputs** to this sprint. STEP 1 commits ADR-011 and extends the EventBus; the steps below execute the rest.

| Decision | Ruling | Executed in |
|---|---|---|
| **Trigger 1 emit-now / consume-Sprint-6** | Sprint 5 **emits** `shoot:confirmed` (declared in Sprint 2) after commit; the listener + `coming_shoot_date` write are Sprint 6. Sprint 5's test is a **spy** (event fires), not a pipeline assertion. | STEP 2 (emit) + STEP 5 (spy test) |
| **`shoot:reset` event (EventBus extension)** | Add `shoot:reset { clientId, period }`; emit on reset so Sprint 6 can recompute `coming_shoot_date`. Also re-emit `shoot:confirmed` on a **reschedule of an already-Confirmed** slot. | STEP 1 (declare) + STEP 2 (emit) |
| **Derived `coming_shoot_date` (guarded)** | `coming_shoot_date = MIN(slot_date WHERE Confirmed AND slot_date ≥ today)`, written **only if `coming_shoot_source IN (NULL,'trigger')`**, `NULL` if none. **Designed here, implemented in Sprint 6's listener** (module boundary). Sprint 5 does not write `content_pipelines`. | Documented STEP 2; built Sprint 6 |
| **Freelancer isolation query-level (ADR-011)** | `WHERE freelancer_id = currentUser.staffId` added to the query **before** execution — never post-filter. Unassigned slots invisible to freelancers; non-owned slot → **404**. Freelancer is **read-only**. | STEP 2 (getGrid) + STEP 5 (M-07 test) |
| **Shoot slots not versioned** | `shoot_schedules` has no `version`; slot edits are **last-write-wins**; `optimisticUpdate` never used. (`content_pipelines` **is** versioned — the Sprint 6 recompute bumps *its* version.) | STEP 2 (update) |

---

## READ FIRST (Open in Antigravity Split View)

`@`-reference these with `@docs/04-APPFLOW.md`.

| Doc | Sections | Why |
|---|---|---|
| `docs/04-APPFLOW.md` | §6 (Shoot Planner — the definitive lifecycle) | Every slot interaction + the exact trigger point |
| `docs/07-API-CONTRACT.md` | §8 (shoot-planner GET/PATCH/reset) + §1.1 envelopes | Exact request/response shapes |
| `docs/03-UIUX.md` | §9 (Shoot Planner), §4.2 (cell types), §4.3 (status chips), §4.4 (gold highlight), §4.5 (popover) | Every visual rule |
| `docs/08-AUTH-MATRIX.md` | §4 (shoot-planner access grid), §8 (freelancer isolation — both layers) | Who reads/edits; the isolation boundary |
| `docs/05-BACKEND-SCHEMA.md` | `shoot_schedules` (280) — note **no `version`, no `week_number`**, `slot_status` enum, `UNIQUE(period,client_id,slot_index)`; `content_pipelines` (307) — `coming_shoot_date` + `coming_shoot_source`; `clients` (`shoot_slots_per_month`, `pieces_per_visit`) | Column truth |
| `docs/09-ERROR-HANDLING.md` | §2 (`SHOOT_RESET_CONFIRMATION_REQUIRED`, `PERIOD_LOCKED`, `RESOURCE_NOT_FOUND`) | Error shapes |
| `docs/06-IMPLEMENTATION-PLAN.md` | §8 | Sprint 5 checklist |
| `docs/12-TESTING-STRATEGY.md` | §5.3 (freelancer isolation / M-07), §4.2 (shoot/trigger tests), the "no `week_number`" test | The tests you must reproduce |
| `docs/decisions/` | **ADR-006 → ADR-011** | The rulings this sprint executes |

---

## CONSISTENCY RECONCILIATIONS — LOCK THESE BEFORE YOU PROMPT

The Master Build Guide's Sprint 5 shorthand drifts from the canonical specs in several load-bearing places. The numbered specs + schema win; the corrections are baked into every prompt — know **why**:

1. **The table is `content_pipelines`, not `content_dropper`.** "Content Dropper" is the UI/module name; the database table is `content_pipelines`. Every "content_dropper" reference in the Master Guide means `content_pipelines`.
2. **Reset error is `SHOOT_RESET_CONFIRMATION_REQUIRED` (HTTP 400)** — not `CONFIRMATION_REQUIRED`. Source: `09-ERROR-HANDLING.md` §2 + `07-API-CONTRACT.md` §8.
3. **The freelancer notification type is `shoot_confirmed`, fired on CONFIRM** (not `freelancer_assigned` on assignment). It goes to the **assigned freelancer** (if a `freelancer_id` is set on the slot) when the slot transitions to `Confirmed`. Source: `04-APPFLOW.md` §6 + the `notifications_type_check` enum. The Master Guide's `freelancer_assigned`-on-assign is wrong. **This row is durable per-record (like `task_assigned`) → written in Sprint 5** (ADR-010 distinction); display/live-delivery is Sprint 10.
4. **Slot count lives in `clients.shoot_slots_per_month`** — required at client creation (`CLIENT_SHOOT_SLOTS_REQUIRED`), already enforced since Sprint 1. There is **no `slot_count` column and no "default 4 placeholder" gap** (the canonical design mandates the value). The adjust endpoint updates `shoot_slots_per_month` and reconciles the current period's slots.
5. **`shoot_schedules` has NO `version`** → slot edits are last-write-wins, no `optimisticUpdate`, no `STALE_DATA`. (Testing-Strategy `confirmSlot(actorId, slotId, slotDate, piecesExpected)` — the 4th arg is **pieces**, not a version.)
6. **`shoot_schedules` has NO `week_number`** → weeks are **computed at render** from `slot_date` (date-fns), never stored. Confirmed by the Testing-Strategy "slots generated without week_number field" test. Do not add the column.
7. **Trigger 1's LISTENER is Sprint 6, not Sprint 5.** Sprint 5 only **emits** `shoot:confirmed`. So Sprint 5's test asserts the **event fires** (spy on EventBus); the `content_pipelines.coming_shoot_date` assertion (Testing-Strategy §4.2, "shoot confirmed triggers coming_shoot_date update") is a **Sprint 6** test. Do not wire the listener or write `content_pipelines` in Sprint 5.
8. **`coming_shoot_date` is DERIVED, guarded by `coming_shoot_source`** (pre-Sprint-5 ruling). The Sprint 6 listener recomputes `MIN(slot_date WHERE Confirmed AND ≥ today)`, writes only if `coming_shoot_source IN (NULL,'trigger')`, `NULL` if none. Sprint 5 emits `shoot:confirmed` (on confirm **and** on rescheduling a confirmed slot) and `shoot:reset` (on reset) so Sprint 6 can recompute for every case.
9. **Freelancer isolation is query-level (ADR-011 / audit M-07).** `WHERE freelancer_id = self` before execution; unassigned slots (`freelancer_id IS NULL`) are **not** visible to any freelancer; a freelancer requesting a non-owned slot → **404** (not 403). Freelancer is **read-only** on shoot-planner (PATCH/reset → 403 at the route).
10. **The H-03 test is already written** (Sprint 4, ADR-006). The Master Guide/Impl-Plan schedule a "back-port" in Sprint 5 — you front-ran it. Sprint 5 just **confirms it's green**, no rebuild.
11. **Frontend path is `apps/web/app/(portal)/shoot-planner/`** (no `src/`), matching Sprint 3/4. The Master Guide's `apps/web/src/app/…` is not what was built.
12. **Reset is allowed from any non-`Unset` state → `Unset`** (not only from `Completed`). It clears `slot_date` + `freelancer_id`, restores `pieces_expected` to the client's `pieces_per_visit` (the generated default — not a hardcoded 1), sets `slot_status='Unset'`, audits, and emits `shoot:reset`.
13. **Comments are OUT of scope this sprint.** Auth-Matrix §3 marks shoot-planner as a comment attachment point (team_member/freelancer "+ comments"), but the comment system (`/v1/comments`, the `comments` table, audit H-06 soft-reference) is built in a later sprint. Do **not** build comments here.

---

## AUDIT + ADR ITEMS THIS SPRINT MUST HANDLE

| ID | What | Where |
|---|---|---|
| **M-07 / ADR-011** | Freelancer row-level isolation — query-level `WHERE freelancer_id = self`; own visible, other freelancers' + unassigned blocked; non-owned → 404. **Tested.** | STEP 2 + STEP 5 |
| **Trigger 1 (producer)** | `shoot:confirmed { clientId, period, slotDate }` emitted after commit on Confirm (and reschedule-of-confirmed). **Spy test** this sprint; the coming_shoot_date effect is Sprint 6. | STEP 2 + STEP 5 |
| **`shoot:reset` (new)** | EventBus extended; emitted on reset for the Sprint 6 recompute. | STEP 1 + STEP 2 |
| **`shoot_confirmed` notification** | Durable per-record row to the assigned freelancer on Confirm (written now; displayed Sprint 10). | STEP 2 |
| **H-06 family (slot count)** | `shoot_slots_per_month` adjust endpoint with current-period slot reconciliation. | STEP 3 |
| **H-03 (confirm only)** | The Sprint 4 N-for-N `task_assigned` test still green (no rebuild). | STEP 5 |
| **No stored `week_number`** | Weeks computed at render; regression test that `shoot_schedules` rows carry no `week_number`. | STEP 5 |

If you skip the test for any of these, Sprint 5 is not done. They reappear in CI when you push.

---

## STEP-BY-STEP STRUCTURE

| # | Type | What |
|---|---|---|
| 1 | Manual | Pre-flight — Sprint 4 green, commit ADR-011, extend EventBus with `shoot:reset`, confirm no `version`/`week_number`, branch |
| 2 | Prompt | `ShootPlannerService` — getGrid (isolation) + lifecycle + reset + triggers + `shoot_confirmed` notification |
| 3 | Prompt | Mid-month client backfill (`generateShootSlotsForClient`) + slot-count adjust + reconciliation |
| 4 | Prompt | Routes + Zod schemas + registration + Swagger |
| 5 | Prompt | Backend test round-out + full suite |
| 6 | Prompt | Frontend — shoot planner grid (client×slot, dynamic columns, N/A cells, week grouping, slot cells) |
| 7 | Prompt | Frontend — slot popover lifecycle + reset confirm + freelancer read-only view + gold highlight + errors |
| 8 | Manual + Prompt | Playwright smoke — schedule → confirm → reset + freelancer isolation |
| 9 | Manual | End-to-end smoke + commit + close-out |

---

## SPRINT 5 — STEP 1: Pre-flight (manual)

**Goal:** Solid ground, ADR-011 committed, the EventBus extended with the reset event before any service references it.

### 1.1 — Confirm Sprint 4 is green

```bash
git checkout main && git pull
docker compose up -d && docker compose ps          # both healthy
pnpm install
pnpm --filter @skaly/api db:status                 # 0 pending
pnpm typecheck && pnpm --filter @skaly/api test    # green before branching
```

### 1.2 — Confirm the schema facts this sprint depends on

```bash
docker compose exec postgres psql -U skaly -d skaly_dev -c "\d shoot_schedules" | grep -iE "version|week_number" || echo "no version + no week_number on shoot_schedules — correct"
docker compose exec postgres psql -U skaly -d skaly_dev -c "\d content_pipelines" | grep -iE "coming_shoot_date|coming_shoot_source|version"
# expect: content_pipelines HAS coming_shoot_date, coming_shoot_source, and version
```

### 1.3 — Commit ADR-011

```bash
ls docs/decisions/ADR-011*.md || echo "drop ADR-011 (freelancer isolation) in first"
git add docs/decisions/ADR-011-*.md
git commit -m "docs(adr): record ADR-011 freelancer row-level isolation"
```

### 1.4 — Extend the EventBus with `shoot:reset` (Prompt)

> **WHERE WE ARE**
>
> Sprint 5, STEP 1.4. Executing a pre-sprint ruling: the Sprint 2 EventBus declares `shoot:confirmed` and `pipeline:posted`; I need to add a `shoot:reset` event before `ShootPlannerService` uses it. Read `apps/api/src/lib/EventBus.ts` and `docs/decisions/ADR-010`.
>
> **WHAT TO BUILD**
>
> Add one typed event to the EventBus event map:
> - `'shoot:reset'` → `{ clientId: string; period: string }`
>
> Keep the existing `'shoot:confirmed' → { clientId, period, slotDate }` and `'pipeline:posted'` unchanged. Update the file-top comment: "Listeners attached in Sprint 6 (`shoot:confirmed` AND `shoot:reset` → ContentDropperService recomputes `coming_shoot_date` from the confirmed-future slot set, guarded by `coming_shoot_source`) and Sprint 7 (`pipeline:posted`)." Do **not** attach listeners.
>
> **RULES:** typed emit/on; wrong payload = compile error. Extend the existing test with a `shoot:reset` emit/handler case (+ a `@ts-expect-error` for a wrong payload).
>
> Show me the updated event map and the file-top comment.

**Verify:**

```bash
pnpm --filter @skaly/api test lib/EventBus.test && pnpm typecheck
```

### 1.5 — Branch

```bash
git checkout -b sprint-5-shoot-planner
```

**Verify gate:** Sprint 4 green, schema facts confirmed, ADR-011 committed, `shoot:reset` declared, on `sprint-5-shoot-planner`. Proceed.

---

## SPRINT 5 — STEP 2: `ShootPlannerService` — grid, lifecycle, reset, triggers

**Goal:** The module brain, executing freelancer isolation (ADR-011), the four-state lifecycle, last-write-wins (no version), and Trigger 1 + `shoot:reset` emits + the `shoot_confirmed` notification.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 5, STEP 2. Chassis + EventBus (`shoot:confirmed`, `shoot:reset`) ready. Building `ShootPlannerService`. Read `docs/04-APPFLOW.md` §6 (the definitive lifecycle), `docs/07-API-CONTRACT.md` §8, `docs/08-AUTH-MATRIX.md` §4 + §8, `docs/05-BACKEND-SCHEMA.md` (`shoot_schedules` — **no `version`**, `slot_status ∈ ('Unset','Scheduled','Confirmed','Completed')`), and `docs/decisions/ADR-010`, `ADR-011`.
>
> **HARD CONSTRAINTS FROM THE ADRs:**
> - **ADR-011:** freelancer isolation is **query-level** — add `WHERE freelancer_id = currentUser.staffId` to `getGrid` **before** execution; never post-filter. Unassigned slots are invisible to freelancers. A freelancer requesting a non-owned slot → **404**. Freelancer PATCH/reset never reaches here (route-blocked), but assert defensively.
> - **No `version` (schema):** never call `optimisticUpdate`; slot updates are plain guarded `UPDATE`. No `STALE_DATA`.
> - **ADR-010 / module boundary:** emit events; do **not** write `content_pipelines` here (that's Sprint 6). The `shoot_confirmed` notification **row IS written** here (durable per-record).
>
> **WHAT TO BUILD** — `apps/api/src/services/ShootPlannerService.ts`:
>
> 1. **`getGrid(period, currentUser, db)`** — returns `{ slots, clients }` (or the API-Contract §8 shape): all `shoot_schedules` rows for the period joined with client name + assigned-freelancer name. **Role scope (Auth-Matrix §4/§8):** admin/manager/team_member read **all** rows; **freelancer → `.where('freelancer_id','=',currentUser.staffId)` on the base query**. `clients` = active non-internal clients with their `shoot_slots_per_month` (so the frontend can size columns). Use `softDeletable` on clients. camelCase at the boundary.
>
> 2. **`getSlot(id, currentUser, db)`** — single slot; for freelancer, 404 if `freelancer_id !== currentUser.staffId` (don't reveal existence).
>
> 3. **`update(id, patch, currentUser, db)`** — **admin/manager only** (route-gated; assert). `patch = { slotStatus?, slotDate?, piecesExpected?, freelancerId? }`. Drives the lifecycle. One transaction:
>    a. Load slot (404 if missing). `assertPeriodNotLocked(period, trx)`.
>    b. **Validate the transition** against `slot_status`: allowed forward moves are `Unset→Scheduled`, `Scheduled→Confirmed`, `Confirmed→Completed`; a same-state field edit (e.g. change `slot_date`/`freelancer_id` while `Scheduled` or `Confirmed`) is allowed; any illegal jump → `400 VALIDATION_ERROR` ("Invalid slot transition"). (Backward moves go through `reset`.)
>    c. When moving to `Scheduled` or `Confirmed`, a `slot_date` must be present (in the row or the patch) → else `400 VALIDATION_ERROR` ("A shoot date is required").
>    d. Plain guarded `UPDATE shoot_schedules SET ...patch, updated_by, updated_at = now() WHERE id = ? RETURNING *` (**no version**).
>    e. `AuditService.log(entity:'shoot_schedules', action:'UPDATE', before, after, trx)`.
>    f. **After COMMIT**, if the resulting `slot_status === 'Confirmed'` **and** a `slot_date` is set (covers both first-confirm and rescheduling a confirmed slot):
>       - `EventBus.emit('shoot:confirmed', { clientId: slot.client_id, period, slotDate })` — **Trigger 1** (consumed Sprint 6).
>       - If `freelancer_id` is set → `NotificationService.create({ recipientId: freelancer_id, type: 'shoot_confirmed', title: '<clientName> shoot confirmed', body: 'Shoot confirmed for <slotDate>', data: { slotId: id, clientId, period, slotDate, link: '/shoot-planner?period='+period } })` — durable per-record (ADR-010). If the confirming user IS that freelancer, still notify (they're read-only, so they didn't self-confirm — but guard actor-exclusion anyway for consistency).
>    g. Return the full updated slot.
>
> 4. **`reset(id, currentUser, confirm, db)`** — **admin/manager only**. If `confirm !== true` → `400 SHOOT_RESET_CONFIRMATION_REQUIRED`. One transaction:
>    a. Load slot (404 if missing). `assertPeriodNotLocked`. Allowed from **any non-`Unset` state** → `Unset`.
>    b. Load the client's `pieces_per_visit`. `UPDATE shoot_schedules SET slot_status='Unset', slot_date=NULL, freelancer_id=NULL, pieces_expected=<client.pieces_per_visit>, updated_by, updated_at=now() WHERE id`.
>    c. `AuditService.log(action:'UPDATE', before, after)`.
>    d. **After COMMIT:** `EventBus.emit('shoot:reset', { clientId, period })` — so Sprint 6 recomputes `coming_shoot_date`.
>    e. Return `{ reset: true }`.
>
> **RULES**
>
> - Freelancer isolation is a query predicate, never a post-fetch filter (ADR-011).
> - Events + notifications emit strictly **after COMMIT**; a socket/notify failure must not roll back a slot write.
> - No `version` anywhere; no `optimisticUpdate`.
> - **Do not write `content_pipelines`** — Sprint 6 owns the recompute. Add a comment: `// coming_shoot_date is recomputed by the Sprint 6 listener on shoot:confirmed / shoot:reset (derived, guarded by coming_shoot_source).`
> - **Verify before moving on.** Build the service; STEP 5 writes the suite — smoke `update→Confirmed` (event spy) + `reset` (confirm gate) now.
>
> Start with `getGrid` (with the freelancer predicate) and `update` (with the Confirm emit + notification). Show me those, then `reset`.

**Verify:**

```bash
pnpm --filter @skaly/api test services/ShootPlannerService   # smoke
pnpm typecheck
```

---

## SPRINT 5 — STEP 3: Mid-month client backfill + slot-count adjustment

**Goal:** A client added mid-period gets slots for the current period (via the shared generator), and an admin can change a client's slot count with safe reconciliation.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 5, STEP 3. Slot lifecycle works. Now mid-month backfill + slot-count adjust. Read `docs/04-APPFLOW.md` §6 (backfill), `docs/06-IMPLEMENTATION-PLAN.md` §8, and the Sprint 3 `apps/api/src/services/period-rows.ts`.
>
> **WHAT TO BUILD**
>
> 1. **Factor `generateShootSlotsForClient(clientId, period, trx)`** out of the Sprint 3 `generatePeriodRows` (if it isn't already a discrete function): inserts `shoot_schedules` rows `slot_index` 1..`client.shoot_slots_per_month`, `slot_status='Unset'`, `pieces_expected = client.pieces_per_visit`, `ON CONFLICT (period, client_id, slot_index) DO NOTHING`. `generatePeriodRows` calls it in a loop; the mid-month backfill calls it for one client. (Same pattern as Sprint 3's `generateAttendanceRowsForStaff`.)
>
> 2. **Mid-month backfill hook:** when a client is created or reactivated (the Sprint 1 `POST /v1/clients` / reactivate flow), if the client is active + non-internal, call `generateShootSlotsForClient(clientId, getCurrentPeriod().period, trx)` inside the same transaction as the client insert. Expose `ShootPlannerService.backfillClientSlots(clientId, period, trx)` wrapping it. (The analogous pipeline/calendar backfills land in Sprints 6/7 — leave `// TODO(Sprint 6/7): backfill pipeline + calendar rows for mid-month client` where the client-create flow calls this.)
>
> 3. **Slot-count adjust** — `ShootPlannerService.adjustSlotCount(clientId, newCount, currentUser, db)` (**admin only**), one transaction:
>    - Validate `newCount` in `[1, 20]`. `UPDATE clients SET shoot_slots_per_month = newCount` (affects **future** periods via rollover).
>    - **Reconcile the CURRENT period's slots:** load the client's current-period slots.
>      - If `newCount > existing max slot_index` → `generateShootSlotsForClient` fills the gap (adds `Unset` slots up to `newCount`).
>      - If `newCount < existing max slot_index` → delete only the **trailing `Unset`** slots with `slot_index > newCount`. If any slot with `slot_index > newCount` is **not `Unset`** → reject `400 VALIDATION_ERROR` ("Reset or complete slot {index} before reducing the count").
>    - Past periods are historical — never touched.
>    - `AuditService.log(entity:'clients', action:'UPDATE', before:{shoot_slots_per_month}, after)`.
>    - Note: the canonical design **requires** `shoot_slots_per_month` at client creation (`CLIENT_SHOOT_SLOTS_REQUIRED`), so this is an *adjustment*, not a placeholder-fill — there is no "default 4" gap.
>
> **RULES**
>
> - The generator is idempotent (`ON CONFLICT DO NOTHING`); backfill can be safely re-run.
> - Reducing slot count never destroys a scheduled/confirmed/completed slot.
> - **Verify before moving on.** STEP 5 tests backfill counts; smoke `adjustSlotCount` increase + a blocked decrease now.
>
> Show me `generateShootSlotsForClient` (or the extraction diff) and `adjustSlotCount`.

**Verify:**

```bash
pnpm --filter @skaly/api test services/period-rows   # backfill still green
pnpm typecheck
```

---

## SPRINT 5 — STEP 4: Routes + Zod schemas + registration

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 5, STEP 4. Services in. Now routes. Read `docs/07-API-CONTRACT.md` §8 and `docs/08-AUTH-MATRIX.md` §4.
>
> **WHAT TO BUILD**
>
> 1. **Zod schemas `packages/shared/src/schemas/shoot-planner.ts`:** `ShootQuerySchema` (`period` required), `SlotUpdateSchema` (`{ slotStatus?: enum['Unset','Scheduled','Confirmed','Completed'], slotDate?: YYYY-MM-DD, piecesExpected?: int().min(1), freelancerId?: uuid.nullable() }` — no `version`; `.refine` ≥1 field), `SlotResetSchema` (`{ confirm: literal(true) }` — anything else fails validation → but ALSO handle a `false`/absent value in the service as `SHOOT_RESET_CONFIRMATION_REQUIRED` for the exact contract code), `SlotCountSchema` (`{ slotsPerMonth: int().min(1).max(20) }`).
>
> 2. **Routes `apps/api/src/routes/shoot-planner/`** (register after tasks, per TRD §5.1):
>    - `GET /v1/shoot-planner?period=` — `requireRole('admin','manager','team_member','freelancer')` (freelancer allowed — the **service** applies the isolation predicate). → `getGrid`.
>    - `PATCH /v1/shoot-planner/:id` — `requireRole('admin','manager')` (**team_member + freelancer → 403**); body `SlotUpdateSchema`; → `update`.
>    - `POST /v1/shoot-planner/:id/reset` — `requireRole('admin','manager')`; body must be `{ confirm: true }` → else `400 SHOOT_RESET_CONFIRMATION_REQUIRED`; → `reset`.
>    - `PATCH /v1/clients/:id/shoot-slots` — `requireRole('admin')`; body `SlotCountSchema`; → `adjustSlotCount`. (Or fold into `PATCH /v1/clients/:id` if that route exists — keep it admin-only and reconciling.)
>
> 3. Confirm rate-limit headers present (M-06).
>
> **RULES**
>
> - `GET` is open to all four roles at the route; **isolation is the service's job** (ADR-011), so the route doesn't filter — it must not accidentally block freelancers.
> - `PATCH`/`reset` are admin/manager only at the route (layer 2) AND the service asserts (layer 3).
> - Envelopes per API-Contract §1.1.
>
> Show me the schemas, the routes, then confirm Swagger lists them.

**Verify:**

```bash
pnpm --filter @skaly/api dev   # /docs lists /v1/shoot-planner* + /v1/clients/:id/shoot-slots
pnpm typecheck
```

---

## SPRINT 5 — STEP 5: Backend test round-out + full suite

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 5, STEP 5. Services + routes exist. Now the full backend suite. Read `docs/12-TESTING-STRATEGY.md` §5.3 (freelancer isolation / M-07) + §4.2 (shoot/trigger) + the "no `week_number`" test. Real local Postgres, `NODE_ENV=test`.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/test/services/ShootPlannerService.test.ts`:**
>    - **Freelancer isolation (M-07 / ADR-011) — headline test (Testing-Strategy §5.3):** freelancer1 + freelancer2, slot1 (f1), slot2 (f2), slot3 (unassigned). GET as freelancer1 → contains slot1, **not** slot2, **not** slot3. A freelancer GET-ing slot2 by id → **404**. A freelancer PATCH/reset → **403** (route). Freelancer GET attendance → 403 (regression).
>    - **Trigger 1 emit — spy (NOT pipeline assertion):** `update` a Scheduled slot to `Confirmed` with a `slotDate` → assert `EventBus.emit` was called once with `('shoot:confirmed', { clientId, period, slotDate })`. **Do not assert `coming_shoot_date`** (no listener until Sprint 6). Rescheduling an already-Confirmed slot's date → `shoot:confirmed` re-emitted with the new date.
>    - **`shoot_confirmed` notification:** confirming a slot with a `freelancer_id` set writes one `shoot_confirmed` notification to that freelancer; confirming a slot with no freelancer writes none.
>    - **Reset:** `reset` without `{ confirm: true }` → `400 SHOOT_RESET_CONFIRMATION_REQUIRED`; with it → slot back to `Unset`, `slot_date`/`freelancer_id` cleared, `pieces_expected` = client `pieces_per_visit`, and `EventBus.emit('shoot:reset', { clientId, period })` fired.
>    - **Transition validation:** an illegal jump (e.g. `Unset→Confirmed`) → 400; `Scheduled`/`Confirmed` without a `slot_date` → 400.
>    - **Last-write-wins (no version):** two sequential updates both succeed; no `STALE_DATA` is ever thrown (regression-guards the no-version decision).
>    - **Period lock:** update/reset on a locked period → 423.
>
> 2. **`apps/api/test/services/period-rows.test.ts` additions:** `generateShootSlotsForClient` produces exactly `shoot_slots_per_month` `Unset` rows with `pieces_expected = pieces_per_visit`; idempotent re-run adds nothing. Mid-month `backfillClientSlots` for a new client generates the right count for the current period. `adjustSlotCount` increase adds `Unset` slots; decrease removes only trailing `Unset`; decrease that would drop a `Scheduled` slot → 400.
>    - **No `week_number` (regression):** assert generated `shoot_schedules` rows carry no `week_number` key (Testing-Strategy).
>
> 3. **`apps/api/test/routes/shoot-planner.test.ts` (Fastify `inject`):** team_member GET → 200; team_member PATCH → 403; freelancer GET → 200 (own rows only); freelancer PATCH → 403; reset without confirm → 400; rate-limit headers present (M-06).
>
> 4. **H-03 confirmation (no rebuild):** run the Sprint 4 `task_assigned` N-for-N test — assert still green.
>
> 5. Run the **whole** API suite + typecheck + lint.
>
> **RULES:** independent, re-runnable; spy on `EventBus.emit` (don't assert downstream effects that belong to Sprint 6).
>
> Show me the freelancer-isolation test and the Trigger-1 spy test first, then run the suite.

**Verify:**

```bash
pnpm --filter @skaly/api test        # full API suite green
pnpm typecheck && pnpm lint
git add -A && git commit -m "Sprint 5 backend: ShootPlannerService + backfill + slot-count + tests (M-07, Trigger 1 emit, shoot:reset)"
```

---

## SPRINT 5 — STEP 6: Frontend — shoot planner grid structure

**Goal:** The grid per UI/UX §9 — sticky client column, dynamic slot columns, N/A cells, week grouping at render, slot cells — before popover wiring.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 5, STEP 6. Backend done. Now the grid — rendering only. Read `docs/03-UIUX.md` §9 (Shoot Planner), §4.2 (cells), §4.3 (status chips), and `docs/07-API-CONTRACT.md` §8 (GET payload). Reuse the Sprint 3/4 chassis (`useMonthContext`, `lib/api.ts`, the `(portal)` layout, TanStack Query).
>
> **WHAT TO BUILD** — `apps/web/app/(portal)/shoot-planner/page.tsx` + `apps/web/components/modules/shoot-planner/` (no `src/`):
>
> 1. Data: `useQuery({ queryKey: ['shoot-planner', period], queryFn: () => api.get('/shoot-planner', { period }) })`.
> 2. **TanStack Table v8, client-rows × slot-columns:** **Client column sticky left, 200px** (name + small role/type hint). **Slot columns = dynamic count = `max(clients.shoot_slots_per_month)`** across the returned clients. Each cell maps to that client's `shoot_schedules` row for `slot_index = columnIndex+1` (keyed `clientId+slotIndex`).
> 3. **N/A cells** (a client whose `shoot_slots_per_month` < the grid's column count — no row for that `slot_index`): `opacity: 0.15`, `pointer-events: none`, dashed border, "—" text (UI/UX §4.2 N/A).
> 4. **Slot cell (filled):** status chip (§4.3: `Scheduled` blue · `Confirmed` gold · `Completed` green · `Unset` = no chip, dashed "Click to schedule" cell) + `slot_date` (DM Mono) + a pieces badge (`×N`). Assigned-freelancer avatar/name when set.
> 5. **Week grouping computed at render** from `slot_date` via date-fns — show a **week-of-month** label ("Week 1 · Jul 1–5") as a visual band/subheader over slots dated that week. **No stored `week_number`** — derive it (map the ISO week to a month-relative index for the label). Unset slots (no date) are ungrouped.
> 6. **Freelancer view:** when `me.role === 'freelancer'`, the grid shows only their rows (the API already filtered) and cells are **read-only** — no popover, no reset (next step wires edit only for admin/manager).
> 7. **Locked period:** cells render read-only; the Sprint 3 locked banner shows; no popover opens.
> 8. Empty state: "No shoots scheduled yet" (Big Shoulders Display). Accessibility: `role="grid"`, focus ring `var(--accent-gold)`, 44×44 targets.
>
> **RULES:** rendering only — no popover/mutations/highlight yet. All colours/fonts via globals.css variables; dates/pieces in DM Mono.
>
> Build it; I'll eyeball the sticky client column, dynamic slot columns, N/A cells, week bands, and chips before wiring interactions.

**Verify (manual):** grid renders from seeded shoot slots; column count = max slot count; a lower-slot client shows N/A cells; confirmed slots gold, scheduled blue; week bands read "Week 1/2…". Log in as a seeded-invited freelancer (assign them a slot first) → only their row, read-only.

---

## SPRINT 5 — STEP 7: Frontend — slot popover, reset, freelancer view, highlight, errors

**Goal:** The full APPFLOW §6 lifecycle in the UI — schedule → confirm → complete, reset with confirmation, freelancer assignment — with the gold highlight and error routing.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 5, STEP 7. Grid renders. Now the slot popover + lifecycle. Read `docs/04-APPFLOW.md` §6 (each transition), `docs/03-UIUX.md` §4.4 (gold highlight), §4.5 (popover), §9, and `docs/09-ERROR-HANDLING.md` §5.1. Reuse `handleMutationError`, `useColumnHighlight`, the api client.
>
> **WHAT TO BUILD** (admin/manager only — the API is the gate):
>
> 1. **Slot popover** (opens below the clicked cell, ~220px, UI/UX §9/§4.5; Esc/outside-click closes): contents depend on state —
>    - **Unset → Schedule:** date picker (constrained to the viewing period), pieces stepper (default the client's `pieces_per_visit`), freelancer dropdown (`GET /v1/staff` filtered to `role='freelancer'`, optional), **[Schedule]** → `PATCH { slotStatus:'Scheduled', slotDate, piecesExpected, freelancerId }`.
>    - **Scheduled → Confirm:** date pre-filled + editable, freelancer editable, **[Confirm]** → `PATCH { slotStatus:'Confirmed', ... }`. On success → toast **"Shoot confirmed. Content Dropper updated."** (frontend toast; the pipeline update itself is Sprint 6 — the copy is spec-accurate for the end state).
>    - **Confirmed → Complete:** **[Mark as Completed]** → `PATCH { slotStatus:'Completed' }`.
> 2. **Optimistic updates:** each `PATCH` writes the new slot state into the `['shoot-planner', period]` cache; `onSuccess` replace the row with the returned slot (**no `version`** — last-write-wins); `onError` revert + `handleMutationError`.
> 3. **Reset:** a `⋯` cell menu → **[Reset slot]** → confirmation dialog ("Reset this slot? The date, pieces, and freelancer will be cleared.") → `POST /v1/shoot-planner/:id/reset { confirm: true }` → invalidate `['shoot-planner', period]`. Map a `SHOOT_RESET_CONFIRMATION_REQUIRED` (shouldn't happen from the UI, which always sends `confirm:true`) to a toast.
> 4. **Gold column highlight (UI/UX §4.4):** apply `useColumnHighlight` keyed by `slot_index` (the column) to the popover's interactive controls, same five state rules incl. the failure path. Class-based (the grid isn't virtualised).
> 5. **Freelancer read-only:** freelancers get no popover, no `⋯` menu, no reset — cells are display-only (belt-and-braces to the API 403).
> 6. **`handleMutationError`:** reuse `PERIOD_LOCKED` / `PERMISSION_DENIED` / `VALIDATION_ERROR` (invalid transition / missing date) / default. **No `STALE_DATA` branch** (shoot slots aren't versioned).
> 7. **Real-time (ADR-010):** **no** socket subscription. Own-mutation refresh via cache replacement + invalidation. Add `// TODO(Sprint 10): subscribe to shoot slot updates on /ws/notify → invalidateQueries(['shoot-planner', period])`.
> 8. **Frontend tests:** schedule mutation sends no `version` and replaces the row; confirm shows the toast; an invalid transition surfaces the error; reset dialog requires explicit confirm; highlight failure-path; freelancer view has no edit affordances.
>
> **RULES:** slot PATCH never sends `version`; no stale-conflict UI. Popover date constrained to the period. Build schedule → confirm first; show me that before complete/reset.

**Verify (manual):** schedule an Unset slot (date + pieces + freelancer) → Scheduled chip; confirm it → gold chip + "Content Dropper updated" toast + a `shoot_confirmed` notification row for the freelancer (`SELECT type,title FROM notifications ORDER BY created_at DESC LIMIT 3;`). Reset it → back to Unset, fields cleared. Try an illegal jump via API → 400. Freelancer session → read-only.

```bash
pnpm --filter @skaly/web test
```

---

## SPRINT 5 — STEP 8: Playwright smoke — lifecycle + freelancer isolation

### 8.1 — Test logins (manual)

Reuse the Sprint 3/4 `.env.test` admin. Add a **freelancer** login (invite one via the Sprint 1 flow) and assign them a shoot slot (via the UI/API in a `beforeAll`) so the isolation + read-only paths are exercisable.

### 8.2 — Prompt

> **WHERE WE ARE**
>
> Sprint 5, STEP 8. Everything works by hand. Now Playwright. Read `docs/12-TESTING-STRATEGY.md` §6. Reuse the Sprint 3/4 `loginAs` helper + `playwright.config.ts`.
>
> **WHAT TO BUILD** — `tests/e2e/shoot-planner.spec.ts` (add `data-testid`s as needed):
> 1. **Lifecycle (admin):** `/shoot-planner` → click an Unset cell → schedule (date + pieces + freelancer) → chip = Scheduled; confirm → chip = Confirmed + "Content Dropper updated" toast; `⋯` → reset → chip back to Unset (fields cleared).
> 2. **Freelancer isolation (freelancer):** log in as the freelancer → the grid shows their assigned row and **not** another freelancer's row; cells have no edit popover (assert click does nothing / no `⋯`); a direct `page.request.patch('/v1/shoot-planner/{someSlotId}', ...)` with the freelancer token → **403**; a direct GET of a non-owned slot → **404**.
> 3. **Reset gate (admin, API):** `page.request.post('/v1/shoot-planner/{id}/reset', { data: {} })` (no confirm) → **400** `SHOOT_RESET_CONFIRMATION_REQUIRED`.
> 4. Run headed once, then headless (chromium + webkit).
>
> **RULES:** independent, re-runnable; clean up created state.
>
> Show me the spec, then run `pnpm exec playwright test tests/e2e/shoot-planner.spec.ts --headed`.

**Verify:**

```bash
pnpm exec playwright test tests/e2e/shoot-planner.spec.ts    # green, chromium + webkit
```

---

## SPRINT 5 — STEP 9: End-to-end smoke + commit + close-out (manual)

### 9.1 — Full manual walk-through

```bash
docker compose up -d && pnpm dev
```

1. **Admin:** grid renders (dynamic columns, N/A cells, week bands). Schedule → confirm → complete a slot; confirm fires the toast; `SELECT * FROM notifications WHERE type='shoot_confirmed' ORDER BY created_at DESC LIMIT 3;` shows a row for the assigned freelancer.
2. **Trigger 1 emit (Sprint-5 scope):** confirming a slot fires `shoot:confirmed` (check the API logs / a temporary log in the emit). `content_pipelines.coming_shoot_date` is **still NULL** — correct, the listener is Sprint 6.
3. **Reset:** reset a confirmed slot → Unset, fields cleared; `shoot:reset` fires.
4. **Mid-month backfill:** create a new active non-internal client (Sprint 1 flow) → `SELECT count(*) FROM shoot_schedules WHERE client_id='<new>' AND period='<current>';` = its `shoot_slots_per_month`.
5. **Slot-count adjust:** `PATCH /v1/clients/:id/shoot-slots { slotsPerMonth: N+2 }` (admin) → 2 new Unset slots appear for the current period; try reducing below a Scheduled slot → 400.
6. **Freelancer:** only their rows, read-only; `GET /v1/shoot-planner` returns only their slots; PATCH → 403; a non-owned slot GET → 404. `/shoot-planner` in the sidebar present for freelancer; attendance/tasks absent.
7. **Locked month:** lock the prior month → grid read-only, PATCH/reset → 423.
8. **Audit:** `SELECT staff_id, changed_by_source, table_name, action FROM audit_log WHERE table_name IN ('shoot_schedules','clients') ORDER BY created_at DESC LIMIT 10;` — UPDATEs present, `staff_id` never NULL.

### 9.2 — Close-out checklist

Do not start Sprint 6 until **every** box is checked:

```
PRE-SPRINT DECISIONS EXECUTED
  [ ] ADR-011 committed
  [ ] EventBus extended with shoot:reset (typed); shoot:confirmed unchanged
  [ ] shoot_schedules confirmed: no version, no week_number; content_pipelines has coming_shoot_source + version

BACKEND — ShootPlannerService
  [ ] getGrid freelancer isolation: WHERE freelancer_id = self BEFORE query; own visible, others' + unassigned blocked (M-07, TESTED)
  [ ] non-owned slot GET by freelancer → 404; freelancer PATCH/reset → 403
  [ ] update: last-write-wins, NO version, NO optimisticUpdate, NO STALE_DATA
  [ ] transition validation: illegal jumps → 400; Scheduled/Confirmed require slot_date
  [ ] Confirm emits shoot:confirmed {clientId, period, slotDate} AFTER commit (spy TESTED); re-emits on reschedule-of-confirmed
  [ ] shoot_confirmed notification row written to assigned freelancer on Confirm (durable, ADR-010)
  [ ] reset: confirm:true mandatory (400 SHOOT_RESET_CONFIRMATION_REQUIRED otherwise); → Unset, fields cleared, pieces = pieces_per_visit; emits shoot:reset
  [ ] content_pipelines NOT written in Sprint 5 (Sprint 6 owns the recompute) — comment present

BACKEND — Backfill + slot count
  [ ] generateShootSlotsForClient factored + shared with generatePeriodRows; idempotent
  [ ] mid-month client activation backfills current-period slots (TESTED)
  [ ] adjustSlotCount: increase adds Unset; decrease removes only trailing Unset; blocks dropping a non-Unset slot (TESTED)
  [ ] no "default 4" placeholder — shoot_slots_per_month required at creation (canonical)

ROUTES
  [ ] GET open to all 4 roles (service isolates); PATCH/reset admin/manager only; slot-count admin only
  [ ] Swagger lists all shoot-planner routes; rate-limit headers (M-06)

FRONTEND
  [ ] Grid: sticky 200px client col, dynamic slot columns = max slots, N/A cells (0.15 + inert + "—")
  [ ] Slot cells: chips (§4.3), slot_date DM Mono, pieces badge, freelancer avatar
  [ ] Week grouping computed at render from slot_date (no stored week_number)
  [ ] Popover lifecycle: schedule / confirm (+ toast) / complete; date constrained to period; freelancer dropdown
  [ ] Optimistic updates: no version sent; row replaced on success
  [ ] Reset: ⋯ menu + confirm dialog → POST reset {confirm:true}
  [ ] Gold highlight on slot columns incl. failure path
  [ ] Freelancer view: own rows only, read-only (no popover/⋯/reset)
  [ ] handleMutationError: invalid-transition + locked + permission; NO STALE_DATA branch
  [ ] No frontend socket client (ADR-010); // TODO(Sprint 10) marker present

TESTS
  [ ] ShootPlannerService + period-rows + route suites green
  [ ] Frontend hook/component tests green
  [ ] Playwright: lifecycle + freelancer isolation (UI inert AND API 403/404) + reset gate — chromium & webkit
  [ ] H-03 (Sprint 4) still green; no week_number regression green
  [ ] pnpm typecheck + pnpm lint clean
```

### 9.3 — Final commit

```bash
git add -A
git commit -m "Sprint 5: Shoot Planner (Trigger 1 emit, freelancer isolation M-07, shoot:reset, slot-count adjust) — ADR-011"
git push -u origin sprint-5-shoot-planner
```

Open the PR to `main`; CI must be fully green before merge. Merge, then `git checkout main && git pull`.

### 9.4 — Move to Sprint 6

Open `MASTER-BUILD-GUIDE-V2-FINAL.md` → PART 9 → **SPRINT 6 — CONTENT DROPPER + TRIGGER 1**, or the forthcoming `SPRINT-6-DETAILED.md`.

Sprint 6 is where Sprint 5's emits **come alive**: it builds `ContentDropperService` on the `content_pipelines` table (stage sequence Shoot → Edit → Review → Posted, no skipping), **wires the Trigger 1 listener** (`shoot:confirmed` **and** `shoot:reset` → recompute `coming_shoot_date` — derived, guarded by `coming_shoot_source`, bumping `content_pipelines.version`), and **produces Trigger 2** (`pipeline:posted` on the Posted stage → consumed by the Sprint 7 calendar). This is where the Testing-Strategy §4.2 "coming_shoot_date is set after confirm" test finally passes.

If any close-out box is unchecked, **stop**. Sprint 6 depends on Sprint 5's events firing correctly.

---

## DECISIONS TO MAKE BEFORE SPRINT 6

- **Trigger 1 listener = recompute, not naive push (lock it):** the Sprint 6 `shoot:confirmed` / `shoot:reset` listener must **recompute** `coming_shoot_date = MIN(slot_date WHERE client+period, slot_status='Confirmed', slot_date ≥ CURRENT_DATE)` — set `NULL` if none — and write **only if `coming_shoot_source IN (NULL,'trigger')`** (never clobber a `'manual'` override, mirroring the calendar M-04 guard), setting `coming_shoot_source='trigger'`. The write **bumps `content_pipelines.version`** (legitimate concurrent write). Confirm this before building so Sprint 6 doesn't naively `SET coming_shoot_date = eventPayload.slotDate` (which breaks on reset and multi-slot clients).
- **Content Dropper is `content_pipelines` + the stage model:** `content_pipelines` **is versioned** (unlike shoot slots) — stage PATCHes use `optimisticUpdate` (C-02). The stage cells are the timestamp columns (`raw_received_at`, `finals_ready_at`, `posted_at`); "stage sequence" means you can't set a later timestamp before an earlier one. Decide the exact stage→column mapping (Shoot=`last_shoot_date`? Edit=`raw_received_at`? Review=`finals_ready_at`? Posted=`posted_at`?) against APPFLOW §7 **before** building `updateStage`.
- **Trigger 2 date is server-side `CURRENT_DATE` IST (audit H-02):** `pipeline:posted` carries a server-computed IST date; **do not add a `posted_date` field** — `posted_at` timestamp is the source. Lock it so Sprint 6 doesn't invent a schema column.
- **Still deferred, on schedule:** frontend socket client + bell-notification **display** (Sprint 10 — durable rows like `shoot_confirmed`/`task_assigned` continue to be written as records change), `resolvePermission` (Sprint 8), MFA enrollment (ADR-002 → Sprint 8), comment system (later sprint), attachment orphan cron (Sprint 12).

---

## TROUBLESHOOTING — SPRINT 5 SPECIFIC

### A freelancer sees other freelancers' or unassigned slots
Isolation was applied as a post-fetch filter, or the predicate is `freelancer_id = self OR freelancer_id IS NULL`. It must be exactly `.where('freelancer_id','=',currentUser.staffId)` in the query builder (ADR-011). Unassigned slots are invisible to freelancers.

### `coming_shoot_date` is still NULL after confirming a slot in Sprint 5
Correct — the listener is Sprint 6. Sprint 5 only emits `shoot:confirmed`. Do **not** wire the listener or write `content_pipelines` here (module boundary). The pipeline assertion is a Sprint 6 test.

### The Trigger-1 test fails asserting `coming_shoot_date`
You wrote the Sprint 6 test in Sprint 5. Sprint 5's test spies on `EventBus.emit` (event fires); the `coming_shoot_date` assertion belongs to Sprint 6's real-listener test (Testing-Strategy §4.2).

### `PATCH` fails with "column version does not exist"
You reused the attendance/calendar `optimisticUpdate` path. `shoot_schedules` has no `version` (schema). Use a plain guarded `UPDATE`. Drop `version` from the slot schema and the frontend PATCH body.

### Reset returns 200 even without `confirm`
The service isn't checking `confirm === true` before acting. Return `400 SHOOT_RESET_CONFIRMATION_REQUIRED` when it's absent/false (the Zod `literal(true)` handles the schema case, but keep the explicit service check so the exact contract code is returned).

### `CONFIRMATION_REQUIRED` shows up
That's the Master Guide's wrong code. The canonical code is `SHOOT_RESET_CONFIRMATION_REQUIRED` (Error-Handling §2 / API-Contract §8).

### A `freelancer_assigned` notification appears
Wrong type. The canonical type is `shoot_confirmed`, fired on **Confirm** (not on assignment), to the assigned freelancer (schema enum + APPFLOW §6).

### Week grouping shows wrong numbers ("Week 27")
You used raw `getISOWeek()` (week-of-year). The label is **week-of-month** — map the slot's date to a month-relative index (e.g. based on the first Monday of the month) for "Week 1/2/3". And confirm you never persisted a `week_number` column (there isn't one).

### Slot-count decrease wiped a scheduled shoot
`adjustSlotCount` deleted slots beyond the new count unconditionally. It must delete only **trailing `Unset`** slots and reject (400) if any slot beyond the new count is `Scheduled`/`Confirmed`/`Completed`.

### N/A cells are clickable / open a popover
The N/A cell wrapper needs `pointer-events: none` and no click handler; a client with fewer slots than the grid max has no `shoot_schedules` row for that `slot_index`, so there's nothing to edit.

### Mid-month client has no shoot slots
The client-create flow isn't calling `backfillClientSlots` (or the client is `is_internal=true`). Wire the backfill into the Sprint 1 client-create/reactivate transaction for active non-internal clients.

---

## END OF SPRINT 5 DETAILED GUIDE

*Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1/2/3/4-DETAILED.md`. Source-of-truth precedence when documents differ: the numbered spec docs (`01`–`14`) + the schema win, then this guide's reconciliations and the ADRs it executes (006–011), then the Master Build Guide's shorthand. Sprint 6 (Content Dropper) wires the Trigger 1 listener that consumes this sprint's `shoot:confirmed` / `shoot:reset` emits and produces Trigger 2.*
