# ADR-032 — Comment visibility is one shared predicate

**Status:** Accepted • Pre-Sprint 12
**Cross-refs:** `07-API-CONTRACT.md` (`/v1/comments`, `/v1/search`, audit **H-06**) ·
`08-AUTH-MATRIX.md` §3 · `04-APPFLOW.md` §13 · `05-BACKEND-SCHEMA.md` (migration `022`,
`025`) · ADR-011 (freelancer isolation) · ADR-015 (search parity) · ADR-021 (single
mechanism per question)

> **Numbering note.** The Sprint 12 guide calls the notification registry ADR-017 and the
> single-resolver discipline ADR-018. Both are shifted: the registry is **ADR-020**, and
> the archive/single-mechanism ADR is **ADR-021**. See ADR-026's note.

## Context

Sprint 9 shipped `SearchService.searchComments` against a table with no write path, so the
`comments` category has returned rows only from hand-seeded fixtures for three sprints.
Sprint 12 adds `GET /v1/comments`, which makes the visibility rule load-bearing in two
services at once. If they drift, one direction leaks a row and the other hides a reply the
reader was notified about — and only the hiding failure is ever visible.

**Sprint 11 already extracted the predicate** to `apps/api/src/lib/comment-visibility.ts`,
and `SearchService` already imports it. Sprint 12 does not create it. Sprint 12 adds the
**second consumer** (`CommentService.list`) — which is the event that makes "one function"
mean something, and which surfaced the two defects recorded below.

## What the census found (Sprint 12 STEP 1.2)

1. **`comments.record_id` is a `client_id`, not a row id.** Audit H-06 (API-Contract, POST
   `/v1/comments`) states it soft-references `shoot_schedules.client_id`,
   `content_pipelines.client_id`, or `content_calendar.client_id` depending on `module`.
   APPFLOW §13 agrees — the comment box opens from the 💬 icon **at the end of a grid
   row**, and every one of the three grids is one row per client per period.
   The shipped predicate joins `shoot_schedules.id = comments.record_id`. That match never
   succeeds against a real write, so **every freelancer sees zero comments**. It fails
   safe, which is exactly why three sprints did not catch it: the seeded test writes a slot
   id into `record_id` and so agrees with the bug.
2. **The table has no `parent_id` and no `deleted_at`.** There is no comment threading and
   no soft delete in the canonical schema — there is an **acknowledge** flow
   (`acknowledged_by` / `acknowledged_at`, `PATCH /v1/comments/:id/acknowledge`,
   admin/manager) that the sprint guide omits entirely.
3. **Comments exist in three modules only** — `shoot_planner`, `content_dropper`,
   `content_calendar` (CHECK constraint, migration `022`). **Not tasks.**

## Decision

1. **ONE function, `commentVisibility(currentUser)`**, returning a Kysely `WHERE` fragment
   in `apps/api/src/lib/comment-visibility.ts`. `CommentService.list` and
   `SearchService.searchComments` both import and apply it. Not "the same logic in two
   places" — the same function.

2. **The rule** (author role JOINed at read time, never denormalised onto the comment row):

   | Role | Sees |
   |---|---|
   | `admin` / `manager` | every comment |
   | `team_member` | own, **plus** admin/manager comments on a record they have themselves commented on |
   | `freelancer` | comments on `shoot_planner` rows they are assigned a slot in — **any author** |

   The `team_member` branch keeps the *same-record* qualifier. API-Contract ("own +
   manager/admin **replies**"), APPFLOW §13 ("own comments + all manager/admin replies **in
   same record**") and ADR-015 §2 all carry it. An unqualified `author.role IN
   ('admin','manager')` — as the Sprint 12 guide's draft proposed — would show every team
   member every supervisor comment in the portal. That is a leak, and it is the direction
   that does not announce itself.

   The `freelancer` branch is scoped **by shoot row, not by authorship**: APPFLOW §13
   notifies the assigned freelancer of every new comment on their shoot, so author-scoping
   would point that notification at a row they cannot read (ADR-015 §2 — stricter than the
   owning service is still a parity break, it just fails safe).

3. **The freelancer branch matches on `client_id` + `period`**, per H-06:

   ```
   EXISTS (SELECT 1 FROM shoot_schedules s
           WHERE s.client_id = comments.record_id
             AND s.period    = comments.period
             AND s.freelancer_id = :self)
   ```

   `period` is part of the match because `record_id` alone identifies a client, not a
   client-month, and a freelancer's assignment ends when the period does — the same
   boundary `ShootPlannerService.getGrid` already enforces.

4. **Record-visibility is a PRECONDITION that composes.** You cannot comment on, or read a
   comment on, a record you cannot read. For `team_member` on shoot-planner and
   content-calendar this is satisfied by Auth-Matrix §3 (👁 + comments); `content_dropper`
   is admin/manager only, so a team_member has no reachable comment there. For
   `freelancer` it is the isolating filter, and shoot-planner is their only module.

5. **`new_comment` is a notification TYPE delivered via `notify:new`** — not a
   `comment:new` socket event (the `report_ready` mistake Sprint 11 caught). Recipients per
   **APPFLOW §13**, which is the spec and differs from the sprint guide's "assignee + prior
   commenters":

   - every `admin` and `manager`, always;
   - plus, when `module = 'shoot_planner'`, every freelancer assigned a slot in that
     client-row;
   - **never the author** (ADR-006), even when the author is an admin.

   `linkBuilder` returns an in-app route to the record. The registry entry already enforces
   this — it is the one builder that takes its address from the payload, and it returns
   `null` for anything that is not a portal-relative path (audit M-08).

6. **No threading, no soft delete, no `tasks` module.** The schema has none of them, and
   Sprint 12 adds no column to get them. `DELETE /v1/comments/:id` is not in the API
   contract and is not built; the acknowledge flow that *is* in the contract is.

## Rule

> Search returns exactly the comments the module panel shows the same user. A parity test
> asserts row-set equality — it was seeded-only until this sprint, and the seed agreed with
> a bug for three of them.
