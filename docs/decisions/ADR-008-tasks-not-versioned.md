# ADR-008 — Tasks are not optimistically locked (last-write-wins)

**Status:** Accepted • Pre-Sprint 4 (build impact: Sprint 4)
**Cross-refs:** `05-BACKEND-SCHEMA.md` `tasks` (no `version` column) · Audit C-02 · `BaseService.optimisticUpdate` (Sprint 2)

## Decision
The `tasks` table has **no `version` column** — unlike `attendance_logs`, `content_pipelines`, and `content_calendar`. Task updates therefore use a plain guarded `UPDATE ... WHERE id = ? AND deleted_at IS NULL`, **last-write-wins**. No optimistic locking, **no `STALE_DATA` (409) on task edits**. `BaseService.optimisticUpdate` is **not** used for tasks — calling it would fail, there is no version to check.

## Rule
Task `PATCH` does **not** send or expect a `version` field, and the frontend has no stale-conflict UI for tasks. The C-02 optimistic-lock pattern applies **only** to the three versioned tables. If lost-update protection is ever needed for tasks, it is introduced via a **new migration** that adds `version` — never retrofitted ad hoc at a call site.

## Rationale
Tasks are not cell-contended the way an attendance cell or a calendar cell is: a task's `status`/`result` is edited by its assignee, its other fields by a manager/admin — concurrent edits to the *same* task are rare, a clobbered `remark` is low-severity, and every write is audit-logged. The spec deliberately omitted a version column here; honouring that keeps the task update path simple and avoids a phantom 409 surface the frontend would otherwise have to handle for no real gain.
