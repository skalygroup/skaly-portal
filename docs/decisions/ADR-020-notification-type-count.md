# ADR-020 — Notification types: 18, sourced from the schema enum

**Status:** Accepted • Pre-Sprint 10 (build impact: Sprint 10 STEP 4 + STEP 8)
**Cross-refs:** `05-BACKEND-SCHEMA.md` (`notifications_type_check`, migration `021_notifications.ts`) ·
`02-TRD.md` §10.1 · `01-PRD.md` FR-NOTIF-02 (stale, patched here) ·
`06-IMPLEMENTATION-PLAN.md` §13 (stale, patched here) · ADR-006

> **Numbering note.** The Sprint 10 guide calls this ADR-017. That number was taken by
> `ADR-017-client-onboarding-atomicity` during Sprint 9, as were 018 and 019. Sprint 10's four
> rulings are recorded as **020–023**; the guide's 017→020, 018→021, 019→022, 020→023.

## Context

The schema and TRD §10.1 say **18** notification types. The PRD and Implementation Plan say
**14**. Source-of-truth precedence gives it to the schema, and migration `021_notifications.ts`
is unambiguous — `notifications_type_check` lists exactly 18 values.

The discrepancy is explained, not arbitrary. Four of the 18 are system-generated rather than
user-facing: `month_ready` and the three `rollover_*` types. **18 − 4 = 14.** The PRD counted
the notifications a human causes and skipped the ones the system raises to itself.

An explained discrepancy stays fixed. A declared winner reseeds.

## Census as found (Sprint 10 STEP 1.3)

The guide's expected census assumed 12 types already had producers. The repo had **five**.
Six types whose owning sprints (2, 3, 4, 6) have already shipped were never wired to
`NotificationService`. Five of those turned out to be a delivery gap; the sixth
(`account_reactivated`) turned out to be a genuine deferral — see the correction below the
table:

| Type | Producer | Owning sprint | Status at STEP 1.3 |
|---|---|---|---|
| `task_assigned` | `TaskService.create` / `.update` | 4 | ✅ built (`TaskService.ts:291`, `:485`) |
| `dependency_resolved` | `TaskService.update` | 4 | ✅ built (`TaskService.ts:677`) |
| `shoot_confirmed` | `ShootPlannerService.update` | 5 | ✅ built (`ShootPlannerService.ts:261`) |
| `signup_request` | signup flow | 1–2 | ✅ built (`AuthService.ts:475`) |
| `signup_approved` | approve flow | 2 | ✅ built (`AuthService.ts:608`) |
| `task_overdue` | overdue sweep | 4 | ⚠️ **gap — built in Sprint 10** |
| `holiday_added` | `HolidayService.create` | 3 | ⚠️ **gap — built in Sprint 10** |
| `holiday_removed` | `HolidayService.remove` | 3 | ⚠️ **gap — built in Sprint 10** |
| `signup_rejected` | reject flow | 2 | ⚠️ **gap — built in Sprint 10** |
| `account_reactivated` | staff reactivate | ~~2~~ **11** | ⏸ **deferred — see the correction below** |
| `client_updated` | `ClientService` name update | 6 | ⚠️ **gap — built in Sprint 10** |
| `mention` | chat mentions | **10 — this sprint** | built in Sprint 10 |
| `report_ready` | report generation | 11 | ⏸ deferred |
| `new_comment` | comment system | 12 | ⏸ deferred |
| `month_ready` | rollover | 12–13 | ⏸ deferred |
| `rollover_success` | rollover | 12–13 | ⏸ deferred |
| `rollover_failed` | rollover | 12–13 | ⏸ deferred |
| `rollover_view_refresh_failed` | rollover | 12–13 | ⏸ deferred |

`HolidayService` was broadcasting `attendance:holiday_added` / `:holiday_removed` over the
socket without ever writing a notification row — a socket event and a notification are
different mechanisms, and having one is not having the other. `ClientService` did not import
`NotificationService` at all.

### Correction found while building (Sprint 10 STEP 4): it was five gaps, not six

`account_reactivated` was counted with the other five because its owning sprint had
shipped. It is not the same kind of thing. The other five each had a **write path already
running** that simply never called `NotificationService` — `HolidayService.create` was
broadcasting `attendance:holiday_added` over the socket while writing no row, and
`ClientService` did not import the service at all. Adding the producer was one call at a
place that already existed.

`account_reactivated` has **no write path at all**. `StaffService` is read-only — three
getters, no mutations — and there is no staff *deactivate* either, let alone reactivate.
Its producer is not a missing call; it is a missing feature, and that feature is Sprint
11's Settings → Staff. Building it here would mean building staff lifecycle management to
satisfy a coverage count, which is precisely what decision 4 below forbids.

