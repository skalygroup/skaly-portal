# ADR-030 — `messages.parent_id` keeps `ON DELETE NO ACTION`

**Status:** Accepted • Pre-Sprint 11 — **RECORDED NOW, BUILT SPRINT 12**
**Cross-refs:** `13-NFRS.md` §5.2 (12-month retention) · `05-BACKEND-SCHEMA.md`
(`messages`, migration `018_messages`) · ADR-021 (bot archive attribution, §4) ·
`SPRINT-9` teardown fixes

> **Numbering note.** The Sprint 11 guide calls this ADR-027, and refers to bot archive
> attribution as ADR-018. Both are shifted: this is **030**, and the archive ADR is
> **ADR-021**. See ADR-026's note.

## Context

`messages.parent_id UUID REFERENCES messages(id)` (migration `018`, line 12) declares no
`ON DELETE` action, so it defaults to `NO ACTION`. Nothing hard-deletes messages today.
NFR §5.2's 12-month retention job, built in Sprint 12, will be the first thing that does.

The reflex on reading an FK with no explicit action is to "harden" it. That reflex is
wrong here, and the reason is counterintuitive enough to be worth a document.

## The Postgres detail that decides it

**`NO ACTION` is not `RESTRICT`.** `NO ACTION` defers its check to the **end of the
statement**; `RESTRICT` fires **per row, immediately**. So:

```sql
DELETE FROM messages WHERE id IN (parent, child1, child2);
```

**succeeds today** under `NO ACTION` — by the time the check runs, the referencing
children are already gone — and would **fail** under `RESTRICT`. "Hardening" the FK to
`RESTRICT` would *break* the retention job before it was written.

What fails today is two statements, or parent-first ordering — not the single-statement
whole-conversation delete the job is designed around.

## Decision

1. **Keep `NO ACTION`.** Comment the Sprint 12 migration (or the job, if no migration is
   needed) with the reason, so nobody upgrades it in a later hardening pass.

2. **`ON DELETE SET NULL` is ruled out** — it re-orphans bot replies from their parents,
   which is the exact bug ADR-021 exists to fix.

3. **`ON DELETE CASCADE` is ruled out for chat** — `parent_id` doubles as the thread
   link, so one hard-deleted parent could silently remove replies still inside their own
   retention window. That is data loss introduced to solve an ordering problem.

4. **The Sprint 12 job is SESSION-SCOPED and SINGLE-STATEMENT.** Session scoping is not
   merely so a turn-pair is not split — it is **what guarantees the single-statement
   property**, which is the only reason `NO ACTION` lets the delete through at all.
   Delete a whole conversation as one `IN`-list, bounded by
   `bot_sessions.last_activity_at` (ADR-021 §4). This is where `bot_sessions` earns its
   keep beyond bookkeeping.

5. **Chat threads have no session envelope.** A reply deletes on age alone — deleting a
   child never violates the FK. A parent deletes only when its **newest** reply is also
   past the cutoff, and goes in the same statement.

6. **Test from the teardown's fix.** Sprint 9's teardowns already demonstrated this
   failure in miniature. Seed a parent and a child straddling the cutoff; assert the job
   neither errors nor splits the pair.

## Rule

> Retention deletes whole conversations, never halves of turns.

---

## Amendment (Sprint 12 build)

### Correction to §4 — session scoping is superseded

§4 above says the job is bounded by `bot_sessions.last_activity_at`. **It is not, and it
cannot be.** ADR-021's own correction (Sprint 10 STEP 8, found by a test) records why:
`messages` carries no session reference, so the only available join is
`bot_sessions.staff_id`, and that means **one expired session deletes that person's entire
bot history, live conversations included.** ADR-021 is the later document and it wins.

The turn-pair guarantee §4 was reaching for comes from `parent_id`, not from the envelope.
The rule is one rule for both channels:

> Delete a message past the cutoff **unless it still has a reply inside the window.**

`NotificationService.deleteExpiredMessages` (Sprint 10 STEP 4) already implements exactly
that, and `test/services/MessageRetention.test.ts` already covers the straddling pair and
the two-conversations-one-person regression. Sprint 12 does **not** rewrite the predicate.

Whole-conversation retention scoped to a real session would need a `session_id` column on
`messages` — a migration and a deliberate decision. It is not in Sprint 12.

### Batching

Sprint 12 adds the bound that was missing. §4's single-statement property is load-bearing
and is preserved; what changes is that one statement no longer covers the entire 12-month
purge. Each batch is:

```sql
WITH batch AS (
  SELECT m.id FROM messages m
  WHERE m.created_at < :cutoff
    AND NOT EXISTS (SELECT 1 FROM messages r
                    WHERE r.parent_id = m.id AND r.created_at >= :cutoff)
  ORDER BY m.created_at
  LIMIT :batchSize
)
DELETE FROM messages d
WHERE d.id IN (SELECT id FROM batch)
   OR d.parent_id IN (SELECT id FROM batch)   -- the closure that keeps a turn whole
RETURNING d.id
```

The `OR d.parent_id IN (batch)` closure is the part that matters: a parent selected into the
batch takes **all** its children with it in the same statement, even if a child fell outside
the `LIMIT`. Those children are necessarily past the cutoff already — a parent with a reply
inside the window is excluded by the `NOT EXISTS`. So the statement is bounded *and* whole,
and `NO ACTION`'s statement-end check still passes.

The job loops until a batch returns zero rows, with an iteration cap so a runaway can never
spin. Between batches, other traffic proceeds — a single monster `DELETE` would hold locks
on `messages` for the length of the purge, during live chat.

### Schedule

**03:00 IST, monthly**, on the existing Railway cron service behind `X-Internal-Secret`.
Well clear of the 00:01 rollover window: a long `DELETE` holding locks while rollover's
atomic transaction is open is the one way to turn two safe jobs into an outage. It is also
clear of the 04:00 attachment sweep (ADR-033).

### Scope

This job is **only** the 12-month message cleanup, plus `bot_sessions` envelopes whose
`last_activity_at` is past the same cutoff (deleted separately — no FK ties them to
`messages`, which is the whole point of ADR-021 §4).

It is **not** the 2-year audit-log archival (separate, post-launch) and **not** the 30-day
report/backup R2 lifecycle (R2 lifecycle rules, Infra §7). It deletes no audit rows and no
R2 objects.

### Audit

A **summary** row per run to the System Actor — messages removed, sessions removed, batches
run. Not per-row: a single run can clear ~15k messages (NFR §2.2), and 15k audit rows to
record one scheduled cleanup is how the audit log becomes unreadable.
