# ADR-012 — Trigger 1 recompute: orthogonal write + rollover refresh

**Status:** Accepted • Pre-Sprint 6 (build impact: Sprint 6 + Sprint 12)
**Cross-refs:** ADR-010 · `05-BACKEND-SCHEMA.md` `content_pipelines` (`version`, `coming_shoot_source`) · Audit C-02 · Audit M-04 (calendar manual guard)

## Context
`content_pipelines` is versioned for concurrent **user** edits of the stage columns.
The Trigger 1 listener (`shoot:confirmed` / `shoot:reset`) writes `coming_shoot_date` —
a system projection on a **different** column.

## Decision

1. **RECOMPUTE (not push):** `coming_shoot_date = MIN(slot_date)` over `shoot_schedules`
   WHERE `client_id`, `period`, `slot_status = 'Confirmed'`, `slot_date >= CURRENT_DATE`.
   `NULL` if none. Never naive-`SET` to the event's `slotDate` (breaks on reset +
   multi-slot clients).
2. **GUARD:** write only if `coming_shoot_source IN (NULL, 'trigger')` — never clobber a
   `'manual'` override (mirrors calendar M-04). Set `coming_shoot_source = 'trigger'`.
3. **ORTHOGONAL WRITE:** the recompute is a targeted `UPDATE` of `coming_shoot_date` +
   `coming_shoot_source` that does **NOT** bump `content_pipelines.version`. It touches a
   column orthogonal to the user-edited stage fields, so it must not cause a false
   `STALE_DATA` on a concurrent stage PATCH. Only **user** writes (stage PATCH, manual
   `coming_shoot_date` override) use `optimisticUpdate` and bump `version`.
4. **TIME-STALENESS:** because recompute is event-driven, a confirmed shoot date passing
   with no new event leaves the stored value stale. The Sprint 12 daily rollover recomputes
   `coming_shoot_date` for all active clients. The frontend treats a past `coming_shoot_date`
   as "no upcoming shoot".

## Rule
`coming_shoot_date` is a derived, guarded, orthogonal projection maintained by the Trigger 1
listener and refreshed daily by the rollover. Never naive-pushed, never version-bumps.

## Rationale
A naive push breaks on reset/multi-slot; a version bump false-conflicts orthogonal stage
edits; event-only recompute goes stale over time. This addresses all three.