It is therefore reclassified from **gap** to **deferred, owned by Sprint 11**, alongside
`report_ready`.

**After Sprint 10 closes the five real gaps: 11 with producers, 7 deferred, 18 total.**

### `signup_rejected` has no applicant-facing recipient, by construction

Recorded because the type name invites the opposite assumption. Someone reading the enum
in six months will see `signup_rejected`, conclude the applicant is told, and "fix" it.

**The applicant cannot receive it.** `notifications.staff_id` is a NOT NULL FK to
`staff(id)`; rejection never creates a staff row; and operational notifications are in-app
only (email is Supabase's auth flow, not a channel this system sends on). There was no
applicant-facing delivery path to choose. The alternatives were a nullable `staff_id` plus
a pending-recipient concept — a migration for one type — or parking it with the deferred,
which would be dishonest since the producer exists and fires.

**It routes to the NON-ACTOR admins.** The loop opens with admins (`signup_request`) and
closes with them, which is coherent rather than a workaround, and it carries real
operational value independent of any coverage test: with more than one admin, B needs to
know A already handled it, or B opens the queue, finds it empty, and wonders what broke.
The audit log answers that on a pull; a notification answers it on a push.

Excluding the actor is ADR-006's non-actor rule generalised — the detail most often missed
when a notification is redirected to a group containing whoever triggered it.

**Consequence, accepted:** with a single admin the recipient set is empty and the type
produces nothing. That is correct (telling you what you just did is noise), and it may be
the MVP reality. Both the two-admin fixture and the zero-row single-admin case are
asserted in `test/services/NotificationProducers.test.ts` so neither is discovered later
as a bug.

**`rejection_note` is audit-only.** The payload carries `publicRejectionMessage`. A payload
is the least-guarded thing this system sends, and the internal note must never ride it.

**The deep link needs the filter, not just the page.** The queue defaults to *pending*, and
a rejected request is by definition no longer there — so `linkBuilder` produces
`/settings/signup-requests?status=rejected&highlight={requestId}`.

> **Out of scope, and named so it is not lost:** none of this tells the *applicant*
> anything. A rejected or still-pending applicant learns nothing from any channel. If
> self-signup creates the Supabase auth user up front, both can authenticate and then fail
> the `supabase_uid` → staff lookup, and Error-Handling §2 has no `SIGNUP_PENDING` or
> `SIGNUP_REJECTED` to distinguish them — both land on a generic auth failure. The
> applicant's whole experience is submitting a form and then being unable to log in, with
> no explanation, indefinitely. That is almost certainly what this type was originally
> gesturing at, and routing it to admins does not close it. The fix is small (two error
> codes plus a login-screen message keyed off the `signup_requests` row) but it belongs at
> the **pre-launch gate**, beside the recovery-code redeem path — not squeezed into
> Sprint 10.

## Decision

1. **The canonical count is 18.** `PRD` §4.9 (FR-NOTIF-02) and `IMPL-PLAN` §13 are patched
   from 14 to 18 in the same commit as this ADR.

2. **The five shipped-sprint gaps are closed in Sprint 10**, not carried. Their write paths
   already exist; each is one `NotificationService.create()` call at a place that already runs.
   `task_overdue` is the exception in shape — it needs a sweep, not a write-path hook — and its
   service method is built and tested here even though Sprint 12 owns the cron that calls it.

3. **The MVP coverage test asserts every type WITH a producer** (11 after Sprint 10) and
   **enumerates the deferred seven by name with their owning sprint**. A bare "18 tested" would
   force inventing emitters for types whose producers do not exist yet.

4. **The deferred list is asserted, not commented.** `expect(DEFERRED).toHaveLength(7)` fails
   when Sprint 11 adds `report_ready`. Updating it then is the intended workflow, not a
   regression.

5. **No enum value is added for ordinary chat messages.** Chat delivers via socket; only
   `@mentions` create a notification row. The enum is a CHECK constraint — adding a value is a
   migration, and doing so for chat would be scope drift.

6. **The registry mirrors the enum, and a test asserts set equality in both directions.** A
   registry entry without an enum value fails, and an enum value without a registry entry fails.
   That symmetry is the drift guard; without it the two lists diverge silently.

## Rule

The enum is the count. Any doc that disagrees is patched, not worked around.

A type with no producer is named and dated, never invented. If a coverage test can only pass
by writing an emitter that no feature calls, the test is wrong, not the feature.
