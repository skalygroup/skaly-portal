# ADR-037 — Rollover is safe to run twice

**Status:** Accepted • Pre-Sprint 13
**Cross-refs:** `10-INFRA-DEPLOYMENT.md` §4 (cron + `X-Internal-Secret` + the 3× retry) ·
`09-ERROR-HANDLING.md` §7 · ADR-035 (the two tiers) · ADR-036 (the notifications) ·
`05-BACKEND-SCHEMA.md` (`months`)

## Context

The cron fires rollover with `curl` + `X-Internal-Secret` and retries 3× on a non-2xx
response. A retry after a partial run must not double-create period rows or double-fire
`month_ready` — and "partial" here has two very different meanings that need different
answers.

## What the census found (Sprint 13 STEP 1.2)

`months` (migration `002_months.ts`) has `period`, `label`, the lock columns, and
`created_at`. It has **no** rollover state columns; STEP 2 adds them. `period` is the primary
key, so create-if-absent is a plain `ON CONFLICT (period) DO NOTHING` — the uniqueness is
already enforced by the schema, not by application logic.

## Decision

### 1. The `months` row is the idempotency key, inserted INSIDE Tier 1

Create-if-absent, skip-if-present. Because it is inserted inside Tier 1's transaction,
"the month row exists" and "the period rows exist" commit **together** — which is the only
reason skip-if-present is trustworthy. If the row were inserted first, in its own
transaction, a Tier 1 failure would leave a `months` row claiming a month that has no rows,
and every subsequent retry would skip.

Because Tier 1 is atomic, a failed attempt rolls back completely — no `months` row, no period
rows — and the retry runs from clean state. **Atomicity is most of the idempotency.**

### 2. Post-commit steps are guarded on `months` row state

The state columns (STEP 2, additive):

| Column | Set when |
|---|---|
| `rollover_completed_at` | Tier 1 commits |
| `view_refreshed_at` | Tier 2 succeeds |
| `rollover_failed_step` | a post-commit step fails |

A retry that arrives after Tier 1 committed but before Tier 2 ran **resumes** rather than
re-runs: no second set of period rows, no second `month_ready`, no second refresh.

### 3. The three-way branch — one decision, not scattered ifs

Entry reads the target period's `months` row and takes exactly one of three paths:

```
months row absent                                → run Tier 1, then Tier 2   ('completed')
row present, rollover_completed_at NULL          → run Tier 1, then Tier 2   ('completed')
                                                   (Tier 1 rolled back before; row is a
                                                    lock/seed artefact, not a rollover)
row present, completed_at set, refreshed_at NULL → resume TIER 2 ONLY        ('resumed')
row present, completed_at set, refreshed_at set  → no work at all            ('already_completed')
```

Note the second row: a `months` row can pre-exist without a rollover having created it —
the seed creates the current month, and an admin can lock a future month. Presence alone is
therefore *not* the completion signal; `rollover_completed_at` is. The insert is
create-if-absent so it composes with either.

### 4. ⭐ One idempotent core, two entry points

The `[Manual rollover]` button (ADR-036 §4) and the cron hit **the same endpoint** — not a
separate "force" path that skips the guard. They differ only in how they authenticate: the
cron by `X-Internal-Secret` (timing-safe compare, the B-03 discipline — a variable-time
secret compare is the same bug class as a variable-time password compare), the admin by
session. Clicking `[Manual rollover]` after a partial cron success is therefore safe by
construction, not by the admin's care.

### 5. No service-level retry

The cron owns retries; the endpoint owns idempotency. Adding a retry loop in the service
means a failing rollover is attempted 9 times and the failure notification fires on a
schedule nobody chose.

## Rule

> Two entry points, one idempotent core, guarded by the `months` row —
> and the row is only trustworthy because it commits with what it guards.
