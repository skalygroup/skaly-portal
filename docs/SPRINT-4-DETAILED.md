# SPRINT 4 — WORK ALLOCATION (TASKS): DETAILED PROMPT-BY-PROMPT GUIDE

## Scaly Business Portal • Sprint 4 of 13

**Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1/2/3-DETAILED.md`**
**Same Goal / Prompt / Verify framework as Sprints 0–3**
**Tooling interfaces verified as of January 2026** — Next.js 15 (App Router), TanStack Table v8 + TanStack Query v5, Zustand 5, shadcn/ui on Tailwind 4 (`@theme`), Framer Motion 11, `@aws-sdk/client-s3` v3 + `s3-request-presigner`, XMLHttpRequest for upload progress (fetch still has no upload-progress event), Playwright latest, Lucide React.

---

## WHAT YOU'RE BUILDING IN SPRINT 4

Sprint 3 proved the module pattern. Sprint 4 reuses the whole chassis and adds the two genuinely new backend patterns — **single-dependency integrity** and the **two-point attachment pipeline** — plus per-assignee notification fan-out. By the end of this week:

- **`TaskService`** is real: role-filtered reads; admin/manager create with an assignee set; team-member `status`+`result` edits restricted to their **own assigned** tasks (service-enforced, not just UI); soft-delete via `BaseService.softDelete`; assign/unassign; and dependency handling — **cycle prevention at write time** (ADR-009), the **`Done`-block** (`DEPENDENCY_UNRESOLVED` 400), and the **`dependency_resolved`** notification on completion.
- **`task_assigned` fans out per assignee** (ADR-006 / audit H-03): one notification per newly-added, non-actor assignee — never combined — written **in the same transaction** as the `task_assignees` insert, and **tested this sprint** (N notifications for N assignees).
- **Task attachments** work end-to-end through the **presign → browser PUT → confirm** pipeline with **server-side validation at both ends** (ADR-007): presign rejects bad MIME / oversize / over-task-limit before issuing a URL; confirm re-validates the **actual** object via `HeadObject` and deletes the orphan if it lies. Download is a fresh 1-hour presigned GET; delete removes the R2 object + row.
- **Tasks are not versioned** (ADR-008): task `PATCH` is last-write-wins, no `version` field, no `STALE_DATA` — `optimisticUpdate` is never called on tasks.
- **Routes** match API-Contract §7 exactly, role-gated at layer 2 with the service as the deep boundary, all visible in Swagger.
- **The tasks page** renders per UI/UX §8: a full-width list **grouped by date** with **collapsible** headers (collapse state in Zustand + `sessionStorage`), the column order Date · Client · Description · Assignees (avatar stack) · Status chip · Priority badge · Dependency indicator · Deadline · Attachments count, **row expansion** to an inline detail panel (remark, result), and the **gold column highlight** on every editable cell (status, result, assignees).
- **Creation** is a **slide-in right panel** (Framer Motion `x:'100%'→x:0`) with the full field set; **attachments** use a drag-and-drop panel with a real progress bar; the **dependency badge** shows "Blocked by: [description]" when unresolved.
- **Real-time is emitted, not consumed** (ADR-010): the backend writes `task_assigned` rows and fires `notify:new`; no frontend socket subscription is built (that's Sprint 10). Own-mutation refresh via TanStack Query invalidation covers the single-user view; `// TODO(Sprint 10)` markers sit where subscriptions will attach.
- **Tests** prove all of it: dependency block, cycle rejection, ownership 403, per-assignee fan-out count, attachment validation (both ends), soft-delete filtering — plus a Playwright smoke for create → assign → attach → status transition.

**Estimated time:** 5 working days (Week 5 per `06-IMPLEMENTATION-PLAN.md` §7; owners D1 + D3). Day 1 pre-flight + `TaskService` core; day 2 attachments; day 3 routes + backend tests; days 4–5 frontend + E2E. Sprints 5–7 copy this module's shape (grid + service + notifications), so nail the patterns here.

**Prerequisites from Sprint 3** (all green — stop and fix if any is not):

- Sprint 3 close-out fully checked; PR merged to `main`; CI green.
- `docs/decisions/ADR-001`, `ADR-002` and `ADR-003` committed (there is no ADR-004 or ADR-005 — the numbering skips them); the **five new ADRs from the pre-Sprint-4 gate (006–010)** are on disk ready to commit (STEP 1 commits them).
- The portal chassis exists and works: `(portal)` layout + RBAC sidebar, `MonthContext` with `?period=` URL sync, `lib/api.ts` (envelope parsing + 401 refresh), `handleMutationError`, the TanStack Query provider, `useColumnHighlight` (Sprint 0), `softDelete`/`softDeletable`, `optimisticUpdate`, `AuditService`, `NotificationService`, `lib/r2.ts` presign helpers, the `/ws/notify` **backend** broadcast path.
- `pnpm typecheck`, `pnpm lint`, and the full suite green on `main`.

---

## THE FIVE PRE-SPRINT-4 ADRs — WHERE THEY LAND

These were ruled at the pre-Sprint-4 gate and are **inputs** to this sprint. STEP 1 commits them; the steps below execute them.

| ADR | Ruling | Executed in |
|---|---|---|
| **ADR-006** — `task_assigned` fan-out | One notification **per newly-added, non-actor assignee**; never combined; written in the assignee-insert transaction; **tested this sprint** (N for N). | STEP 2 (assign path) + STEP 5 test |
| **ADR-007** — attachment validation | Server-side at **both** presign (declared MIME/size/task-total) **and** confirm (`HeadObject` actual size → delete orphan on fail). 24h lifecycle sweep for unconfirmed objects. | STEP 3 |
| **ADR-008** — tasks not versioned | Last-write-wins; **no `version`** on task PATCH; `optimisticUpdate` never used for tasks; no `STALE_DATA` surface. | STEP 2 (update path) |
| **ADR-009** — dependency integrity | Write-time **cycle prevention** (bounded walk); `Done`-block (`DEPENDENCY_UNRESOLVED` 400); `dependency_resolved` notification on completion; **no auto-status-change**. | STEP 2 (dependency logic) |
| **ADR-010** — real-time deferred | Sprints 4–6 **emit** (rows + `notify:new`); **no frontend socket client** until Sprint 10. Durable `task_assigned` rows ARE written now; transient bells and live grid refresh wait. | STEP 2 (emit) + STEP 8 (`// TODO` markers) |

---

## READ FIRST (Open in Antigravity Split View)

`@`-reference these in chat with `@docs/07-API-CONTRACT.md`.

| Doc | Sections | Why |
|---|---|---|
| `docs/04-APPFLOW.md` | §5 (Tasks flow) | Every interaction Sprint 4 must produce |
| `docs/07-API-CONTRACT.md` | §7 (tasks — GET/POST/PATCH/DELETE, assignees, attachments) + the H-03 multi-assignee note + §1.1 envelopes | Exact request/response shapes |
| `docs/03-UIUX.md` | §8 (Tasks module), §4.2 (cell types), §4.3 (status chips), §4.4 (gold highlight — full spec), §4.5 (modal/panel) | Every visual rule |
| `docs/08-AUTH-MATRIX.md` | §4 (tasks + attachments access grid), §2 (three layers) | Who reads/edits/attaches what |
| `docs/05-BACKEND-SCHEMA.md` | `tasks` (216), `task_assignees` (245), `task_attachments` (253) | Column names, the single `dependency_id`, no `version`, the CHECK enums |
| `docs/09-ERROR-HANDLING.md` | §2 (`DEPENDENCY_UNRESOLVED`, file errors), §3 (`DEPENDENCY_UNRESOLVED` example), §5.1 (mutation routing) | Error shapes the FE routes on |
| `docs/06-IMPLEMENTATION-PLAN.md` | §7 | Sprint 4 checklist |
| `docs/12-TESTING-STRATEGY.md` | §4.2 (dependency tests), §5 (RBAC/isolation tests) | The tests you must reproduce |
| `docs/decisions/` | **ADR-006 → ADR-010** | The five rulings this sprint executes |

