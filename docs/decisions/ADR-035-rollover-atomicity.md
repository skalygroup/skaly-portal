# ADR-035 — Rollover is a two-tier transaction

**Status:** Accepted • Pre-Sprint 13
**Cross-refs:** `13-NFRS.md` §3.1 (single atomic txn, < 5 min, API operational during the
window) · `02-TRD.md` §11 (materialised views) · ADR-034 (the recompute) ·
ADR-030 (retention is a neighbour, not a passenger) · ADR-037 (the `months` idempotency key)

## Context

Rollover creates the next period's rows for every client and runs the `coming_shoot_date`
recompute. It runs unattended at 00:01 IST with nobody watching, and its failure is
discovered by the business owner the next morning. The dashboard materialised-view refresh
can fail independently and has its own notification type (`rollover_view_refresh_failed`) —
which only makes sense if the two are actually allowed to fail independently.

## What the census found (Sprint 13 STEP 1.2)

- **Both materialised views already carry the unique index `CONCURRENTLY` requires.**
  `024_materialised_views.ts` creates `dashboard_org_stats(period)` and
  `dashboard_staff_task_stats(period, staff_id)`. Nothing to add — but the indexes exist for
  `CONCURRENTLY`, not for query performance, and that reason is now written down (STEP 2
  adds the comment) so nobody drops them as redundant.
- **The row generators already exist and are already idempotent.**
  `period-generation.ts`'s `generatePeriodRows(period, trx)` takes the caller's transaction
  and guards every insert with `ON CONFLICT DO NOTHING`. It was written in Sprint 5 for the
  seed *specifically so* the rollover would inherit a proven implementation.
- **The recompute exists as one function** (ADR-034) — but see the amendment below.

## Decision — two tiers

### TIER 1 (atomic, all-or-nothing, one transaction)

Period-row creation for every client (`generatePeriodRows`) + the `coming_shoot_date`
recompute for every active client (ADR-034, System Actor) + the `months` idempotency-key row
(ADR-037) + the rollover audit entry.

**Either the whole next month exists or none of it does.** This is what NFR §3.1 protects.
The commit of this transaction is the boundary the entire ADR rests on.

### TIER 2 (post-commit, independently failable)

`REFRESH MATERIALIZED VIEW CONCURRENTLY` of the dashboard views. Runs **after** Tier 1
commits, outside its transaction. Its failure fires `rollover_view_refresh_failed`, sets no
`view_refreshed_at`, and degrades the dashboard to stale data. **It does not roll back the
rollover, and the endpoint still returns success.**

`CONCURRENTLY` is not optional. Without it the refresh takes `ACCESS EXCLUSIVE` on the view
and blocks every dashboard read for its duration, which directly contradicts NFR §3.1's
"API fully operational during 00:01–00:05".

### Boundary proof

`rollover_success` / `month_ready` fire on **Tier 1's commit**, before Tier 2 runs. The
refresh outcome fires its own notification. Therefore:

> `rollover_view_refresh_failed` **without** a preceding `rollover_success` is impossible
> when the tiers are correct. If you ever see that pairing, the tiers are entangled — the
> refresh is inside the transaction, or the success notification is wrongly gated on it.

That pairing is the diagnostic, and STEP 6 asserts it.

## Amendment to ADR-034 §5 — the recompute enrolls in Tier 1's transaction

ADR-034 §5 recorded that `recomputeComingShootDate` opens its own transaction per client
(`transactionWithEmits`), and that the cron's per-client isolation is a property of that.
That is correct **for the standalone sweep** (`jobs/coming-shoot-date-recompute.ts`, the
`/internal/recompute-shoot-dates` handle), where one client's bad slot data must not cost the
other nineteen their recompute.

Inside Tier 1 that isolation is *wrong*: Tier 1 is all-or-nothing, so a swallowed per-client
failure would commit a month that is quietly missing a recompute. And it is also not
available — Kysely 0.29 has no implicit nested transactions; `trx.transaction().execute()`
re-`BEGIN`s on an already-pinned connection, so the inner `COMMIT` would commit the *outer*
transaction. Nesting here is not merely redundant, it is a correctness hazard.

So the function is **split, not forked**:

- `recomputeComingShootDate(clientId, period, db)` — unchanged signature, unchanged
  behaviour, opens its own transaction. The live triggers and the standalone sweep keep
  calling this.
- `recomputeComingShootDateIn(clientId, period, trx)` — the *same body*, enrolled in the
  caller's transaction. Tier 1 calls this.

The first is a two-line delegation to the second. ADR-034's actual invariant — **one
implementation of the recompute logic, one `source='manual'` guard** — is preserved exactly;
what changes is only who owns the transaction. A second copy of the body would have been the
ADR-034 violation; a shared body with two transaction owners is not.

## Retention is a neighbour, never a passenger

Retention (ADR-030) runs 03:00 IST monthly — a temporally separate schedule with no overlap
with the 00:01 rollover window. It is never run inside or adjacent to Tier 1. A long `DELETE`
holding locks while rollover's transaction is open is an outage, and the two jobs share
nothing but the database. **The recompute is the only thing that runs inside Tier 1.**

## Rule

> A refresh failure that degrades the dashboard is recoverable by re-running the refresh.
> A refresh failure that undoes a month's creation is not recoverable by anything.
> Never put Tier 2 inside Tier 1.
