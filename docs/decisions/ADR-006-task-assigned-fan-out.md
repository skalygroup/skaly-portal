# ADR-006 — `task_assigned` notifications fan out per assignee

**Status:** Accepted • Pre-Sprint 4 (build impact: Sprint 4)
**Cross-refs:** Audit H-03 · `05-BACKEND-SCHEMA.md` (`task_assignees`, `notifications`) · Sprint 2 `NotificationService`

## Decision
One `task_assigned` notification is written **per assignee** — never a single combined notification addressed to many. `NotificationService.create` (Sprint 2) is already per-recipient, so this is a loop over the inserted `task_assignees` rows, not a new mechanism.

## Triggers (precise)
- **On task create:** one notification per assignee in the initial set.
- **On task update that ADDS assignees:** notify **only the newly-added** assignees. Existing assignees are not re-notified; removing an assignee fires nothing.
- **Actor excluded:** if the acting user assigns a task to themselves, they receive no `task_assigned` for their own action (consistent with never notifying a user of their own write).

## Rule
Assignment notifications are emitted inside the same transaction path as the `task_assignees` insert: write the assignee row(s) → within the loop, `NotificationService.create` once per **new, non-actor** assignee. The row-write + `notify:new` emit both happen in Sprint 4 (the emit is forward-wiring for the Sprint 10 client, per ADR-010). The Sprint 4 test asserts exactly **N notifications for N newly-added, non-actor assignees**.

## Rationale
A combined notification would (a) leak the full assignee roster to every recipient and (b) collapse per-user read-state and deep-linking into one shared row. Per-assignee rows keep each person's bell and read-state independent and match the schema's per-recipient `notifications` table. The row must be written when the assignment happens (you cannot reconstruct "who was assigned, when" after the fact), so it is written in Sprint 4 even though the bell UI that displays it lands in Sprint 10.
