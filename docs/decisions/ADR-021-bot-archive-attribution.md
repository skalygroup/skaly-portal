# ADR-021 — Bot conversation ownership in the messages archive

**Status:** Accepted • Pre-Sprint 10 (build impact: Sprint 10 STEP 2, **before chat writes**)
**Cross-refs:** `02-TRD.md` §9.4 · `05-BACKEND-SCHEMA.md` (`messages`, `bot_sessions`,
migration `020`) · `13-NFRS.md` §5.2 · ADR-014 · ADR-016

> **Numbering note.** The Sprint 10 guide calls this ADR-018; that number was taken by
> `ADR-018-bot-tool-loop` in Sprint 9. See ADR-020's numbering note for the full mapping.

## Context

TRD §9.4 claims a persistent, attributable bot archive at `messages` / `channel='bot'`.
The canonical schema says `messages.sender_id` is NULL for bot rows, and there is no
`recipient_id`, no owner column, and no session reference — so as *specified*, every bot reply
to every user is indistinguishable, and once the 12h Redis TTL lapses, ownership is
unrecoverable. That makes NFR §5.2's 12-month retention meaningless: you would be retaining
rows nobody can be shown.

Meanwhile `bot_sessions` (migration `020`, with `staff_id` and a DELETE grant) is written by
no sprint. It is an orphan table.

### What STEP 1.4 actually found

Not the failure the spec predicted, and not cleanly any of A/B/C:

```
channel | sender_type | sender_id IS NULL | parent_id IS NULL | count
bot     | bot         | f                 | t                 |  344
bot     | user        | f                 | t                 |  301
bot_sessions: 0 rows
```

Both turns **do** persist (`BotService.archiveUserMessage`, `.archiveBotMessage`). But
`archiveBotMessage` writes `sender_id = staffId` on the bot row (`BotService.ts:878`) —
attributable in practice, and **contrary to the canonical schema comment**. There is no
`parent_id` link and no session envelope.

This is the fortunate case. The 344 existing bot rows carry their own `sender_id`, so
`COALESCE(m.sender_id, p.sender_id)` resolves them unchanged. **There are no orphans, no
backfill, and no unattributable history** — the correction is forward-only.

One further finding: `apps/api/src/lib/bot/stream-handler.ts` is dead code (imported only by
its own test) that archives the *bot's* response text as `sender_type: 'user'`. It writes
nothing today because nothing calls it, but it is a mis-shaped writer sitting beside the path
this ADR corrects, and it is deleted in STEP 2.

## Decision

1. **The USER's bot turn persists to `messages` with `sender_id = staffId`, `channel='bot'`,
   written BEFORE the model is called.** `parent_id` gives ownership *by join*, which only
   works if the row it points at carries the owner. Writing it first also means a crash
   mid-stream still leaves an attributable question.

2. **The BOT's reply persists with `sender_id = NULL`** (restoring the canonical schema
   comment, which the as-built write violated) **and `parent_id` = the user turn's id.**
   Zero migration: `parent_id` exists and already FKs `messages(id)`, and a bot reply
   genuinely is a reply.

3. **Ownership resolves as `COALESCE(m.sender_id, p.sender_id)`** over a self-join on
   `parent_id`. This is correct for both the new NULL-sender rows and the 344 legacy rows that
   carry their own `sender_id` — which is why no backfill is needed.

4. **`bot_sessions` holds the SESSION ENVELOPE**: one row per conversation, `staff_id`,
   `last_activity_at` bumped per turn. It is the handle for the 12-month retention job and any
   future resume-session feature. It is **NOT** the ownership source and is **NOT** re-derived
   per message. `parent_id` owns the message graph; `bot_sessions` owns the session lifecycle.
   Orthogonal jobs, so neither has to agree with the other and there is no dual-write drift.

5. **A DB fallback sits behind `GET /v1/bot/session/current`** — Redis first, then the
   ownership query when the 12h TTL has expired. Without it the archive is write-only, and
   attributable-but-unreachable is not meaningfully better than unattributable.

