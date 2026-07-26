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

## Rationale

Storing the owner directly on the bot row (what the code did) is simpler to read and was
working. It was rejected because it contradicts the canonical schema, and a schema comment that
the code silently disagrees with is worse than either choice made honestly — the next person
writing to `messages` reads the comment, not the 344 rows. The join costs one `LEFT JOIN` on an
indexed FK and buys back a single source of truth.