---

## CONSISTENCY RECONCILIATIONS — LOCK THESE BEFORE YOU PROMPT

The Master Build Guide's Sprint 4 shorthand drifts from the canonical specs in several load-bearing places. The numbered specs + schema win; the corrections are baked into every prompt below — know **why**:

1. **Dependencies are SINGLE, not a table.** `tasks.dependency_id` is a nullable self-FK — **one** dependency per task. There is **no `task_dependencies` table** (the Master Guide invented it). The `Done`-block checks that one `dependency_id` task; cycle prevention walks the `dependency_id` chain. Source: `05-BACKEND-SCHEMA.md` `tasks`.
2. **The error code is `DEPENDENCY_UNRESOLVED` (HTTP 400)** — not `DEPENDENCY_NOT_DONE` (422). Confirmed by `09-ERROR-HANDLING.md` §2/§3, `07-API-CONTRACT.md` §7, **and** `12-TESTING-STRATEGY.md` §4.2. The Master Guide's `DEPENDENCY_NOT_DONE`/422 is wrong.
3. **Tasks have NO `version` column** → last-write-wins, no optimistic locking, no `STALE_DATA` (ADR-008). Two docs leak `version` into tasks by copy-paste from the versioned-table pattern — **API-Contract §7's PATCH example (`"version": 2`)** and **Testing-Strategy §4.2's `updateStatus(managerId, task.id, 'Done', 1)` 4th arg**. Both are artifacts; the schema (no column) + audit C-02 (exactly three versioned tables: `attendance_logs`, `content_pipelines`, `content_calendar`) override. Task PATCH sends no `version`; your `updateStatus`/`update` signatures take no `expectedVersion`; **`optimisticUpdate` is never called on tasks**.
4. **Assignees ARE many-to-many** via `task_assignees` (this part of the contract is correct). Assigning = insert rows + fan-out notifications to the **new** ones (ADR-006). `?assigneeId=` matches "is one of the assignees," not "is the only assignee."
5. **Attachment download is `GET`**, not POST: `GET /v1/tasks/:id/attachments/:aid/download` → `{ downloadUrl }` (1-hour presigned GET). Source: API-Contract §7. The Master Guide's "download" as POST is wrong.
6. **Attachment R2 key convention:** `attachments/{taskId}/{uuid}_{fileName}` — matches API-Contract §7's `attachments/` prefix and namespaces by task (this refines ADR-007's illustrative `tasks/{taskId}/…` path; use the `attachments/` prefix so it matches the contract and any existing R2 lifecycle rule).
7. **Frontend path is `apps/web/app/(portal)/tasks/`** (no `src/`), matching the Sprint 3 as-built App-Router location. The Master Guide's `apps/web/src/app/(portal)/…` is not what was built — mirror Sprint 3.
8. **Time-logs are OUT of scope this sprint.** API-Contract §7 shows `/v1/tasks/:id/time-logs*` endpoints and UI/UX §8 says "time logs schema-ready," but there is **no `task_time_logs` table** in the schema and the Sprint 4 scope excludes them. Do **not** build them — leave the schema ready and the row-expansion panel's "time logs" area as a placeholder.
9. **The `task_assigned` test is written in THIS sprint.** The Master Guide says "we'll write the test for this in Sprint 5"; ADR-006, the pre-sprint ruling, and Impl-Plan §7 line 205 put the N-for-N assertion in Sprint 4.
10. **Team members read ALL tasks** (edits restricted). Auth-Matrix §4: `GET /v1/tasks` → team_member "✅ can read all; edits restricted." **Freelancer → 403** (no task access). "Role-filtered" = the freelancer block + the edit restriction, not a read filter for team members.
11. **Priority badge colours** (UI/UX §4.3 lists status chips but not priority): map to the design tokens — `Low` → grey/`--text-secondary`, `Medium` → blue, `High` → amber, `Urgent` → red — consistent with the §4.3 palette. Status chips are canonical: `To Do` grey · `In Progress` blue · `Blocked` red · `Done` green · `Cancelled` grey + strikethrough.
12. **Real-time: emit, don't consume** (ADR-010). Write `task_assigned` rows + fire `notify:new` server-side; optionally emit a `task:changed` broadcast to `org:all` for Sprint 10. Build **no** frontend socket subscription. Own-mutation refresh via `queryClient.invalidateQueries(['tasks', period])`. `// TODO(Sprint 10)` where the subscription attaches.

---

## AUDIT + ADR ITEMS THIS SPRINT MUST HANDLE

| ID | What | Where |
|---|---|---|
| **H-03 / ADR-006** | `task_assigned` fires **once per assignee**, never combined; per newly-added, non-actor assignee; in the assignee-insert transaction. **Test asserts N notifications for N assignees.** | STEP 2 + STEP 5 |
| **ADR-007** | Attachment MIME/size/task-total validated **server-side at presign AND at confirm** (`HeadObject` + orphan delete). A direct API caller cannot store a bad/oversized file. Both paths tested. | STEP 3 + STEP 5 |
| **ADR-008** | No `version` on tasks; last-write-wins; `optimisticUpdate` not used; no `STALE_DATA`. | STEP 2 |
| **ADR-009** | Write-time dependency **cycle prevention** (bounded walk) + `Done`-block (`DEPENDENCY_UNRESOLVED` 400) + `dependency_resolved` notification, no auto-status-change. Cycle + block both tested. | STEP 2 + STEP 5 |
| **Column ownership (reused)** | team_member PATCH restricted to `status`+`result` on **own assigned** tasks; service 403 backstop, not UI-only. Tested. | STEP 2 + STEP 5 |

If you skip the test for any of these, Sprint 4 is not done. They reappear in CI when you push.

---

## STEP-BY-STEP STRUCTURE

| # | Type | What |
|---|---|---|
| 1 | Manual | Pre-flight — Sprint 3 green, commit ADR-006..010, R2 browser-PUT pre-check, branch |
| 2 | Prompt | `TaskService` — CRUD + soft-delete + assign/unassign (+ H-03 fan-out) + dependency (cycle / block / resolved) |
| 3 | Prompt | Task attachments — presign / confirm (`HeadObject`) / download / delete (ADR-007) |
| 4 | Prompt | Routes + Zod schemas + registration + Swagger |
| 5 | Prompt | Backend test round-out + full suite |
| 6 | Prompt | Frontend — tasks grid (grouped-by-date, collapsible, columns, row expansion) |
| 7 | Prompt | Frontend — create panel + attachment panel + interactions + gold highlight + error routing |
| 8 | Manual + Prompt | Playwright smoke — create → assign → attach → status transition + ownership |
| 9 | Manual | End-to-end smoke + commit + close-out |

---

## SPRINT 4 — STEP 1: Pre-flight (manual)

**Goal:** Solid ground, ADRs committed, the attachment pipeline's one external dependency (R2 CORS) proven **before** you build on it.

### 1.1 — Confirm Sprint 3 is green

```bash
git checkout main && git pull
docker compose up -d && docker compose ps          # both healthy
pnpm install
pnpm --filter @skaly/api db:status                 # 0 pending
pnpm typecheck && pnpm --filter @skaly/api test    # green before branching
```

### 1.2 — Commit the five pre-sprint ADRs

The ADR files (`ADR-006` … `ADR-010`) from the pre-Sprint-4 gate belong in the repo before code references them.

```bash
ls docs/adr    # expect ADR-001..010; if 006-010 are missing, drop them in from the gate output
git add docs/decisions/ADR-006-*.md docs/decisions/ADR-007-*.md docs/decisions/ADR-008-*.md docs/decisions/ADR-009-*.md docs/decisions/ADR-010-*.md
git commit -m "docs(adr): record pre-Sprint-4 rulings ADR-006..010"
```