6. **This lands BEFORE common chat becomes a second writer to `messages`.** Fixing the bot's
   write shape while simultaneously adding chat's write path to the same table is how you get
   two half-right writers.

7. **No migration. No `sender_id` backfill on bot rows. No owner column.** Everything here
   uses columns that already exist.

## Rule

Two mechanisms, two questions. `parent_id` answers *"whose message"*; `bot_sessions` answers
*"whose conversation, and when"*. Never make them redundant — if you find yourself querying
`bot_sessions` to answer "whose message is this", you have recreated the dual-write problem
inside one feature.

## Addendum — `messages_parent_id_fkey` and the retention job (build: Sprint 12)

Introducing `parent_id` links raises how the 12-month retention job (NFR §5.2) deletes them.
Sprint 10's test teardowns hit this immediately, which is the useful part: **the failure mode
already has a working reproduction**, and it would otherwise be rediscovered under a cron job
at 02:00 IST.

**The constraint is `NO ACTION`, and that is not `RESTRICT`.** Postgres checks a `NO ACTION`
FK at the *end of the statement*; `RESTRICT` checks per row, immediately. So a single
`DELETE FROM messages WHERE id IN (…)` that removes a parent **and its children together**
already succeeds today, with no schema change. What fails is *two* statements, or parent-first
ordering — exactly what the teardowns were doing.

That reframes the question away from cascade-vs-unlink:

| Option | Ruling |
|---|---|
| `ON DELETE SET NULL` | **Rejected.** It re-orphans bot replies — precisely the bug this ADR exists to fix. |
| `ON DELETE CASCADE` | **Rejected.** `parent_id` is also the chat thread link, so one hard-deleted parent could silently take replies still inside their own retention window. Data loss adopted to solve an ordering problem. |
| **Keep `NO ACTION`; make the job session-scoped and single-statement** | **Accepted.** No migration. |

**The job's shape:**

- **One rule, both channels** — delete a message past the cutoff **unless it still has a
  reply inside the window**. `parent_id` is what keeps a pair together: a bot reply is a
  child of its question, so the question cannot be deleted while the answer is live.
- **One statement per batch.** Never parent-first, never two statements.

> **Correction (Sprint 10 STEP 8, found by test).** This addendum originally said to scope
> the bot channel by `bot_sessions.last_activity_at`, "so whole conversations age out
> together". **That is not expressible.** `messages` carries no session reference — this
> ADR deliberately gave `parent_id` the message graph and `bot_sessions` the session
> lifecycle, and never linked a row to a session. The first implementation therefore
> joined `bot_sessions` on `staff_id`, which means **one expired session deletes that
> person's entire bot history, live conversations included.**
>
> The turn-pair guarantee the session scoping was reaching for is already provided by
> `parent_id`, and the two turns are written seconds apart so they cross the cutoff
> together. Scoping by session bought nothing the graph did not already give, and cost a
> silent data-loss bug.
>
> If whole-conversation retention is ever genuinely wanted, it needs a `session_id` column
> on `messages` — a migration, and a deliberate decision — not a join on the staff member.
> Tested in `test/services/MessageRetention.test.ts`, including the straddling pair and
> the two-conversations-one-person regression.

**Write the job's test from the teardown's fix.** Sprint 9's suite produced a working
demonstration of the failure; that is a free test case for a job that does not exist yet, and
it expires from memory in about two sprints if nobody writes it down. See
`apps/api/test/routes/bot.test.ts` and `test/services/BotService.test.ts` — the "delete the
conversation, not rows carrying my id" cleanup is the shape the job needs.

## Rationale

Storing the owner directly on the bot row (what the code did) is simpler to read and was
working. It was rejected because it contradicts the canonical schema, and a schema comment that
the code silently disagrees with is worse than either choice made honestly — the next person
writing to `messages` reads the comment, not the 344 rows. The join costs one `LEFT JOIN` on an
indexed FK and buys back a single source of truth.
