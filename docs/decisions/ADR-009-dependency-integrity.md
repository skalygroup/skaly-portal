# ADR-009 — Task dependency integrity: cycle prevention + resolution notification

**Status:** Accepted • Pre-Sprint 4 (build impact: Sprint 4)
**Cross-refs:** `05-BACKEND-SCHEMA.md` `tasks` (`dependency_id`, `tasks_no_self_dep`) · `09-ERROR-HANDLING.md` (`DEPENDENCY_UNRESOLVED`) · `05-BACKEND-SCHEMA.md` `notifications` (`dependency_resolved`) · `04-APPFLOW.md` §5

## Context
The DB constraint `tasks_no_self_dep CHECK (dependency_id IS DISTINCT FROM id)` blocks only the trivial 1-cycle (`A→A`). A longer cycle (`A→B→A`, `A→B→C→A`) is **not** blocked by the schema and would make `DEPENDENCY_UNRESOLVED` unsatisfiable — every task in the cycle becomes permanently un-completable (deadlock: each is blocked by the next).

## Decision
**1. Cycle prevention (write-time, service layer).** When creating a task with a `dependency_id`, or updating an existing task's `dependency_id`, walk the dependency chain starting from the *proposed* dependency, following `dependency_id` links. If the walk reaches the task being edited → reject with `400 VALIDATION_ERROR` ("This dependency would create a cycle"). The walk is **bounded** (track visited ids) so it terminates even if data is somehow already dirty. The DB `tasks_no_self_dep` check stays as the last-resort 1-cycle backstop.
  - *Note:* a brand-new task can't yet be depended upon, so a cycle is only reachable when **setting a dependency on a task other tasks already (transitively) depend on** — the walk covers both create and update correctly.

**2. Completion block (already specified).** A task cannot move to `Done` while its `dependency_id` task is not `Done` — `400 DEPENDENCY_UNRESOLVED` with `details.dependencyTask`.

**3. Resolution notification.** When a task transitions to `Done`, every task whose `dependency_id` points at it fires **one `dependency_resolved` notification per assignee** of the dependent task (actor-excluded, per ADR-006's fan-out rule). Status is **not** auto-changed — the human moves the now-unblocked task; the notification just tells them they can.

## Rule
Dependency edges are validated for acyclicity at write time; dependency completion **notifies** downstream assignees but never **mutates** their task's status. Cycle prevention and the resolution notification are both tested in Sprint 4.

## Rationale
A recursive DB trigger could enforce acyclicity but is opaque and hard to test; a service-layer walk is explicit, testable, and runs at the only moment an edge changes. Auto-transitioning a dependent task's status on resolution would take control away from the assignee and could, e.g., reopen a `Cancelled` task — a notification is the correct, non-destructive signal.