### 1.3 — R2 browser-PUT pre-check (do this BEFORE building attachments)

Sprint 4 is the first real browser→presigned-PUT. Prove the pipeline end-to-end in two minutes so a CORS wall doesn't surface mid-sprint.

Temporarily expose a scratch presign (or reuse a node REPL calling `getPresignedUploadUrl`) and, from `http://localhost:3000` DevTools console:

```js
// 1) get a URL (scratch route or REPL): getPresignedUploadUrl('attachments/_probe/test.pdf','application/pdf',900)
const url = "<paste presigned PUT url>";
const res = await fetch(url, { method:'PUT', headers:{'Content-Type':'application/pdf'}, body: new Blob(['probe'],{type:'application/pdf'}) });
console.log(res.status);  // expect 200
```

- **200** → CORS + signing are good; delete the probe object and the scratch route.
- **403 `SignatureDoesNotMatch`** → the `Content-Type` header didn't match the signed `ContentType`. They must be identical (locked in STEP 3 + STEP 7).
- **CORS error in console** → fix the R2 bucket CORS now (Cloudflare → R2 → bucket → **Settings → CORS policy**): allow `PUT` from `http://localhost:3000` + `https://portal.skaly.in`, `AllowedHeaders: ["Content-Type","Content-Length"]`. Per `11-THIRD-PARTY-INTEGRATIONS.md` §4.4.

### 1.4 — Confirm scope boundary (no time-logs)

Grep to be certain no phantom feature sneaks in:

```bash
grep -rn "time_log\|time-log\|timeLog" apps/api/src apps/web || echo "clean — time-logs correctly absent"
docker compose exec postgres psql -U skaly -d skaly_dev -c "\dt" | grep -i time_log || echo "no task_time_logs table — correct, out of scope"
```

### 1.5 — Branch

```bash
git checkout -b sprint-4-tasks
```

**Verify gate:** Sprint 3 green, ADRs committed, browser PUT returns 200, no time-logs, on `sprint-4-tasks`. Proceed.

---

## SPRINT 4 — STEP 2: `TaskService` — CRUD, assignment, dependency

