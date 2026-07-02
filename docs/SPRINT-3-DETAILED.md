# SPRINT 3 — STAFF ATTENDANCE: DETAILED PROMPT-BY-PROMPT GUIDE

## Scaly Business Portal • Sprint 3 of 13

**Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9**
**Same Goal / Prompt / Verify framework as Sprint 1 and Sprint 2**
**Tooling interfaces verified as of January 2026** — Fastify 5, Kysely, `socket.io` v4, TanStack Table v8, TanStack Query v5, Zustand 5, Framer Motion 11, `date-fns` + `date-fns-tz`, shadcn/ui.

---

## WHAT YOU'RE BUILDING IN SPRINT 3

This is the **first full operational module**. Everything you built in Sprint 2 (BaseService, AuditService, NotificationService, Socket.io, the read endpoints) now gets used for real. By the end of this week the Staff Attendance module in `docs/04-APPFLOW.md` §4 works end-to-end:

- Admin and Manager see the **full attendance grid** for the period; every cell editable.
- A **Team Member** sees the same grid but can edit **only their own column** — enforced by CSS on the frontend and by a hard 403 on the backend (the frontend is convenience, the backend is the boundary).
- A **Freelancer** has no attendance access at all (403).
- **Sundays** render greyed and non-interactive; **holidays** render gold-tinted and non-interactive; **working days** are interactive (present toggle + work-log).
- Adding a holiday flips that date's working rows to holiday and **broadcasts** the change; removing a holiday **reverts** those rows in a single transaction (audit H-01).
- The **work-log autosaves** 800ms after the last keystroke; the **present toggle** is instant/optimistic.
- A **locked period** renders every cell as static text with a banner; the backend rejects any write with 423.
- The **gold column highlight** (Amendment 2) illuminates the focused column.
- Mid-month new staff get their attendance **backfilled** (Sprint 1's approval flow calls this — you finish it here).

**Estimated time:** 5 working days (per `06-IMPLEMENTATION-PLAN.md` §6). This is a "get the module pattern right" sprint — Sprints 4–7 (Tasks, Shoot Planner, Content Dropper, Content Calendar) all copy the shape you establish here. Do it well and the next four sprints are faster.

**Prerequisites from Sprint 2** (all must be true — if any is not, stop and fix it before you start):

- `pnpm typecheck` green across all packages; `pnpm --filter @skaly/api test` green; `pnpm lint` clean.
- `BaseService` exists: `assertPeriodNotLocked`, `optimisticUpdate` (C-02, returns full row + increments `version`), `softDelete`/`softDeletable` (H-02), `getCurrentPeriod` (IST month with latest-period fallback).
- `AuditService.log` is real and writes through the confirmed lockdown path; the Sprint 1 call sites use the `INSERT/UPDATE/DELETE/...` action enum.
- `NotificationService.create` is real (DB write + `notify:new` on `/ws/notify`).
- Socket.io boots with `/ws/chat`, `/ws/presence`, `/ws/notify`; handshake reuses `verifySupabaseToken`; connects join `user:{staffId}` / `role:{role}` / `org:all`.
- `db.types.ts` reflects the live schema (incl. `mfa_recovery_codes`).
- Git on `main`, Sprint 2 close-out pushed, CI green.

---

## THE FOUR "DECISIONS BEFORE SPRINT 3" — RESOLVED, AND WHERE THEY LAND

Your rulings from the end of Sprint 2 are locked. Each maps to a concrete move in this guide:

| Decision | Ruling | Where in this guide |
|---|---|---|
| **1. `audit_log` write path** | Keep whatever Sprint 0 built (almost certainly Style B — SECURITY DEFINER function). Confirm it, match `AuditService.log` to it, record **ADR-003**. | STEP 1.3 (confirm) + STEP 1.4 (ADR-003) |
| **2. `ROLE_DEFAULTS` + resolver** | Build the static `ROLE_DEFAULTS` map **now**; defer the behavioral `resolvePermission` resolver to Sprint 8. | STEP 2 |
| **3. `getCurrentPeriod` / dev data** | Expand the dev seed to insert current + prior IST months; factor a reusable `generatePeriodRows(period, trx)` and call it from the seed so every module has data; keep `getCurrentPeriod` a pure read. | STEP 3 |
| **4. Bot streaming namespace** | Keep bot streaming on `/ws/notify`; do not add a fourth namespace. Nothing to build — just don't reopen it in Sprint 8. | Recorded in STEP 1.5; no code |

---

## READ FIRST (Open in Antigravity Split View)

Pin these before you begin. In Antigravity you can `@`-reference them in chat with `@docs/04-APPFLOW.md`.

| Doc | Sections | Why |
|---|---|---|
| `docs/04-APPFLOW.md` | §4 (Staff Attendance flow) | Every interaction Sprint 3 must produce |
| `docs/07-API-CONTRACT.md` | §5 (attendance — GET grid shape + PATCH), §6 (holidays + WebSocket events) | Exact request/response + socket event names |
| `docs/03-UIUX.md` | §2.1 (color tokens), §4.2 (grid cell types), §4.4 (gold column highlight), §7 (Staff Attendance layout) | The grid's exact visual states |
| `docs/05-BACKEND-SCHEMA.md` | `attendance_logs`, `holidays` tables, §11 (DB role grants) | Column names, `day_type` enum, and which tables allow DELETE |
| `docs/08-AUTH-MATRIX.md` | §3–§4 (attendance/holiday access), §7 (attendance column ownership) | Who reads/writes what |
| `docs/06-IMPLEMENTATION-PLAN.md` | §6 | Sprint 3 checklist |
| `docs/09-ERROR-HANDLING.md` | §2 (PERIOD_LOCKED, STALE_DATA), §5.1 (409 inline handler) | Error + FE routing |
| `docs/14-PRE-BUILD-AUDIT.md` | H-01 | The holiday-cascade finding this sprint resolves |

---

## CONSISTENCY RECONCILIATIONS — LOCK THESE BEFORE YOU PROMPT

The Master Build Guide PART 9 Sprint 3 prompt is 90% correct but uses a few shorthands that **drift from the canonical schema**. The numbered specs win. These are baked into the prompts below — know *why*:

1. **The attendance state column is `day_type`, not `status`.** Values: `('working' | 'sunday' | 'holiday')`. (The Master Guide says `status='holiday'` — wrong column name.) Source: `05-BACKEND-SCHEMA.md` `attendance_logs`.
2. **Holidays are `admin` + `manager`, not admin-only.** (The Master Guide says "admin only.") Source: `08-AUTH-MATRIX.md` §4 (GET/POST/DELETE holidays: admin ✅, manager ✅) + PRD FR-ATT-09.
3. **Holiday removal is a SOFT remove (`active=false`, `removed_at`, `removed_by`), not a hard `DELETE`.** The app role has **no DELETE grant on `holidays`** (`05-BACKEND-SCHEMA.md` §11 lists DELETE only on tasks/shoot/pipeline/calendar/messages/etc.). `DELETE /v1/holidays/:id` performs an `UPDATE` that deactivates the holiday **and** reverts the attendance rows, in one transaction (audit H-01).
4. **Holiday create only flips `working` → `holiday`; leaves `sunday` rows untouched. Removal flips `holiday` → `working`.** Sundays are never touched by holiday logic, so the revert is clean.
5. **Use the real color tokens from `globals.css`** (UIUX §2.1), not the `hsl(var(--gold)/…)` shorthand: column-highlight bg `--accent-gold-dim` (0.12), highlight border `--accent-gold-border` (0.60), holiday-row tint `--accent-gold-06` (0.06). Sunday cell: `--bg-base` bg + `--text-disabled` text (UIUX §4.2).
6. **`recalculatePresentDays` is a read, not a stored counter.** There is no present-days column in the schema. The footer "total present per column" is **computed on read** from the fetched rows (derived-not-stored — the project's discipline). Do not persist a running total.
7. **`optimisticUpdate` from Sprint 2 is the only write path for `attendance_logs`** (it has a `version` column). PATCH returns the **full updated row** (API-Contract §1.1).
8. **Freelancer → `GET /v1/attendance` returns 403** (no attendance access). PATCH `allowedRoles = [admin, manager, team_member]`; team_member own-row only.
9. **Frontend live socket subscription is deferred to Sprint 10.** This sprint the backend **emits** `attendance:holiday_added` / `attendance:holiday_removed` to `org:all` and a backend test confirms a test client receives it. The acting user's own mutations refresh their own grid via TanStack Query invalidation. Cross-user live refresh **and** the `holiday_added`/`holiday_removed` bell notifications land in Sprint 10 (full notification coverage) — don't build the frontend socket client here.
10. **`work_log` max 2000 chars**, enforced in the service layer + Zod (`05-BACKEND-SCHEMA.md` `attendance_logs` comment).

---

## AUDIT ITEMS THIS SPRINT MUST HANDLE

| ID | What | Where it lives |
|---|---|---|
| **H-01** | Removing a holiday reverts **all** `attendance_logs` rows for that date/period from `day_type='holiday'` back to `'working'`, **in the same transaction** as the holiday deactivation. If only the holiday row changes, the grid shows a phantom gold-tinted non-interactive day. | STEP 5 (HolidayService.remove) |
| **Column ownership backstop** | A Team Member PATCHing another staff member's attendance row gets a hard **403** at the service layer — the frontend `pointer-events:none` is UX only. | STEP 4 (AttendanceService.update) + STEP 6 (route test) |
| **M-10** (via decision #3) | Dev seed inserts current + prior IST months and generates a full period's operational rows via a reusable `generatePeriodRows`, so every module has realistic data in dev. | STEP 3 |

If you skip the test for any of these, Sprint 3 is not done. They reappear in CI when you push.

---

## STEP-BY-STEP STRUCTURE

| # | Type | What |
|---|---|---|
| 1 | Manual | Pre-flight — Sprint 2 close-out, confirm audit path (ADR-003), lock bot namespace, branch |
| 2 | Prompt | `ROLE_DEFAULTS` static map (decision #2) |
| 3 | Prompt | Dev seed expansion + `generatePeriodRows` (decision #3 / M-10) |
| 4 | Prompt | `AttendanceService` (getGrid, update, backfill) + shared day-type helper |
| 5 | Prompt | `HolidayService` (create + remove/H-01) |
| 6 | Prompt | Routes — attendance + holidays + register + route tests |
| 7 | Prompt | Frontend — attendance grid page |
| 8 | Prompt | Round-out tests (socket broadcast + Playwright smoke) + full suite |
| 9 | Manual | End-to-end smoke + commit + close-out |

---

## SPRINT 3 — STEP 1: Pre-flight (manual)

**Goal:** Confirm the Sprint 2 foundation is green, resolve decision #1 (audit path) with a written ADR, and lock decision #4 (bot namespace) so Sprint 8 can't reopen it.

### 1.1 — Confirm the apps boot and Sprint 2 is green

```bash
docker compose up -d
docker compose ps                          # postgres + redis healthy
pnpm install
pnpm --filter @skaly/api db:status         # 0 pending
pnpm typecheck                             # green
pnpm --filter @skaly/api test              # green (Sprint 2 suite incl. base services, sockets, reads)
```

### 1.2 — Confirm the socket server is up

```bash
pnpm --filter @skaly/api dev
# Look for the boot log listing namespaces: /ws/chat, /ws/presence, /ws/notify
# Ctrl-C after confirming.
```

### 1.3 — Confirm the `audit_log` write path (decision #1)

```bash
docker compose exec postgres psql -U skaly -d skaly_dev
```

```sql
-- Which app role am I? (use it in the next query if not 'skaly_app')
SELECT current_user;

-- (a) Can the app role INSERT into audit_log?
SELECT privilege_type FROM information_schema.role_table_grants
WHERE table_name = 'audit_log' AND grantee = 'skaly_app';

-- (b) Is there a SECURITY DEFINER audit-writing function?
SELECT proname FROM pg_proc WHERE proname ILIKE '%audit%' AND prosecdef = true;

\q
```

Read it:
- **INSERT present + no function → Style A.** `AuditService.log` writes via direct Kysely `insertInto('audit_log')`.
- **INSERT absent + a function present → Style B** (most likely, per your Sprint 1 note). `AuditService.log` calls that function.

**Open `apps/api/src/services/AuditService.ts` and confirm its write path already matches** what the DB allows (you built this in Sprint 2 STEP 5). If it doesn't match, that's a bug to fix now — before any Sprint 3 service calls it.

### 1.4 — Write ADR-003 (decision #1)

Create `docs/adr/ADR-003-audit-log-write-path.md` (or append to your ADR log alongside ADR-001/ADR-002):

```
ADR-003 — audit_log write path
Status: Accepted
Decision: Sprint 0 implemented Style [A / B].
  AuditService.log writes via
    [A] direct Kysely insertInto('audit_log'), OR
    [B] SELECT <exact function signature, e.g. write_audit_log(p_staff_id, p_source, p_table, p_record, p_action, p_old, p_new, p_ip)>
Rule: audit_log is written ONLY through AuditService.log. No direct writes anywhere else in the codebase.
Rationale: Both styles satisfy B-01 (history cannot be edited or deleted). Rewriting the lockdown
  migration on a deployed, tamper-proof system is churn with no security gain. Keep what Sprint 0 built.
```

### 1.5 — Lock decision #4 (bot streaming namespace) — no code

Append one line to the same ADR log or a `docs/DECISIONS.md`:

```
Bot streaming stays on /ws/notify. Sprint 8 emits `bot:message` via io.of('/ws/notify').to('user:'+staffId);
the bot UI subscribes to `bot:message` on its existing /ws/notify connection. No fourth namespace.
Revisit only if Sprint 13 load tests show bot streaming degrading notification/grid latency.
```

### 1.6 — Branch

```bash
git checkout main && git pull
git checkout -b sprint-3-attendance
```

**Verify gate:** apps boot, Sprint 2 suite green, audit path confirmed + ADR-003 written, bot namespace locked, on a fresh branch. Proceed.

---

## SPRINT 3 — STEP 2: `ROLE_DEFAULTS` static map (decision #2)

**Goal:** Transcribe the role-capability matrix into one constant map now, while the matrix is in front of you. This is pure data — the single source of truth for "what can each role do by default." The behavioral resolver (`resolvePermission`) waits for its first consumer in Sprint 8.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 3, STEP 2. Before the first module, I'm transcribing the role-defaults map (a "decision before Sprint 3"). This is the static default table only — no resolver logic.
>
> **WHAT TO BUILD**
>
> Create `packages/shared/src/constants/permissions.ts` exporting `ROLE_DEFAULTS`: a map of `permissionKey → { admin, manager, team_member, freelancer }` booleans. Read `docs/08-AUTH-MATRIX.md` §5 (bot tool matrix — all 22 tools) and §3–§4 (module access), and use the key-naming convention in §6.2:
> - `bot.tool.{name}` for each of the 22 bot tools
> - `module.{module}.read` / `module.{module}.write` for module access
> - `chat.access`, `report.generate`, `months.unlock`
>
> Encode the matrix symbols as booleans:
> - ✅ and 🔐 (own-data) → `true` — scoping to "own data" is enforced in the tool/service implementation, not in this gate.
> - ❌ → `false`
> - 🔧 (admin-configurable) → `false` (default off, override-able)
>
> Add a comment marking every 🔧 key as `// override-able via user_permissions`. Re-export `ROLE_DEFAULTS` from the package index.
>
> **RULES**
>
> - This is the static default map **only**. Do **not** build `resolvePermission` — that lands in Sprint 8 against its first real consumer (the bot), where the Redis cache-read + DB fallback + cache-bust-on-override can be verified end-to-end.
> - Transcribe faithfully — this is the source of truth for capability. Get the 🔐 and 🔧 symbols right per the rules above.
>
> Show me the full file so I can diff it against `08-AUTH-MATRIX.md` §5 line by line.

**Note for Sprint 8 (write this down):** `resolvePermission(staffId, key)` reads `perms:{staffId}` (Redis, 5-min TTL, JSON array of `{permissionKey, value}`), falls back to `ROLE_DEFAULTS[key][role]`, and the admin override endpoint **deletes** the Redis key on write (Auth-Matrix §6.3).

**Verify:**

```bash
pnpm typecheck
```

Diff the generated map against `08-AUTH-MATRIX.md` §5 yourself — every 🔧 must be `false` + commented, every 🔐 must be `true`.

---

## SPRINT 3 — STEP 3: Dev seed expansion + `generatePeriodRows` (decision #3 / M-10)

**Goal:** Give dev/staging realistic data for **every** module, and — the high-leverage move — factor the per-period row generation into a `generatePeriodRows(period, trx)` that the dev seed calls now and Sprint 12's rollover reuses later. Same function → dev data matches production shape exactly, and Sprint 12 is de-risked in advance.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 3, STEP 3. Resolving decision #3 / audit M-10. I need dev data for the attendance grid (and the later modules), and I want the period-row generation factored so the future rollover reuses it.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/src/services/period-generation.ts`** — export `generatePeriodRows(period: string, trx: Transaction<DB>): Promise<void>`. This is the row-generation core the Sprint 12 rollover will call. Read `docs/05-BACKEND-SCHEMA.md` for the exact columns. It generates, for the given `period`:
>    - **`attendance_logs`** — one row per active, non-deleted staff member × each date in the month. Compute `day_type` per date: Sunday (`getDay() === 0`) → `'sunday'`, otherwise `'working'`. (No holiday awareness here — a freshly generated month has no holidays; holidays are applied afterward via HolidayService. This matches how the rollover behaves.) `present: false`, `version: 1`. Respect the unique constraint `(period, staff_id, date)`.
>    - **`content_pipelines`** — one row per active, non-deleted, **non-internal** client (unique `(period, client_id)`), mostly nulls, `version: 1`.
>    - **`shoot_schedules`** — for each active non-internal client, `slot_index` `1..client.shoot_slots_per_month`, `slot_status: 'Unset'`, `pieces_expected: client.pieces_per_visit`. (No `version` column on this table.)
>    - **`content_calendar`** — one row per active non-internal client × each date in the month, `status: 'No Activity'`, `version: 1` (unique `(period, client_id, date)`).
>    Use `date-fns` for the day iteration. Make it idempotent-friendly (guard against duplicate inserts if called twice for the same period — `ON CONFLICT DO NOTHING` or a pre-check), because Sprint 12's rollover has its own idempotency guard and shouldn't double-insert.
>
> 2. **Extend `database/seeds/002_dev_data.ts`** (dev only — `NODE_ENV !== 'production'`):
>    - Compute the **current IST month** (`YYYY-MM`) and the **prior month** dynamically with `date-fns-tz` — never hardcode a date. Insert both into `months` (current: `locked: false`; prior: `locked: false` so lock/unlock is testable), with `label` like `'June 2026'`.
>    - Ensure the seeded 5 staff (one per role) and 8 clients (varied `shoot_slots_per_month`, one `is_internal: true`) from the original M-10 seed exist.
>    - Insert **2 sample holidays** in the current month (e.g. a mid-month weekday). Insert them as `holidays` rows (`active: true`), then apply them to attendance the same way `HolidayService.create` will (STEP 5): `UPDATE attendance_logs SET day_type='holiday' WHERE period=$current AND date=$holidayDate AND day_type='working'`. (A short inline update in the seed is fine — comment it "same effect as HolidayService.create".)
>    - Call `generatePeriodRows(currentMonth, trx)` **before** applying the sample holidays, so the attendance rows exist to be flipped.
>
> 3. **Do NOT touch `getCurrentPeriod`.** It stays a pure read (STEP-2-of-Sprint-2 behavior). Month creation belongs to the seed (dev) and the rollover (prod), never to a GET handler.
>
> **RULES**
>
> - `generatePeriodRows` is the shared contract between the dev seed and the Sprint 12 rollover. Write it once, cleanly, with a `trx` parameter so it composes inside the rollover's single transaction later.
> - Dev seed only runs when `NODE_ENV !== 'production'`. Never seed sample data into prod.
> - Internal clients (`is_internal = true`) get **no** shoot/pipeline/calendar rows (they're internal, not client deliverables) but **do** count for nothing here — skip them in the client loops.
>
> Show me the `generatePeriodRows` signature and the seed diff.

**Verify:**

```bash
# Re-run the seed against the local DB
pnpm --filter @skaly/api db:seed          # or your Sprint 0 seed script name

docker compose exec postgres psql -U skaly -d skaly_dev
```

```sql
-- Two months, current + prior, dynamically dated
SELECT period, label, locked FROM months ORDER BY period DESC;

-- Attendance rows exist for the current month across staff, with sundays + holidays marked
SELECT day_type, COUNT(*) FROM attendance_logs
WHERE period = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')
GROUP BY day_type;

-- Calendar + pipeline + shoot rows exist for clients
SELECT COUNT(*) FROM content_calendar WHERE period = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM');
SELECT COUNT(*) FROM shoot_schedules  WHERE period = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM');
\q
```

You should see `working`, `sunday`, and `holiday` rows in attendance, and non-zero calendar/shoot/pipeline counts.

---

## SPRINT 3 — STEP 4: `AttendanceService` + shared day-type helper

**Goal:** The service that powers the grid — read, ownership-safe write, and the mid-month backfill (finishing the Sprint 1 stub). Reuse Sprint 2's `optimisticUpdate` and `AuditService`.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 3, STEP 4. Dev data is in place. Now the AttendanceService. Read `docs/04-APPFLOW.md` §4, `docs/07-API-CONTRACT.md` §5, `docs/08-AUTH-MATRIX.md` §7, and the `attendance_logs` table in `docs/05-BACKEND-SCHEMA.md`.
>
> **WHAT TO BUILD**
>
> 0. **Shared helper first.** Extract the per-date classification into `apps/api/src/lib/period-days.ts`: `classifyDay(date, activeHolidayDates: Set<string>): 'working' | 'sunday' | 'holiday'` (Sunday if `getDay()===0`; holiday if the date is in the active-holiday set; else working) and `workingDatesInPeriod(period, activeHolidayDates)`. `generatePeriodRows` (STEP 3) and `backfillCurrentPeriod` (below) both use this — one source of truth for "what kind of day is this."
>
> 1. **`apps/api/src/services/AttendanceService.ts`:**
>    - `getGrid(period, currentUser, trx)`:
>      - `admin` / `manager` → full grid, all columns editable.
>      - `team_member` → the **full grid for display**, plus a computed `editableStaffIds = [currentUser.staffId]` so the UI can disable other columns. (Backend still enforces on PATCH.)
>      - `freelancer` → this method isn't reached; the route returns 403 (see STEP 6). If somehow called, throw `PERMISSION_DENIED`.
>      - Returns the API-Contract §5 shape: `{ attendanceLogs[], holidays[] (active only), staffList[] (id,name,role,avatarUrl, alphabetical by name = column order), editableStaffIds }`. Use `softDeletable` on staff. `isOnline` is not needed here.
>    - `update(attendanceId, patch, currentUser, expectedVersion, trx)`:
>      - Load the row. **Ownership (column ownership backstop):** if `currentUser.role === 'team_member'` and `row.staff_id !== currentUser.staffId` → throw `PERMISSION_DENIED` (403).
>      - `assertPeriodNotLocked(row.period, trx)` first (→ 423 if locked).
>      - `patch` may contain `present` (boolean) and/or `work_log` (string, **max 2000 chars** — validate). It must **not** change `day_type` (that's holiday/rollover territory).
>      - Write via `BaseService.optimisticUpdate('attendance_logs', id, expectedVersion, { present, work_log, updated_by: currentUser.staffId }, trx)` → increments `version`, returns the full row, throws `STALE_DATA` (409) on version mismatch.
>      - `AuditService.log({ actorId: currentUser.staffId, action: 'UPDATE', entity: 'attendance_logs', entityId: id, before, after, trx })`.
>      - Return the full updated row.
>    - `backfillCurrentPeriod(newStaffId, trx)` — **finish the Sprint 1 stub.** Load the current period (`getCurrentPeriod`), load its active holidays, and generate one `attendance_logs` row for the new staff member for **each date from today (IST) through end-of-period**, using `classifyDay` for `day_type`, `present: false`, `version: 1`. Respect the unique `(period, staff_id, date)` constraint. This is what Sprint 1's signup-approval calls.
>
> 2. **Unit tests** `apps/api/test/services/AttendanceService.test.ts`:
>    - `update` throws `PERMISSION_DENIED` when a team_member targets another staff member's row; succeeds on own row.
>    - `update` throws `STALE_DATA` on a mismatched version; increments `version` on success.
>    - `update` rejects a `work_log` longer than 2000 chars with `VALIDATION_ERROR`.
>    - `update` on a locked period throws `PERIOD_LOCKED`.
>    - `backfillCurrentPeriod` creates the correct number of rows (working + sunday + holiday) from today to end-of-period, and never duplicates an existing row.
>    - **Re-run Sprint 1's approval test** — `AttendanceService.backfillCurrentPeriod` is now real; the approve flow must still pass and produce attendance rows for the new staff.
>
> **RULES**
>
> - `optimisticUpdate` is the only write path for `attendance_logs`. No bare UPDATE.
> - Every write: `assertPeriodNotLocked` first, `AuditService.log` after.
> - `day_type` is never set by `update`. Only `generatePeriodRows`, `backfillCurrentPeriod`, and HolidayService set it.
> - Reuse `classifyDay` in both `generatePeriodRows` and `backfillCurrentPeriod` — do not duplicate the Sunday/holiday logic.
> - **Verify before moving on.** Service, then unit tests, then re-run Sprint 1 approval test.
>
> Start with `period-days.ts`, then `AttendanceService.ts`.

**Verify:**

```bash
pnpm --filter @skaly/api test services/AttendanceService.test
pnpm --filter @skaly/api test auth/                 # Sprint 1 approval flow still green with real backfill
pnpm typecheck
```

---

## SPRINT 3 — STEP 5: `HolidayService` (create + remove / H-01)

**Goal:** Holidays flip working days to holiday and back — the remove path (H-01) is the whole reason this finding exists. Removal is a **soft** operation (no DELETE grant on `holidays`) and must revert attendance in the same transaction.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 3, STEP 5. AttendanceService done. Now HolidayService, including audit H-01. Read the `holidays` table and §11 (DB grants) in `docs/05-BACKEND-SCHEMA.md`, and `docs/14-PRE-BUILD-AUDIT.md` H-01.
>
> **CONTEXT YOU MUST RESPECT**
>
> - `holidays` create/remove is **admin + manager** (Auth-Matrix §4 + FR-ATT-09), **not** admin-only.
> - The attendance state column is **`day_type`** (`'working'|'sunday'|'holiday'`), not `status`.
> - The app role has **no DELETE grant on `holidays`** (§11). "Removal" is a **soft** update: `active=false, removed_at=now(), removed_by=currentUser`. Never `DELETE FROM holidays`.
> - Holiday create only affects `day_type='working'` rows; leaves `sunday` rows alone. Revert flips `day_type='holiday'` → `'working'`.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/src/services/HolidayService.ts`:**
>    - `create({ period, date, name, currentUser, trx })` — admin/manager:
>      - `assertPeriodNotLocked(period, trx)`.
>      - Insert the `holidays` row (`active: true`, `added_by: currentUser.staffId`). Respect unique `(period, date)`.
>      - `UPDATE attendance_logs SET day_type='holiday' WHERE period=$period AND date=$date AND day_type='working'` (Sundays untouched).
>      - `AuditService.log({ action: 'INSERT', entity: 'holidays', entityId, ... })`.
>      - Emit `io.of('/ws/notify').to('org:all').emit('attendance:holiday_added', { period, date, name })`.
>      - Return the created holiday.
>    - `remove(holidayId, currentUser, trx)` — **audit H-01** — admin/manager:
>      - Load the holiday; if not found or already `active=false` → `RESOURCE_NOT_FOUND`.
>      - `assertPeriodNotLocked(holiday.period, trx)`.
>      - **In one transaction:** (a) `UPDATE holidays SET active=false, removed_at=now(), removed_by=$currentUser WHERE id=$id`; (b) `UPDATE attendance_logs SET day_type='working' WHERE period=$period AND date=$date AND day_type='holiday'`.
>      - `AuditService.log({ action: 'UPDATE', entity: 'holidays', entityId, before, after, ... })`.
>      - Emit `attendance:holiday_removed` to `org:all` with `{ period, date }`.
>      - Return `{ removed: true }`.
>
> 2. **Tests** `apps/api/test/services/HolidayService.test.ts`:
>    - `create` inserts the holiday and flips that date's `working` rows to `holiday`; a `sunday` row on a different date is untouched.
>    - **H-01:** `remove` sets `active=false` **and** reverts the `holiday` rows to `working` — assert both in the same transaction (mock a failure between the two updates and assert **both** roll back).
>    - `create`/`remove` on a locked period throw `PERIOD_LOCKED`.
>    - `remove` on an already-inactive holiday throws `RESOURCE_NOT_FOUND`.
>
> **RULES**
>
> - Removal is soft (`active=false`) — the app role cannot DELETE from `holidays`. This is not a preference; it's what the DB grants allow.
> - The two UPDATEs in `remove` are atomic. That is the entire point of H-01 — half-applied removal leaves a phantom gold day.
> - Emit the socket event **after** the DB writes succeed (post-commit semantics). A failed emit never rolls back the DB.
> - **Verify before moving on.** Service, then the H-01 atomicity test specifically.
>
> Start with `HolidayService.ts`. Show me `remove()` first — it's the finding.

**Verify:**

```bash
pnpm --filter @skaly/api test services/HolidayService.test
pnpm typecheck
```

---

## SPRINT 3 — STEP 6: Routes — attendance + holidays + registration

**Goal:** Wire the endpoints with correct RBAC and Zod validation, register them in `server.ts`, and prove the access boundaries with route tests.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 3, STEP 6. Services are done. Now the routes. Read `docs/07-API-CONTRACT.md` §5–§6 and `docs/08-AUTH-MATRIX.md` §4 (endpoint access).
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/src/routes/attendance/`:**
>    - `GET /v1/attendance?period=<YYYY-MM>` — `allowedRoles: [admin, manager, team_member]` (**freelancer → 403**). Zod-validate the `period` query param. Calls `AttendanceService.getGrid`. Returns the §5 shape.
>    - `PATCH /v1/attendance/:id` — `allowedRoles: [admin, manager, team_member]`. Zod body: `{ present?: boolean, workLog?: string (max 2000), version: number (required) }`. Maps `workLog`→`work_log`. Calls `AttendanceService.update`. Returns the **full updated row** per API-Contract §1.1.
>
> 2. **`apps/api/src/routes/holidays/`:**
>    - `GET /v1/holidays?period=` — `allowedRoles: [admin, manager]` (team_member/freelancer 403 per Auth-Matrix §4). Returns active holidays for the period.
>    - `POST /v1/holidays` — `allowedRoles: [admin, manager]`. Zod body `{ period, date, name }`. Calls `HolidayService.create`.
>    - `DELETE /v1/holidays/:id` — `allowedRoles: [admin, manager]`. Calls `HolidayService.remove` (soft remove + revert). Returns `{ removed: true }`.
>
> 3. **Register** the two route plugins in `apps/api/src/server.ts` in the canonical plugin order (after auth/rbac, before internal routes), alongside the Sprint 2 route plugins.
>
> 4. **Route tests** `apps/api/test/routes/attendance.test.ts`:
>    - `GET /v1/attendance` → **403 for freelancer**; 200 for admin/manager/team_member.
>    - `GET` as team_member returns `editableStaffIds = [their own id]`.
>    - `PATCH /v1/attendance/:id` → 403 when a team_member targets another staff member's row (column-ownership backstop).
>    - `PATCH` with a stale `version` → 409 `STALE_DATA` with `details.currentVersion`.
>    - `PATCH` on a locked period → 423 `PERIOD_LOCKED`.
>    - `POST /v1/holidays` as team_member → 403; as manager → 201, and the date's working rows become holiday.
>    - `DELETE /v1/holidays/:id` as manager → holiday `active=false` **and** attendance rows reverted to working (H-01 through the HTTP layer).
>
> **RULES**
>
> - Field filtering and ownership are enforced **server-side**. The frontend `pointer-events` in STEP 7 is convenience only.
> - All bodies/queries validated via `fastify-type-provider-zod` so they surface in Swagger.
> - CORS/plugin order unchanged from Sprint 2 (TRD §5.1).
> - **Verify before moving on.** Routes, then the route tests, confirm the 403/409/423 boundaries.
>
> Show me the two route files and the registration block in `server.ts`.

**Verify:**

```bash
pnpm --filter @skaly/api test routes/attendance.test
pnpm typecheck
# Manual: http://localhost:3001/docs now lists /v1/attendance + /v1/holidays with schemas
```

---

## SPRINT 3 — STEP 7: Frontend — the attendance grid page

**Goal:** The grid itself — the reference implementation every later module grid copies. TanStack Table v8, the gold column highlight, optimistic present toggle, debounced work-log, locked read-only mode, per-column totals.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 3, STEP 7. Backend is done and tested. Now the attendance grid page. Read `docs/03-UIUX.md` §2.1 (color tokens), §4.2 (grid cell types), §4.4 (gold column highlight), §7 (Staff Attendance layout), and `docs/07-API-CONTRACT.md` §5.
>
> **WHAT TO BUILD**
>
> `apps/web/src/app/(portal)/attendance/page.tsx` plus any grid components under `apps/web/src/components/modules/attendance/`.
>
> 1. **Data.** TanStack Query v5: `useQuery({ queryKey: ['attendance', period], queryFn: ... })`, driven by the period from the `?period=` URL param (the `useMonthContext` hook / MonthContext store from Sprint 0). `staleTime: 30_000`.
>
> 2. **Grid.** TanStack Table v8. **Columns = staff** (order = `staffList`, alphabetical). **Rows = dates.** Sticky date column (left, 120px, DM Mono). Staff columns 140px. Row height 48px (56px when the work-log is expanded inline).
>
> 3. **Row variants** by `day_type` (**the column is `day_type`, not `status`**):
>    - `working` → interactive cell (present toggle + work-log).
>    - `sunday` → greyed, non-interactive: `--bg-base` background, `--text-disabled` text.
>    - `holiday` → gold-tinted, non-interactive: background `var(--accent-gold-06)` (0.06) with a gold bottom border; show the holiday name in a tooltip.
>
> 4. **Team-member column disabling (CSS only, no JS gating).** For every column whose staff id is **not** in `editableStaffIds`, apply `pointer-events: none` and `opacity: 0.4` to the cells. No click handler fires, no API call is made. (`docs/03-UIUX.md` §4.2.) The backend 403 is the real boundary.
>
> 5. **Gold column highlight (Amendment 2).** Use the `useColumnHighlight` hook from Sprint 0 on every editable cell (`onFocus` → set active column, `onBlur` → clear). Highlighted column: background `var(--accent-gold-dim)` (0.12), left/right borders `var(--accent-gold-border)` (0.60). This grid is **not** virtual-scrolled, so use the per-column hook approach (not the overlay). Persists during save-in-flight; clears on success; on save failure the column stays highlighted, the status dot turns red, and it clears 1.5s after the toast (UIUX §4.4 state rules).
>
> 6. **Present toggle** — instant optimistic update: flip the cell, fire `PATCH /v1/attendance/:id { present, version }`, and on the response **replace the cached row with the returned full row** (so its new `version` is used for the next edit — this prevents the user's own rapid edits from colliding with 409). On failure, revert + red dot + toast.
>
> 7. **Work-log** — a textarea that **autosaves 800ms after the last keystroke** (a debounce ref + `useMutation`). Same version-from-response handling as the toggle. Max 2000 chars (mirror the backend limit in the UI).
>
> 8. **Locked period** — when the period's `locked` is true, render every cell as a `<span>` (no `<input>`, nothing to focus), and show a gold banner at the top: "This period is locked. Read-only." No gold highlight, no toggles.
>
> 9. **Footer row** — per-column **total days present**, computed on the client from the fetched rows (`count(present === true)` per staff column). DM Mono. (Do not call a separate endpoint; this is derived from the data already loaded.)
>
> 10. **Optimistic-lock 409 handler** — on `STALE_DATA`, show the inline message from `docs/09-ERROR-HANDLING.md` §5.1: "Updated by {updatedBy.name} — [Refresh row →]"; clicking **Refresh row** re-fetches (invalidate `['attendance', period]`).
>
> 11. **Own-mutation refresh only.** After the acting user's own successful mutation, the cache already holds the returned row — no extra work. **Do not build a socket client subscription in this sprint** — cross-user live grid refresh and holiday bell-notifications are wired in Sprint 10. (Leave a `// TODO(Sprint 10): subscribe to attendance:holiday_added/removed on /ws/notify` where the subscription will go.)
>
> **RULES**
>
> - Use the color tokens from `globals.css` (UIUX §2.1) by their real names (`--accent-gold-dim`, `--accent-gold-border`, `--accent-gold-06`, `--bg-base`, `--text-disabled`) — not ad-hoc `hsl(...)`.
> - The frontend disabling is **UX**; never rely on it for security. The backend already enforces.
> - Always send `version` on PATCH and adopt the returned row's `version` for the next edit.
> - Accessibility: `role="grid"`, `role="gridcell"`, `aria-rowindex`/`aria-colindex`, focus ring `outline: 2px solid var(--accent-gold)`, 44×44px min touch targets, status never by color alone (UIUX §20 / NFR §7).
> - **Verify before moving on.** Build the grid, then present-toggle, then work-log debounce, then locked mode, then the 409 handler.
>
> Start with the page shell + the TanStack Table column/row model. Show me the grid rendering before wiring mutations.

**Verify (manual, `pnpm dev` running):**

```
Open http://localhost:3000/attendance?period=<current YYYY-MM>  (log in first)

As admin/manager:
  - Grid renders; sundays greyed; the 2 seeded holidays gold-tinted with tooltip.
  - Focus a cell → its column highlights gold.
  - Toggle present → flips instantly; Network tab shows PATCH; returned row's version increments.
  - Type in a work-log → Network tab shows the PATCH ~800ms after you stop typing.
  - Footer shows per-column present totals.

As team_member (log in as the seeded team member):
  - Only your own column is interactive; other columns are dimmed and unclickable.

Locked period:
  - Lock the prior month via the DB (UPDATE months SET locked=true WHERE period='<prior>'), open ?period=<prior>
  - Every cell is static text; the gold "locked, read-only" banner shows.
```

---

## SPRINT 3 — STEP 8: Round-out tests + full suite

**Goal:** The two tests that need special setup (socket broadcast + Playwright), then the whole suite green before close-out.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 3, STEP 8. Module works end-to-end manually. Now the remaining automated tests.
>
> **WHAT TO BUILD**
>
> 1. **Socket broadcast integration test** `apps/api/test/sockets/holiday-broadcast.test.ts`: connect a `socket.io-client` to `/ws/notify` (joined to `org:all` on connect), call `HolidayService.create`, and assert the client receives `attendance:holiday_added` with `{ period, date, name }`. Repeat for `remove` → `attendance:holiday_removed`.
>
> 2. **Playwright smoke** `apps/web/e2e/attendance.spec.ts` (against staging or local per your Sprint 1 Playwright config):
>    - Admin logs in, opens `/attendance`, edits any cell → succeeds.
>    - Team member logs in, opens `/attendance`, own column editable, another column not (assert the cell has `pointer-events: none` / is not editable).
>    - Locked period renders read-only (no inputs, banner visible).
>
> 3. Run the full suite + typecheck + lint.
>
> **RULES**
>
> - The socket test asserts real receipt over the wire, not a spy on the emit. That's what proves the broadcast reaches `org:all`.
> - Keep Playwright to smoke depth — the exhaustive E2E suite is Sprint 13.
>
> Show me the socket test and the Playwright spec.

**Verify:**

```bash
pnpm --filter @skaly/api test              # full API suite green (incl. attendance, holiday, socket)
pnpm --filter @skaly/web test              # frontend hook/component tests green
pnpm exec playwright test attendance       # smoke green (or your configured command)
pnpm typecheck
pnpm lint
```

---

## SPRINT 3 — STEP 9: End-to-end smoke + commit + close-out (manual)

### 9.1 — Manual smoke walk-through

```bash
docker compose up -d
pnpm --filter @skaly/api db:seed           # fresh dev data (current+prior months, holidays, all module rows)
pnpm dev
```

Walk the module as in STEP 7's manual checks (admin full edit, team member own-column-only, locked read-only, gold highlight, 800ms autosave, footer totals). Then verify the audit trail and mid-month backfill:

```sql
-- docker compose exec postgres psql -U skaly -d skaly_dev
-- Every attendance edit + holiday change is audited, staff_id never null:
SELECT staff_id, changed_by_source, table_name, action, created_at
FROM audit_log WHERE table_name IN ('attendance_logs','holidays')
ORDER BY created_at DESC LIMIT 10;
```

Mid-month backfill (via Sprint 1's approval flow): approve a new self-signup, then confirm attendance rows exist for that new staff member from today to end-of-period:

```sql
SELECT day_type, COUNT(*) FROM attendance_logs
WHERE staff_id = '<new staff id>' AND period = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM')
GROUP BY day_type;
```

### 9.2 — Close-out checklist

Do not start Sprint 4 until **every** box is checked:

```
DECISIONS (from Sprint 2)
  [ ] ADR-003 written; AuditService.log matches the confirmed audit_log write path (A/B)
  [ ] ROLE_DEFAULTS map built + diffed against Auth-Matrix §5 (🔧 = false + commented, 🔐 = true)
  [ ] Dev seed inserts current + prior IST months (dynamic); generatePeriodRows factored + called
  [ ] Bot-streaming-namespace decision recorded (/ws/notify; no fourth namespace)

BACKEND
  [ ] classifyDay/workingDatesInPeriod helper shared by generatePeriodRows + backfillCurrentPeriod
  [ ] getGrid returns §5 shape + editableStaffIds; team_member sees full grid, own id only editable
  [ ] update: team_member 403 on another's row (ownership backstop); optimisticUpdate + full row
  [ ] update: STALE_DATA 409 on stale version; PERIOD_LOCKED 423 on locked; work_log ≤ 2000
  [ ] backfillCurrentPeriod fleshed out; Sprint 1 approval flow STILL green
  [ ] HolidayService.create: working→holiday flip + attendance:holiday_added broadcast
  [ ] HolidayService.remove (H-01): SOFT remove (active=false) + holiday→working revert, ONE transaction
  [ ] holidays create/remove are admin + manager (not admin-only); no DELETE FROM holidays anywhere

ROUTES
  [ ] GET /v1/attendance → 403 freelancer; PATCH ownership + version enforced
  [ ] GET/POST/DELETE /v1/holidays → admin+manager; DELETE performs soft-remove + revert
  [ ] Routes registered in server.ts (TRD §5.1 order); visible in /docs

FRONTEND
  [ ] Grid: TanStack Table v8, day_type row variants, sticky date col, per-column present footer
  [ ] Team-member columns dimmed + pointer-events:none (CSS only)
  [ ] Gold column highlight via useColumnHighlight; correct tokens (--accent-gold-dim/-border/-06)
  [ ] Present toggle optimistic; work-log 800ms debounce; both adopt returned row's version
  [ ] Locked period: <span> cells + gold banner; no highlight/toggle
  [ ] 409 STALE_DATA inline handler ("Updated by {name} — Refresh row →")
  [ ] TODO(Sprint 10) marker left where the /ws/notify subscription will go

TESTS
  [ ] Unit: ownership 403, STALE_DATA, work_log limit, locked
  [ ] Integration: holiday create flip, H-01 remove atomic revert, backfill count, socket broadcast received
  [ ] Playwright smoke: admin edits any / team_member own only / locked read-only
  [ ] Full suite + typecheck + lint green
```

### 9.3 — Final commit

```bash
git add -A
git commit -m "Sprint 3: Staff Attendance (H-01 holiday cascade, column ownership); ROLE_DEFAULTS, generatePeriodRows, ADR-003"
git push -u origin sprint-3-attendance
```

Open the PR to `main`, let CI pass, merge, then:

```bash
git checkout main && git pull
```

### 9.4 — Move to Sprint 4

Open `MASTER-BUILD-GUIDE-V2-FINAL.md` → PART 9 → **SPRINT 4 — WORK ALLOCATION (TASKS)**, or the forthcoming `SPRINT-4-DETAILED.md`.

Sprint 4 reuses everything you built here: the module-grid frontend pattern, `optimisticUpdate`, `AuditService`, `NotificationService` (tasks fire `task_assigned` **once per assignee** — audit H-03), the `softDelete` helper (tasks are soft-deleted), and the R2 presign utilities (task attachments — the presigned PUT flow, no files through the API). The dependency-blocking rule (a task can't go `Done` while its dependency isn't `Done`) is the one genuinely new piece.

If any Sprint 3 close-out box is unchecked, **stop**. The module pattern you just set is copied four more times — get it clean here.

---

## DECISIONS TO MAKE BEFORE SPRINT 4

- **`task_assigned` fan-out (audit H-03):** confirm the ruling now — one `task_assigned` notification fires **per assignee**, never combined. `NotificationService.create` from Sprint 2 is per-recipient, so this is a loop, not a new mechanism. Just lock it so the Sprint 4 test asserts N notifications for N assignees.
- **Task attachment MIME/size enforcement:** the presign endpoint must reject bad types/sizes **server-side** (50MB/attachment, 200MB/task, PDF/JPG/PNG/MP4/MOV) — not just in the browser. Decide that the presign step validates before returning a URL (it does per API-Contract §5), so a client can't bypass the UI.
- **Attendance holiday bell-notification (carried):** the `holiday_added`/`holiday_removed` **bell notifications** (as opposed to the grid-update broadcast you built this sprint) are deferred to Sprint 10's full notification coverage. Confirm that's still the plan so you don't half-build it in Sprint 4.
- **Frontend socket client:** still deferred to Sprint 10. If Sprint 4/5/6 modules feel like they need live cross-user updates before then, resist — batch the socket-client work into Sprint 10 as planned (it needs the C-05 token-refresh wiring anyway).

---

## TROUBLESHOOTING — SPRINT 3 SPECIFIC

### The attendance grid renders empty in dev
`generatePeriodRows` didn't run for the current month, or the current-month `months` row is missing. Re-run the seed (STEP 3) and confirm `SELECT COUNT(*) FROM attendance_logs WHERE period = <current>` is non-zero. If `getCurrentPeriod` 404s, the seed didn't insert the current IST month.

### `AttendanceService.update` throws `permission denied for table audit_log`
`AuditService.log` isn't using the write path your DB allows (Style B function vs direct INSERT). Fix per ADR-003 / STEP 1.3 — this is the single most common Sprint-3 failure because every write now audits.

### Holiday shows removed in the list but the day is still gold and non-interactive
H-01 half-applied — the `holidays` row deactivated but the `attendance_logs` revert didn't run (or ran outside the transaction). Both UPDATEs must be in the **same** transaction (STEP 5). Also confirm you're reverting `day_type='holiday'` → `'working'`, matching the exact date/period.

### `DELETE /v1/holidays/:id` throws `permission denied for table holidays`
You wrote a real `DELETE FROM holidays`. The app role has no DELETE grant on that table. Removal is a soft `UPDATE ... SET active=false` (STEP 5 / reconciliation #3).

### A holiday added on a Sunday does nothing visible
Correct — holiday create only flips `day_type='working'` rows, and a Sunday is already `'sunday'`. Sundays are intentionally left alone. Don't "fix" this.

### The user's own rapid edits trigger 409 STALE_DATA on themselves
The frontend isn't adopting the `version` from each PATCH response before the next edit. After every successful PATCH, replace the cached row with the returned full row so the next edit sends the fresh `version` (STEP 7, items 6–7).

### Gold column highlight looks washed out / wrong color
You used `hsl(var(--gold)/0.12)` instead of the actual token `var(--accent-gold-dim)`. Use the tokens defined in `globals.css` per UIUX §2.1 (reconciliation #5).

### `pointer-events: none` columns are still triggering saves
You added JS gating on top of the CSS, or the disabling class isn't on the cell wrapper. It's **CSS only** — no click handler should fire on a disabled column (UIUX §4.2). The backend 403 is the real guard regardless.

### Socket broadcast test never receives the event
The client connected to the default namespace or wasn't joined to `org:all`. Connect to `/ws/notify` and confirm the connect handler joins `org:all`; emit with `io.of('/ws/notify').to('org:all').emit(...)` (matching namespace on both sides).

### `backfillCurrentPeriod` creates duplicate rows / violates the unique constraint
It's not respecting `(period, staff_id, date)`. Guard with `ON CONFLICT DO NOTHING` or a pre-check, and only generate from today → end-of-period (not the whole month) for a mid-month hire.

---

## END OF SPRINT 3 DETAILED GUIDE

*Companion document to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9, `SPRINT-1-DETAILED.md`, and `SPRINT-2-DETAILED.md`. Source-of-truth precedence when this guide and the Master Build Guide differ: the numbered spec docs (`01`–`14`) win, then this guide's reconciliations, then the Master Build Guide's shorthand. Sprint 4 (Work Allocation / Tasks) copies the module pattern established here.*
