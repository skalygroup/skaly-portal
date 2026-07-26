# ADR-017 — Client onboarding is atomic with its current-period scaffolding

**Status:** Accepted • Sprint 9 (build impact: Sprint 9, Sprint 11, Sprint 12)
**Cross-refs:** `05-BACKEND-SCHEMA.md` (`clients`) · `04-APPFLOW.md` §6 · ADR-012 · Audit H-02

## Context

`clients` is not a period-scoped table, so it is not obvious that creating one is
a period write. It is: `ClientService.create` generates the current period's shoot
slots, pipeline row and calendar cells in the same transaction
(`backfillClientPeriodRows`). This raises a question the specs never answer —
what happens when the current month is locked?

Two things make the answer forced rather than a preference:

1. **Nothing backfills the current period retroactively.** Rollover generates the
   *next* month; there is no lazy or on-read generation. A client that commits
   without its current-period rows stays that way permanently.
2. **A half-onboarded client fails silently.** Trigger 2 hits
   `applyPostedTrigger`'s missing-cell no-op, the dropper has no pipeline row to
   stage, and nothing raises an error. The client simply does not work, with no
   signal saying why.

## Decision

1. **`create` asserts the current period is unlocked before it opens its
   transaction** — `assertPeriodNotLocked(getCurrentPeriod().period)`. A locked
   month means 423 `PERIOD_LOCKED` and no client row at all.

2. **"Create the client, skip the scaffolding" is not an allowed state.** It trades
   a loud, recoverable refusal for a silent permanent defect. Onboarding is
   all-or-nothing.

3. **The 423 copy explains rather than restates.** `assertPeriodNotLocked` takes an
   optional `lockedMessage`; onboarding passes *"Can't onboard a client into a
   locked month — unlock {month} first, or wait for the new month to open."* The
   default "Period X is locked" is an edit-flavoured message and reads as a
   non-sequitur on a create.

4. **The guard stays inside the one shared helper.** No parallel lock check — a
   grep for `assertPeriodNotLocked` must remain the complete list of lock-guarded
   writes.

## Rule

Any write that generates period rows is a period write and asserts the lock, even
when the row it hangs off is not period-scoped.

## Consequences

- Sprint 9's `add_client` bot tool inherits the 423 for free, so write-parity holds
  uniformly: every mutation refuses a locked period, with no exception row in the
  matrix. STEP 5's turn-2 re-validation covers a month locked between the
  confirmation summary and the "yes".
- The bot's `PERIOD_LOCKED` copy is mapped by code and is edit-flavoured, so a
  bot-mediated `add_client` into a locked month shows slightly off phrasing.
  Accepted: doubly rare, and branching the copy table by create-vs-update costs
  more than it fixes.

## Open question (Sprint 11)

`deactivate` is one-way — there is no client reactivate path, and none is specified
in any matrix (`reactivate_client` does not exist in Auth-Matrix §5). Staff have
reactivation; clients do not. Sprint 11's Clients settings screen is the point to
rule on whether a mistakenly-deactivated or returning client needs a path back, or
whether a DB correction is acceptable. Not a Sprint 9 build item.
