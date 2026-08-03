# ADR-034 — `coming_shoot_date` recompute has one implementation

**Status:** Accepted • Pre-Sprint 12 (executes ADR-012 §4)
**Cross-refs:** ADR-012 (Trigger 1) · ADR-013 (system-write version semantics) ·
`05-BACKEND-SCHEMA.md` (`content_pipelines.coming_shoot_date`, `coming_shoot_source`) ·
`09-ERROR-HANDLING.md` §7

## Context

Two writers project onto `content_pipelines.coming_shoot_date`: Trigger 1 (live, on shoot
confirm/reset) and the daily rollover recompute (Sprint 13). Two implementations of one
recompute is the permission-resolver bug (Sprint 8.1) in a different table — and it drifts
**silently**, because both write a plausible date.

## What the census found (Sprint 12 STEP 1.2)

**The recompute is already a single extracted function.** Sprint 6 shipped
`ContentDropperService.recomputeComingShootDate(clientId, period, db)`, and
`events/listeners.ts` wires both `shoot:confirmed` and `shoot:reset` to it. There is
nothing to extract — STEP 6's opening move does not apply.

It already carries every guard this ADR would have demanded:

- `MIN(slot_date)` over `slot_status = 'Confirmed'` and `slot_date >= CURRENT_DATE`;
- an early return when `coming_shoot_source = 'manual'`;
- an idempotent no-op when the value is already correct and already sourced `'trigger'`;
- an orthogonal write — no `version` bump, no `optimisticUpdate` (ADR-013);
- an audit with `actorId: null`, i.e. the System Actor.

## Decision

1. **ONE function: `ContentDropperService.recomputeComingShootDate(clientId, period, db)`.**
   Trigger 1 calls it per client on shoot confirm/reset. The rollover cron calls it for
   every active client for the new period. They differ only in **scope** — not in logic,
   not in guards, and not in what they write.

2. **No `actor` parameter, deliberately.** The sprint guide's draft signature threads an
   actor through so the cron can pass the System Actor. Both call sites already *are* the
   System Actor: the recompute is an automated projection in either direction, and it
   already audits with `actorId: null` and `coming_shoot_source = 'trigger'` unconditionally
   (ADR-012's orthogonal-write rule, audit C-04). Adding a parameter whose only legal value
   is the one already hardcoded is a knob with one setting — and a second setting is exactly
   how a human actor would end up attributed to a cron write.

3. **The `source='manual'` guard lives in the one function.** It is the part that drifts if
   duplicated: one copy forgets it and an admin's override silently vanishes at rollover.
   The column is `coming_shoot_source`, not `source`.

4. **The cron iterates; it does not reimplement.** The rollover path calls the function once
   per active client. A per-client failure is logged and does not abort the sweep — the same
   swallow-and-log contract `events/listeners.ts` already applies, because a recompute is a
   projection that the next run re-derives.

5. **Transaction boundary.** The function opens its own transaction per client
   (`transactionWithEmits`). It is therefore *not* enrolled in a caller's transaction, and
   the cron's per-client isolation is a property of that, not an accident: one client's bad
   slot data must not roll back the recompute of the other 19.

## Rule

> Parity-tested: the cron path and the trigger path produce identical `coming_shoot_date`
> for the same slot state, including the manual-override case — because they are the same
> function, and the test proves nobody has quietly forked it.