**Goal:** The module's backend brain, executing ADR-006/008/009 and the ownership backstop in one cohesive service.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 4, STEP 2. Chassis and services from Sprints 2–3 exist. Building `TaskService`. Read `docs/07-API-CONTRACT.md` §7 (shapes + the H-03 multi-assignee note), `docs/05-BACKEND-SCHEMA.md` (`tasks` / `task_assignees` — note the SINGLE `dependency_id` self-FK and that `tasks` has **no `version` column**), `docs/08-AUTH-MATRIX.md` §4, `docs/09-ERROR-HANDLING.md` §3, and `docs/decisions/ADR-006`, `ADR-008`, `ADR-009`.
>
> **HARD CONSTRAINTS FROM THE ADRs (do not deviate):**
> - **ADR-008:** `tasks` has no `version`. Never call `BaseService.optimisticUpdate` for tasks. Task updates are plain guarded `UPDATE ... WHERE id = ? AND deleted_at IS NULL`, last-write-wins. No `version` param anywhere in this service; no `STALE_DATA`. (If you saw `version` in the API-Contract PATCH example or a `updateStatus(...,1)` test signature — those are copy-paste artifacts; ignore them.)
> - **ADR-009:** dependencies are SINGLE (`dependency_id`), not a `task_dependencies` table. The block error is `DEPENDENCY_UNRESOLVED` (HTTP 400), not `DEPENDENCY_NOT_DONE`/422.
> - **ADR-006:** `task_assigned` fires once per **newly-added, non-actor** assignee, in the same transaction as the `task_assignees` insert.
>
> **WHAT TO BUILD** — `apps/api/src/services/TaskService.ts`:
>
> 1. **`getTasks(filters, currentUser, db)`** — `filters = { period, date?, status?, clientId?, assigneeId?, priority? }`. Role scope (Auth-Matrix §4): **admin/manager/team_member all read all tasks**; **freelancer is blocked at the route** (never reaches here). `?assigneeId=` matches "staffId ∈ task_assignees for the task." Return each task with its assignees (`{ id, name, avatarUrl }[]`), attachment **count**, client name, and the derived `dependencyBlocked` boolean (true when `dependency_id` set and that task's status ≠ 'Done'). Use `softDeletable` on `tasks`. camelCase at the boundary.
>
> 2. **`getTask(id, currentUser, db)`** — single task with full assignees, attachments list, and dependency summary (for row expansion). `softDeletable`.
>
> 3. **`create(input, currentUser, db)`** — **admin/manager only** (route-gated; assert defensively). `input = { period, date, description, clientId?, assigneeIds: string[], priority?, dependencyId?, deadline?, remark? }`. One transaction:
>    a. `assertPeriodNotLocked(period, trx)`.
>    b. If `dependencyId` set → `assertNoDependencyCycle(newTaskId, dependencyId, trx)` (see #7). (A brand-new task can't be depended upon yet, so a cycle is only possible if `dependencyId` already transitively points back — the walk covers it.)
>    c. `INSERT tasks { ... , created_by: currentUser.staffId, status: 'To Do' }` (generate the id up front so assignees + cycle-check can reference it).
>    d. For each `staffId` in `assigneeIds` (dedup, validate each is an active staff): `INSERT task_assignees { task_id, staff_id, assigned_by: currentUser.staffId }`, and **within the loop**, for each assignee **≠ currentUser**, `NotificationService.create({ recipientId: staffId, type: 'task_assigned', title: description, body: 'You were assigned a task', data: { taskId, taskDescription: description, assignedBy: currentUser.staffId, dueDate: deadline ?? null, link: '/tasks?period='+period+'&highlight='+taskId }, trx })` — **ADR-006 fan-out**.
>    e. `AuditService.log({ actorId: currentUser.staffId, entity: 'tasks', entityId: taskId, action: 'INSERT', after: {...}, trx })`.
>    f. Return the full task object (with assignees).
>
> 4. **`update(id, patch, currentUser, db)`** — field edits + status transitions. `patch` may include `{ description?, clientId?, priority?, dependencyId?, deadline?, remark?, status?, result? }`. **No `version`.** One transaction:
>    a. Load task (404 `RESOURCE_NOT_FOUND` if missing/soft-deleted).
>    b. **Ownership backstop (Auth-Matrix §4):** if `currentUser.role === 'team_member'` → they may ONLY set `status` and `result`, and ONLY if they are an assignee of this task (`EXISTS task_assignees WHERE task_id AND staff_id = currentUser.staffId`). Any other field, or a non-assigned task → 403 `PERMISSION_DENIED` ("You can only update the status and result of your own assigned tasks"). admin/manager may edit any field on any task.
>    c. `assertPeriodNotLocked(task.period, trx)`.
>    d. If `patch.dependencyId` is changing → `assertNoDependencyCycle(id, patch.dependencyId, trx)`.
>    e. **Done-block (ADR-009):** if `patch.status === 'Done'` and `task.dependency_id` is set → load the dependency; if its `status !== 'Done'` → throw `AppError('DEPENDENCY_UNRESOLVED', 400, { dependencyTask: { id, description, status } })`.
>    f. Plain guarded `UPDATE tasks SET ...patch WHERE id = ? AND deleted_at IS NULL RETURNING *`.
>    g. `AuditService.log(... action: 'UPDATE', before, after ...)`.
>    h. **`dependency_resolved` (ADR-009):** if this update transitioned `status` **to 'Done'**, find every task with `dependency_id = id` (not soft-deleted) and, for each, fan out one `dependency_resolved` notification per assignee (**actor-excluded**) with `data: { taskId: dependentId, taskDescription, resolvedDependencyId: id, link: '/tasks?period='+period+'&highlight='+dependentId }`. **Do not change the dependent task's status** — the human moves it.
>    i. Return the full updated task.
>    - Expose a thin **`updateStatus(currentUser, id, status)`** that delegates to `update(id, { status }, currentUser, db)` — Testing-Strategy §4.2 calls this name (drop its stray 4th `version` arg, per ADR-008).
>
> 5. **`remove(id, currentUser, db)`** — **admin/manager only**. `assertPeriodNotLocked` → `BaseService.softDelete('tasks', id, currentUser.staffId, trx)` → `AuditService.log(action:'DELETE')`. Returns `{ deleted: true }`. (Soft delete → `deleted_at`; the `ON DELETE CASCADE` on `task_assignees` does NOT fire on soft-delete, so assignee history is preserved — correct.)
>
> 6. **`assign(id, staffIds, currentUser, db)`** / **`unassign(id, staffId, currentUser, db)`** — **admin/manager only**. `assign`: insert `task_assignees` for each **new** staffId (skip those already assigned via `ON CONFLICT (task_id, staff_id) DO NOTHING`), fan out `task_assigned` to the **newly-inserted, non-actor** ones only (never re-notify existing — ADR-006), audit. `unassign`: delete the row, audit, **no notification**.
>
> 7. **`assertNoDependencyCycle(taskId, proposedDependencyId, trx)`** — **ADR-009 cycle prevention.** Walk the `dependency_id` chain starting from `proposedDependencyId`; follow each task's `dependency_id`; maintain a **visited Set** (so it terminates even on already-dirty data). If the walk reaches `taskId` → throw `AppError('VALIDATION_ERROR', 400, { message: 'This dependency would create a cycle' })`. Cap the walk defensively at the task count. The DB `tasks_no_self_dep` CHECK remains the 1-cycle backstop.
>
> **RULES**
>
> - Every write method takes and composes inside a `trx`. Notifications/audit are inside the same transaction as the write they describe.
> - The service ownership check is the security boundary — it exists even though the UI also gates by role.
> - camelCase at the boundary, snake_case in the DB.
> - **Verify before moving on.** Build the service; STEP 5 writes the full test suite, but smoke `create` + `update(Done-block)` with one quick test before continuing.
>
> Start with `getTasks` + `create`. Show me `create` (with the fan-out loop) and `update` (with the Done-block + dependency_resolved), then `assertNoDependencyCycle`.

**Verify:**

```bash
pnpm --filter @skaly/api test services/TaskService   # a smoke subset for now
pnpm typecheck
```

---

## SPRINT 4 — STEP 3: Task attachments (ADR-007 two-point validation)

**Goal:** The presign → PUT → confirm pipeline with the server as the enforceable boundary at **both** ends, plus download and delete.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 4, STEP 3. `TaskService` core is in. Now attachments. Read `docs/07-API-CONTRACT.md` §7 (presign/confirm/download shapes), `docs/09-ERROR-HANDLING.md` §2 (`FILE_TOO_LARGE`, `INVALID_FILE_TYPE`, `TASK_ATTACHMENT_LIMIT_EXCEEDED`), `docs/decisions/ADR-007`, and `apps/api/src/lib/r2.ts` (the presign helpers + TTL constants from Sprint 2).
>
> **HARD CONSTRAINTS (ADR-007):** a presigned **PUT** cannot enforce content-length at R2, so validate at **both** ends — never UI-only.
>
> **WHAT TO BUILD** — add to `TaskService` (or a focused `TaskAttachmentService`):
>
> 1. **Constants** (from `packages/shared`): `ATTACHMENT_MAX_BYTES = 50*1024*1024`, `TASK_ATTACHMENT_TOTAL_BYTES = 200*1024*1024`, `ATTACHMENT_MIME_ALLOWLIST = ['application/pdf','image/jpeg','image/png','video/mp4','video/quicktime']`.
>
> 2. **`presignAttachment(taskId, { fileName, mimeType, fileSize }, currentUser, db)`** → validates **before** issuing a URL:
>    - task exists + not soft-deleted; period not locked; **attachment permission** (Auth-Matrix §4: admin/manager any; team_member only if an assignee of this task — else 403).
>    - `mimeType ∈ ATTACHMENT_MIME_ALLOWLIST` → else `400 INVALID_FILE_TYPE`.
>    - `fileSize ≤ ATTACHMENT_MAX_BYTES` → else `400 FILE_TOO_LARGE`.
>    - `SUM(existing task_attachments.file_size WHERE task_id) + fileSize ≤ TASK_ATTACHMENT_TOTAL_BYTES` → else `400 TASK_ATTACHMENT_LIMIT_EXCEEDED`.
>    - Build key `attachments/{taskId}/{randomUuid}_{sanitizedFileName}`.
>    - `getPresignedUploadUrl(key, mimeType, UPLOAD_EXPIRY_SECONDS)` (900s). Return `{ presignedUrl, fileKey: key }`. **The client MUST send `Content-Type: mimeType` on its PUT** — document this in the return contract.
>
> 3. **`confirmAttachment(taskId, { fileKey, fileName, mimeType, fileSize }, currentUser, db)`** → re-validates the **actual** object:
>    - Same task/lock/permission checks. Assert `fileKey` starts with `attachments/{taskId}/` (a client can't confirm someone else's key).
>    - `HeadObject(fileKey)` → read real `ContentLength`. If `realSize > ATTACHMENT_MAX_BYTES` **or** `SUM(existing) + realSize > TASK_ATTACHMENT_TOTAL_BYTES` → `DeleteObject(fileKey)` and throw the matching 400 (`FILE_TOO_LARGE` / `TASK_ATTACHMENT_LIMIT_EXCEEDED`). **No row written.**
>    - Also verify the object exists (HeadObject 404 → `400 RESOURCE_NOT_FOUND` "upload not found — retry").
>    - On pass: `INSERT task_attachments { task_id, file_name: fileName, file_key: fileKey, file_size: realSize, mime_type: mimeType, uploaded_by: currentUser.staffId }` + `AuditService.log(entity:'task_attachments', action:'INSERT')`. Return the attachment object.
>
> 4. **`getAttachmentDownloadUrl(taskId, attachmentId, currentUser, db)`** — GET path. Same read permission (admin/manager any; team_member if assignee). Load the row (404 if missing/wrong task), `getPresignedDownloadUrl(file_key, DOWNLOAD_EXPIRY_SECONDS)` (1hr). Return `{ downloadUrl }`.
>
> 5. **`deleteAttachment(taskId, attachmentId, currentUser, db)`** — admin/manager any; team_member only their **own uploaded** attachment on an assigned task. `assertPeriodNotLocked` → `DeleteObject(file_key)` → `DELETE FROM task_attachments WHERE id` → `AuditService.log(action:'DELETE')`. Return `{ deleted: true }`. (If `DeleteObject` fails, still remove the row and log a warning — an orphaned R2 object is swept by the 24h lifecycle rule; a dangling DB row would be worse.)
>
> 6. **Orphan sweep note (ADR-007):** add a `// TODO(Sprint 12 cron): sweep attachments/* objects with no matching task_attachments row older than 24h` where the R2 client is configured, and confirm/create the R2 lifecycle rule on the `attachments/` prefix (manual, Cloudflare console — note it in the step's manual checklist).
>
> **RULES**
>
> - A direct API caller can never store a disallowed/oversized file. Presign + confirm are the boundary; the browser checks are convenience.
> - The signed `ContentType` and the client's PUT `Content-Type` must match exactly.
> - **Verify before moving on.** STEP 5 tests both ends; smoke presign (bad MIME → 400) now.
>
> Show me `presignAttachment` and `confirmAttachment` (with the HeadObject orphan-delete branch).

**Verify:**

```bash
pnpm --filter @skaly/api test services/TaskAttachment   # smoke
pnpm typecheck
```

Manual: in the Cloudflare R2 console, confirm/create a **lifecycle rule** deleting objects under `attachments/` with no lifecycle tag after 24h (or note it for the Sprint 12 cron if you prefer app-side sweeping).

---

## SPRINT 4 — STEP 4: Routes + Zod schemas + registration

**Goal:** Every endpoint contract-exact, Swagger-visible, role-gated at layer 2 with the service as the deep boundary.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 4, STEP 4. Services are in. Now routes. Read `docs/07-API-CONTRACT.md` §7 and `docs/08-AUTH-MATRIX.md` §4.
>
> **WHAT TO BUILD**
>
> 1. **Zod schemas in `packages/shared/src/schemas/tasks.ts`** (shared with the frontend): `TaskQuerySchema` (`period` required `^\d{4}-\d{2}$`; optional `date`, `status` ∈ enum, `clientId` uuid, `assigneeId` uuid, `priority` ∈ enum), `TaskCreateSchema` (`{ period, date: YYYY-MM-DD, description: min(1), clientId?: uuid, assigneeIds: uuid[].default([]), priority?: enum, dependencyId?: uuid, deadline?: date, remark?: string }`), `TaskUpdateSchema` (`{ description?, clientId?, priority?, dependencyId?, deadline?, remark?, status?: enum, result?: string }` — **no `version`**; `.refine` ≥1 field present), `AttachmentPresignSchema` (`{ fileName: max(255), mimeType, fileSize: int().positive() }`), `AttachmentConfirmSchema` (`{ fileKey, fileName, mimeType, fileSize: int().positive() }`), `AssignSchema` (`{ staffIds: uuid[].min(1) }`). Status enum = `['To Do','In Progress','Blocked','Done','Cancelled']`; priority enum = `['Low','Medium','High','Urgent']`.
>
> 2. **Routes `apps/api/src/routes/tasks/`** (register in `server.ts` after attendance/holidays, per TRD §5.1):
>    - `GET /v1/tasks` — `requireRole('admin','manager','team_member')` (**freelancer → 403**). → `getTasks`.
>    - `POST /v1/tasks` — `requireRole('admin','manager')`; body `TaskCreateSchema`; 201 full task.
>    - `GET /v1/tasks/:id` — same three roles; → `getTask`.
>    - `PATCH /v1/tasks/:id` — same three roles at the route; **service enforces** team_member = status+result on own-assigned only; body `TaskUpdateSchema`; returns full task. Errors surfaced: 400 `DEPENDENCY_UNRESOLVED`, 400 `VALIDATION_ERROR` (cycle), 403 `PERMISSION_DENIED`, 423 `PERIOD_LOCKED`.
>    - `DELETE /v1/tasks/:id` — `requireRole('admin','manager')`; → `{ deleted: true }`.
>    - `POST /v1/tasks/:id/assignees` — `requireRole('admin','manager')`; body `AssignSchema`.
>    - `DELETE /v1/tasks/:id/assignees/:staffId` — `requireRole('admin','manager')`.
>    - `POST /v1/tasks/:id/attachments/presign` — three roles (service gates team_member by assignment); body `AttachmentPresignSchema`.
>    - `POST /v1/tasks/:id/attachments/confirm` — three roles; body `AttachmentConfirmSchema`; 201.
>    - `GET /v1/tasks/:id/attachments/:aid/download` — three roles (service gates); → `{ downloadUrl }`.
>    - `DELETE /v1/tasks/:id/attachments/:aid` — three roles (service gates uploader/own).
>
> 3. Ensure the presign route is covered by the **20/hr per-staff** rate limit (M-06 headers still present).
>
> **RULES**
>
> - Route `requireRole` is layer 2; the service ownership/assignment check is layer 3. Both exist.
> - Envelopes exactly per API-Contract §1.1: success `{ data, meta? }`, errors `{ error: { code, message, details? } }`.
>
> Show me the schemas, then the route file, then confirm Swagger lists them.

**Verify:**

```bash
pnpm --filter @skaly/api dev   # http://localhost:3001/docs lists all /v1/tasks* routes with schemas
pnpm typecheck
```

---

## SPRINT 4 — STEP 5: Backend test round-out + full suite

**Goal:** Every ADR + audit item this sprint owns is proven, and the whole API suite is green before touching the frontend.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 4, STEP 5. Services + routes exist. Now the full backend test suite. Read `docs/12-TESTING-STRATEGY.md` §4.2 (dependency) + §5 (RBAC), and the ADRs. Use real local Postgres, `NODE_ENV=test`.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/test/services/TaskService.test.ts`:**
>    - **Dependency block (Testing-Strategy §4.2):** `dep` In Progress, `task` depends on `dep` → `updateStatus(managerId, task.id, 'Done')` rejects `DEPENDENCY_UNRESOLVED` **with `details.dependencyTask`**. When `dep` is Done → the transition succeeds. *(No `version` arg — ADR-008.)*
>    - **Cycle prevention (ADR-009):** A→B exists; setting B's dependency to A → 400 "would create a cycle". A 3-node chain A→B→C; setting C→A → rejected. Setting a fresh task's dependency to an existing leaf → allowed.
>    - **Ownership (Testing-Strategy §5):** team_member updating an **unassigned** task → 403; updating a field other than status/result on their **own** task → 403; updating status/result on their own assigned task → success. admin/manager edit any field on any task.
>    - **H-03 fan-out (ADR-006) — the headline test:** create a task with **3** assignees (none the actor) → assert exactly **3** `task_assigned` rows, one per assignee, none combined; each payload carries `{ taskId, taskDescription, assignedBy, dueDate }`. Then `assign` **2 more** (one already assigned) → exactly **1** new `task_assigned` (only the genuinely new, non-actor assignee). Assigning the actor to themselves → **0** notifications.
>    - **dependency_resolved (ADR-009):** `task` depends on `dep`; `dep` has been assigned to X; moving `dep` → Done fires one `dependency_resolved` per assignee of `task` (actor-excluded); `task.status` is **unchanged**.
>    - **Soft delete:** `remove` sets `deleted_at`; a subsequent `getTasks` excludes it; assignee rows still exist.
>    - **Period lock:** create/update/delete on a locked period → 423.
>
> 2. **`apps/api/test/services/TaskAttachment.test.ts` (ADR-007):**
>    - presign with a disallowed MIME → 400 `INVALID_FILE_TYPE`; with `fileSize > 50MB` → 400 `FILE_TOO_LARGE`; when existing total + declared > 200MB → 400 `TASK_ATTACHMENT_LIMIT_EXCEEDED`.
>    - confirm where the **actual** `HeadObject` size exceeds 50MB (stub the S3 `HeadObjectCommand` to return an oversized `ContentLength`) → the object is `DeleteObject`-ed and 400 thrown; **no `task_attachments` row written**.
>    - confirm happy path (stubbed head size within limits) → row written with the **real** size; audit row present.
>    - team_member (non-assignee) presign → 403; team_member assignee → allowed.
>
> 3. **`apps/api/test/routes/tasks.test.ts` (Fastify `inject`):**
>    - freelancer `GET /v1/tasks` → 403.
>    - team_member `POST /v1/tasks` → 403; manager → 201.
>    - `PATCH` without any field → 400 `VALIDATION_ERROR`; with a `version` field present → the field is simply ignored (no 400 for it, but assert the response has no version and the update applied) — **regression-guards ADR-008**.
>    - rate-limit headers present on `GET /v1/tasks` and the presign route (M-06).
>
> 4. Run the **whole** API suite + typecheck + lint.
>
> **RULES**
>
> - Tests are independent and re-runnable; clean up created rows/objects.
> - Stub S3 `HeadObjectCommand`/`DeleteObjectCommand` in attachment tests (no network).
>
> Show me the H-03 fan-out test and the confirm-oversize test first, then run the suite.

**Verify:**

```bash
pnpm --filter @skaly/api test        # full API suite green
pnpm typecheck && pnpm lint
git add -A && git commit -m "Sprint 4 backend: TaskService + attachments + routes + tests (H-03, ADR-007/008/009)"
```

---

## SPRINT 4 — STEP 6: Frontend — tasks grid structure

**Goal:** The tasks page rendering per UI/UX §8 — grouped by date, collapsible, correct columns, row expansion — before mutation wiring.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 4, STEP 6. Backend done. Now the tasks grid — rendering only. Read `docs/03-UIUX.md` §8 (Tasks), §4.3 (status chips), §4.2 (cell types), and `docs/07-API-CONTRACT.md` §7 (the GET payload). Reuse the Sprint 3 chassis: `useMonthContext`, `lib/api.ts`, the `(portal)` layout, TanStack Query, Framer Motion page transition.
>
> **WHAT TO BUILD**
>
> 1. **`apps/web/app/(portal)/tasks/page.tsx`** + components under `apps/web/components/modules/tasks/` (mirror the Sprint 3 App-Router location — no `src/`):
>    - Data: `useQuery({ queryKey: ['tasks', period, filters], queryFn: () => api.get('/tasks', { period, ...filters }) })`.
>    - **Grouped by date:** group tasks by `date`, render a **collapsible** date header per group ("Mon 07 Jul" DM Mono + count). **Collapse state in Zustand + `sessionStorage`** (`store/taskGroups.ts`: `{ collapsed: Record<dateKey, boolean>, toggle }` hydrated from/persisted to `sessionStorage` — this is the real Next.js app, sessionStorage is fine here).
>    - **TanStack Table v8** per group, columns in the exact UI/UX §8 order: **Date · Client · Description · Assignees (avatar stack, overlapping 24px, +N overflow) · Status chip · Priority badge · Dependency indicator · Deadline (DM Mono) · Attachments count (paperclip + n)**.
>    - **Status chips** (§4.3): `To Do` grey · `In Progress` blue · `Blocked` red · `Done` green · `Cancelled` grey + strikethrough. **Priority badges** (reconciliation #11): `Low` grey · `Medium` blue · `High` amber · `Urgent` red.
>    - **Dependency indicator:** when `dependencyBlocked` is true, a red-tinted badge "Blocked by: {dependencyDescription}" (truncated + tooltip). When a dependency exists but is resolved, a subtle link chip.
>    - **Row expansion:** click a row → inline detail panel (Framer Motion height auto) showing `remark`, `result`, and a **placeholder "Time logs" area** labelled "coming soon" (schema-ready, out of scope — reconciliation #8). Do not build time-log inputs.
>    - **Locked period:** if the viewed month is locked, chips/fields render read-only (`<span>`), the `[+ Add task]` button is disabled with a "Period is locked" tooltip, and the Sprint 3 locked banner shows.
>    - **Empty state** (no tasks for period): Big Shoulders Display "No tasks yet" + helper.
>    - Accessibility: `role="grid"`, focus ring `outline: 2px solid var(--accent-gold)`, 44×44 targets, `aria-describedby` for the dependency badge.
>
> **RULES**
>
> - Rendering only this step — no mutations, no highlight, no create panel yet.
> - All colours/fonts via the globals.css variables; DM Mono for dates/deadlines/counts.
>
> Build it; I'll eyeball grouping, collapse persistence (reload the page — groups stay collapsed), chips, and row expansion before wiring interactions.

**Verify (manual):** grid renders from seeded tasks, grouped by date; collapse a group → reload → still collapsed (sessionStorage); status/priority colours correct; a dependency-blocked task shows the red "Blocked by" badge; row expands to remark/result + the time-logs placeholder.

---

## SPRINT 4 — STEP 7: Frontend — create panel, attachments, interactions, highlight, errors

**Goal:** Everything APPFLOW §5 specifies — the slide-in create form, status/result/assignee editing with optimistic updates, the drag-and-drop attachment pipeline with a real progress bar, the gold highlight, and ERROR-HANDLING §5.1 routing.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 4, STEP 7. Grid renders. Now interactions + create + attachments. Read `docs/04-APPFLOW.md` §5, `docs/03-UIUX.md` §4.4 (gold highlight full spec), §4.5 (modal/panel), `docs/09-ERROR-HANDLING.md` §5.1 + §5.4, and `docs/decisions/ADR-008` (no version → no stale-conflict UI for tasks) + `ADR-010` (no socket client — own-mutation refresh only). Reuse `handleMutationError`, `useColumnHighlight`, the api client.
>
> **WHAT TO BUILD**
>
> 1. **Create panel** — `[+ Add task]` (admin/manager only; API is the gate) opens a **slide-in right panel** (Framer Motion `x:'100%'→x:0`, 280ms; backdrop click / Esc / close button dismiss). Fields per APPFLOW §5: **Date** (default the group/today, constrained to the viewing period), **Description**, **Client** (from `GET /v1/clients`), **Assignees** (multi-select from `GET /v1/staff`, avatar chips), **Priority**, **Dependency** (searchable task picker within the period — exclude the task itself), **Deadline**, **Remark**. Validate with `TaskCreateSchema`. Submit → `POST /v1/tasks` → `onSuccess` invalidate `['tasks', period]` + close; map 400 cycle / 423 locked to toasts.
>
> 2. **Status edit:** click the status chip → dropdown of the 5 statuses (team_member sees it only on own-assigned rows; others always). Select → **optimistic** `useMutation`: write the new status into the `['tasks', period]` cache, `PATCH /v1/tasks/:id { status }` (**no `version`** — ADR-008), `onSuccess` replace the row with the returned task, `onError` revert + `handleMutationError`. **`DEPENDENCY_UNRESOLVED`** → the shared handler shows a warning toast **and** surfaces the dependency badge ("Blocked by: {details.dependencyTask.description}") + a shake on the chip; the optimistic change reverts.
>
> 3. **Result edit:** inline textarea in the expanded row (or a result cell) with an 800ms debounce → `PATCH { result }`, save-state dot (idle→saving→saved→error). team_member allowed on own-assigned.
>
> 4. **Assignee edit** (admin/manager): the avatar-stack cell opens a popover to add/remove assignees → `POST /v1/tasks/:id/assignees` / `DELETE .../assignees/:staffId` → invalidate. (Adding fans out `task_assigned` server-side — no client work.)
>
> 5. **Attachment panel** (paperclip → right-side panel): **drag-and-drop or click-to-browse**. Per file:
>    a. client-side convenience validation (MIME in allowlist, ≤50MB, task-total ≤200MB) — but the server is the real gate.
>    b. `POST /v1/tasks/:id/attachments/presign { fileName, mimeType, fileSize }` → `{ presignedUrl, fileKey }`.
>    c. **PUT the file via `XMLHttpRequest`** (not `fetch` — you need `xhr.upload.onprogress` for the progress bar) with header **`Content-Type: mimeType`** (must match the signed type). Show a per-file progress bar.
>    d. on PUT 200 → `POST /v1/tasks/:id/attachments/confirm { fileKey, fileName, mimeType, fileSize }` → append the returned attachment to the list + bump the grid's attachment count (invalidate `['tasks', period]`).
>    e. errors: presign 400 (type/size/limit) → toast; confirm 400 (actual oversize; server already deleted the object) → toast "File exceeded the limit — not saved."
>    - List existing attachments (name, size, uploader, date) with a download (→ `GET .../download` → open `downloadUrl`) and, for admin/manager or the uploader, a delete (→ `DELETE .../:aid` → refetch).
>
> 6. **Gold column highlight (UI/UX §4.4):** apply `useColumnHighlight` keyed by column (`'status'`, `'result'`, `'assignees'`) to those editable controls. Same five state rules as Sprint 3 including the **failure path** (overlay stays + red dot + clears 1.5s after the toast). The task grid is a grouped list (not virtualised) → use the class-based highlight, not the positioned overlay.
>
> 7. **`handleMutationError` additions** (extend `lib/mutation-errors.ts`): `DEPENDENCY_UNRESOLVED` → warning toast + dependency badge + chip shake; `VALIDATION_ERROR` (cycle) → toast with the message; reuse the existing `PERIOD_LOCKED` / `PERMISSION_DENIED` / default handling. **No `STALE_DATA` branch for tasks** (ADR-008 — tasks can't return it).
>
> 8. **Real-time (ADR-010):** **do not** build a socket subscription. Own-mutation refresh via cache replacement + invalidation is enough for the single user. Add `// TODO(Sprint 10): subscribe to task:changed on /ws/notify → invalidateQueries(['tasks', period])` where it will go.
>
> 9. **Frontend tests** (Vitest + Testing Library): create-panel validation blocks empty description; status mutation sends no `version` and replaces the row on success; `DEPENDENCY_UNRESOLVED` reverts + shows the badge; the attachment flow calls presign→PUT(xhr)→confirm in order (mock the api + a fake XHR) and appends on confirm; highlight failure-path transition.
>
> **RULES**
>
> - Task PATCH never sends `version`; there is no stale-conflict UI for tasks.
> - The PUT `Content-Type` must equal the presigned `mimeType`.
> - Build in order; show me the create panel + status mutation working before the attachment pipeline.

**Verify (manual):** create a task with 3 assignees → it appears in the right date group; check the DB for exactly 3 `task_assigned` rows. Set a dependency and try to mark the dependent Done → blocked toast + badge. Drag a PDF onto the attachment panel → progress bar → appears in the list; download opens; delete removes it. Try a >50MB file → rejected (and no R2 orphan — verify the bucket). Focus a status cell → gold column lights.

```bash
pnpm --filter @skaly/web test
```

---

## SPRINT 4 — STEP 8: Playwright smoke — create → assign → attach → transition + ownership

**Goal:** The task lifecycle proven in a real browser, plus the ownership boundary end-to-end.

### 8.1 — Test logins (manual)

Reuse the Sprint 3 `.env.test` admin + team_member. Ensure the team_member is an **assignee** of at least one seeded task (add them via the UI/API in a `beforeAll`, or seed it) so the "own-assigned edit" path is exercisable.

### 8.2 — Prompt

> **WHERE WE ARE**
>
> Sprint 4, STEP 8. Everything works by hand. Now Playwright. Read `docs/12-TESTING-STRATEGY.md` §6. Reuse the Sprint 3 `loginAs` helper + `playwright.config.ts` (`baseURL` from env).
>
> **WHAT TO BUILD** — `tests/e2e/tasks.spec.ts` (add `data-testid`s as needed):
> 1. **Lifecycle (admin):** open `/tasks` → `[+ Add task]` → fill description, pick a client, add an assignee, set a deadline → submit → the task appears in the correct date group with the assignee avatar. Open it → set status via the chip dropdown → the chip updates.
> 2. **Dependency block (admin):** create task B depending on task A (A not Done) → attempt to set B → Done → assert the blocked toast/badge appears and B's status did **not** change. Mark A Done → B can now go Done.
> 3. **Ownership (team_member):** as the assigned team_member — the status chip on their **own assigned** task is operable; on an **unassigned** task the chip is not editable (assert), and a direct `page.request.patch('/v1/tasks/{unassignedId}', { data: { status: 'Done' } })` with the team_member token returns **403**. A field other than status/result (e.g. `description`) via API → **403**.
> 4. **Attachment (admin):** upload a small PDF via the panel (Playwright `setInputFiles` on the hidden file input, or drive the presign→PUT→confirm through the UI) → it appears in the list; download link resolves; delete removes it.
> 5. Run headed once, then headless (chromium + webkit).
>
> **RULES:** independent, re-runnable, clean up created tasks/attachments.
>
> Show me the spec, then run `pnpm exec playwright test tests/e2e/tasks.spec.ts --headed`.

**Verify:**

```bash
pnpm exec playwright test tests/e2e/tasks.spec.ts    # green, chromium + webkit
```

---

## SPRINT 4 — STEP 9: End-to-end smoke + commit + close-out (manual)

### 9.1 — Full manual walk-through

```bash
docker compose up -d && pnpm dev
```

1. **Admin:** create tasks across several dates → groups form; collapse one → reload → stays collapsed. Assign 3 people to a task → `SELECT type,title FROM notifications WHERE type='task_assigned' ORDER BY created_at DESC LIMIT 5;` shows **3** rows.
2. **Dependency:** B depends on A; mark B Done → blocked (badge + toast); mark A Done → a `dependency_resolved` row lands for B's assignees (`SELECT type FROM notifications WHERE type='dependency_resolved' ORDER BY created_at DESC LIMIT 3;`); B still not auto-Done; now move B → Done manually → succeeds.
3. **Cycle:** try to set A's dependency to B while B→A exists → "would create a cycle" rejected.
4. **Attachments:** upload a PDF (progress bar), an MP4; download both; delete one; try a `.exe` → rejected at presign; try a >50MB file → rejected (verify no R2 orphan: bucket has no dangling object).
5. **Team member** (assigned): edits status/result on own assigned task; cannot touch an unassigned task (UI inert + API 403); cannot edit description on own task (API 403).
6. **Freelancer:** `/tasks` in the sidebar is absent; direct `GET /v1/tasks` with a freelancer token → 403.
7. **Locked month:** lock the prior month → tasks read-only, `[+ Add task]` disabled, PATCH → 423.
8. **Audit:** `SELECT staff_id, changed_by_source, table_name, action FROM audit_log WHERE table_name IN ('tasks','task_attachments') ORDER BY created_at DESC LIMIT 10;` — INSERT/UPDATE/DELETE present, `staff_id` never NULL.

### 9.2 — Close-out checklist

Do not start Sprint 5 until **every** box is checked:

```
PRE-SPRINT ADRs EXECUTED
  [ ] ADR-006..010 committed to docs/adr
  [ ] R2 browser-PUT pre-check passed (200) before attachments were built
  [ ] Time-logs confirmed out of scope — no task_time_logs table, no time-log code

BACKEND — TaskService
  [ ] getTasks role scope: admin/manager/team_member read all; freelancer blocked at route; assigneeId matches "one of"
  [ ] create: assignees inserted + dependency cycle-checked; one transaction
  [ ] update: last-write-wins, NO version, NO STALE_DATA (ADR-008); optimisticUpdate never called on tasks
  [ ] update ownership backstop: team_member = status+result on own-assigned only — 403 otherwise (TESTED)
  [ ] Done-block: DEPENDENCY_UNRESOLVED (400) with details.dependencyTask (TESTED)
  [ ] Cycle prevention: bounded walk rejects A→B→…→A at write time (TESTED)
  [ ] dependency_resolved fires per assignee (actor-excluded) on Done; dependent status unchanged (TESTED)
  [ ] task_assigned fan-out: N notifications for N newly-added non-actor assignees; assign adds only-new; self-assign = 0 (TESTED — H-03)
  [ ] remove: soft-delete via BaseService.softDelete; assignee rows preserved; excluded from getTasks

BACKEND — Attachments (ADR-007)
  [ ] presign validates MIME + ≤50MB + task-total ≤200MB before issuing URL (TESTED)
  [ ] confirm HeadObject re-validates actual size; oversize → DeleteObject + 400, no row (TESTED)
  [ ] download = GET presigned (1hr); delete removes R2 object + row
  [ ] team_member attachment access gated by assignment; key convention attachments/{taskId}/{uuid}_{name}
  [ ] R2 lifecycle sweep (or Sprint 12 cron TODO) for unconfirmed objects noted

ROUTES
  [ ] All §7 endpoints contract-exact; freelancer GET → 403; PATCH ignores stray version (ADR-008 regression)
  [ ] Swagger lists every /v1/tasks* route; rate-limit headers present incl. presign (M-06)

FRONTEND
  [ ] Grid grouped by date, collapsible, collapse persisted to sessionStorage
  [ ] Column order per UIUX §8; status + priority chip colours correct; dependency "Blocked by" badge
  [ ] Row expansion shows remark/result + time-logs placeholder (not built)
  [ ] Create slide-in panel: full fields, period-constrained date, dependency picker excludes self, cycle/lock toasts
  [ ] Status optimistic edit: no version sent; row replaced on success; DEPENDENCY_UNRESOLVED reverts + badge + shake
  [ ] Result debounce edit (800ms); assignee add/remove popover
  [ ] Attachment panel: drag-drop, XHR PUT with matching Content-Type + progress bar, presign→PUT→confirm order, download, delete
  [ ] Gold highlight on status/result/assignees incl. failure path; class-based (not overlay)
  [ ] handleMutationError: DEPENDENCY_UNRESOLVED + cycle handled; NO STALE_DATA branch for tasks
  [ ] No frontend socket client (ADR-010); // TODO(Sprint 10) markers present

TESTS
  [ ] TaskService + TaskAttachment + route suites green
  [ ] Frontend hook/component tests green (create validation, status mutation no-version, attachment order, highlight)
  [ ] Playwright: lifecycle + dependency block + ownership (UI inert AND API 403) + attachment — chromium & webkit
  [ ] pnpm typecheck + pnpm lint clean
```

### 9.3 — Final commit

```bash
git add -A
git commit -m "Sprint 4: Work Allocation — Tasks (CRUD, assignment, attachments, dependencies) — H-03, ADR-006/007/008/009/010"
git push -u origin sprint-4-tasks
```

Open the PR to `main`; CI must be fully green before merge. Merge, then `git checkout main && git pull`.

### 9.4 — Move to Sprint 5

Open `MASTER-BUILD-GUIDE-V2-FINAL.md` → PART 9 → **SPRINT 5 — SHOOT PLANNER**, or the forthcoming `SPRINT-5-DETAILED.md`.

Sprint 5 reuses this module's chassis (grid + service + notifications + the presign pattern is not needed there) and introduces: **freelancer data isolation** (query-level `WHERE freelancer_id = self`, Auth-Matrix §8), **Trigger 1** (`shoot:confirmed` → Content Dropper — **emit** in Sprint 5 per ADR-010, listener wired in Sprint 6), and the **slot reset** flow (`POST /v1/shoot-planner/:id/reset` requires `{ confirm: true }` → `SHOOT_RESET_CONFIRMATION_REQUIRED` otherwise). Note `shoot_schedules` is **not** a versioned table (audit C-02) — like tasks, slot edits are last-write-wins.

If any close-out box is unchecked, **stop**. Sprints 5–7 photocopy this module's patterns.

---

## DECISIONS TO MAKE BEFORE SPRINT 5

- **Trigger 1 emit-now / consume-Sprint-6 (confirm ADR-010 applies):** Sprint 5's shoot confirmation must `EventBus.emit('shoot:confirmed', { clientId, period, slotDate })` **after commit**, even though the Content Dropper listener isn't wired until Sprint 6. Same "emit now, consume later" contract as ADR-010. Lock it so Sprint 5 doesn't skip the emit or try to build the Dropper side early. *(Recommendation: emit in Sprint 5; the Sprint 2 EventBus already declares the event.)*
- **Freelancer isolation is query-level, not post-filter (Auth-Matrix §8):** the shoot-planner GET for a freelancer must add `WHERE freelancer_id = currentUser.staffId` **before** the query executes — never fetch-all-then-filter. Confirm this is the pattern (it mirrors the attendance ownership boundary) so freelancer data isolation is airtight from the first shoot endpoint. Consider whether an **ADR-011** is worth recording (freelancer row-level isolation as a standing rule reused by dashboard + search).
- **Shoot slot `slot_status` enum + reset semantics:** `reset` returns a slot to `Unset` and clears date/pieces/freelancer — confirm it also clears any `coming_shoot_date` it previously pushed to `content_pipelines` (or that the Trigger handles staleness). Decide the exact reset side-effects **before** building, since it interacts with Trigger 1.
- **Shoot slots are not versioned (confirm):** like tasks, `shoot_schedules` has no `version` column (audit C-02 lists only three versioned tables). Lock last-write-wins for slot edits so Sprint 5 doesn't reach for `optimisticUpdate`.
- **Still deferred, on schedule:** frontend socket client + all bell notifications (Sprint 10), `resolvePermission` (Sprint 8), MFA enrollment wiring (ADR-002 → Sprint 8), attachment orphan cron (Sprint 12).

---

## TROUBLESHOOTING — SPRINT 4 SPECIFIC

### `PATCH /v1/tasks/:id` fails with "column version does not exist"
You reused the attendance `optimisticUpdate` path for tasks. Tasks have no `version` (ADR-008). Use a plain guarded `UPDATE ... WHERE id = ? AND deleted_at IS NULL`. Drop any `version`/`expectedVersion` from the task update signature, the Zod schema, and the frontend PATCH body.

### `DEPENDENCY_NOT_DONE` / 422 shows up somewhere
That's the Master Guide's wrong code. The canonical code is `DEPENDENCY_UNRESOLVED` at **HTTP 400** (Error-Handling §2/§3, Testing-Strategy §4.2). Fix the throw and the frontend handler switch.

### Cycle-prevention walk hangs
Your walk followed `dependency_id` links without a visited Set and hit a pre-existing cycle. Track visited ids and cap the walk at the task count (ADR-009). Better: this can't happen going forward because you now reject cycles at write time — but keep the guard for already-dirty data.

### Assigning more people re-notifies everyone
The fan-out looped over **all** assignees instead of the **newly-inserted** ones. Use `ON CONFLICT (task_id, staff_id) DO NOTHING` and notify only the rows that were actually inserted, excluding the actor (ADR-006).

### Presigned PUT returns 403 `SignatureDoesNotMatch`
The browser's PUT `Content-Type` header doesn't match the `mimeType` you signed into the presigned URL. Send exactly the same string on both. (This is why STEP 1.3 pre-checks it.)

### A big file uploads to R2 but confirm rejects it — is the object orphaned?
Confirm's `HeadObject` branch must `DeleteObject` the key **before** throwing (ADR-007). If you see orphans, the delete isn't running on the reject path. The 24h lifecycle rule is the safety net, not the primary mechanism.

### `fetch()` upload has no progress bar
`fetch` has no upload-progress event (still true in 2026). Use `XMLHttpRequest` for the PUT and read `xhr.upload.onprogress`. Everything else can stay on the api client.

### team_member can edit a task's description
The ownership backstop only checked assignment, not the **field set**. team_member is restricted to `status` + `result` — reject any other field with 403 even on their own assigned task (Auth-Matrix §4). The API test must cover the "own task, wrong field" case.

### Collapsed date groups reset on reload
The collapse store isn't persisting to `sessionStorage` (or is reading `localStorage`, which the Impl-Plan didn't specify). Hydrate from and write to `sessionStorage` on toggle. (This is your real Next.js app — `sessionStorage` is fine here, unlike inside a Claude artifact.)

### Time-log endpoints/tables appear
They shouldn't — there's no `task_time_logs` table and they're out of scope (reconciliation #8). If Antigravity scaffolded them from the API-Contract §7 note, delete them; leave the row-expansion "time logs" area as a labelled placeholder only.

### Soft-deleted task's assignees vanished
You hard-deleted (or the `ON DELETE CASCADE` fired). Tasks are **soft**-deleted (`deleted_at`) via `BaseService.softDelete` — the cascade only fires on a real `DELETE`, which you never issue. Confirm `remove` sets `deleted_at`, and `getTasks` uses `softDeletable`.

---

## END OF SPRINT 4 DETAILED GUIDE

*Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1/2/3-DETAILED.md`. Source-of-truth precedence when documents differ: the numbered spec docs (`01`–`14`) + the schema win, then this guide's reconciliations and the ADRs it executes (006–010), then the Master Build Guide's shorthand. Sprint 5 (Shoot Planner) builds on this chassis and introduces freelancer isolation + the first cross-module trigger emit.*
