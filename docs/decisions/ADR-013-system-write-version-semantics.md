# ADR-013 — Version semantics for system (trigger) writes

**Status:** Accepted • Pre-Sprint 7 (build impact: Sprints 6, 7, 12)
**Cross-refs:** ADR-012 · Audit C-02 · `05-BACKEND-SCHEMA.md` (`content_pipelines`, `content_calendar`)

## Context

Both cross-module triggers write to versioned tables, but to different **kinds** of column.
Treating them identically causes either false conflicts or lost updates.

## Decision

The deciding question is: **does this system write touch a column users edit?**

1. **ORTHOGONAL column** (system-only projection, e.g. `content_pipelines.coming_shoot_date`):
   targeted `UPDATE`, **NO** version bump, no `optimisticUpdate`. A concurrent user edit of the
   stage columns must NOT get a false `STALE_DATA`. (ADR-012, Trigger 1.)

2. **SAME column users edit** (e.g. `content_calendar.status` via Trigger 2):
   normal versioned `UPDATE` that **DOES** bump `version`. A user mid-edit with a stale version
   *should* get a 409 — they would be overwriting the trigger's change to the same field.
   That is optimistic locking working correctly, not a false conflict.

## Rule

System writes bump `version` **if and only if** they touch a user-editable column.
Every trigger/listener states which case it is in a comment at the write site.

## Rationale

`version` exists to protect concurrent edits of the SAME data. Bumping on an orthogonal write
manufactures conflicts; not bumping on a same-column write loses them.
