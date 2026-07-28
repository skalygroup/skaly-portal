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
