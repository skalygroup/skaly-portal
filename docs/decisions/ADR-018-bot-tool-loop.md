# ADR-018 — Bounded multi-round agentic tool loop + session integrity

**Status:** Accepted • Sprint 9 (supersedes SPRINT-9 STEP 5's "without changing that loop's shape")
**Cross-refs:** `02-TRD.md` §9.1 · `11-THIRD-PARTY-INTEGRATIONS.md` §3.4 · ADR-014 · ADR-019

## Context

Sprint 8's bot loop was a **fixed two-phase loop**: stream → `tool_use` → execute →
second stream → terminal. It assumed the model calls at most one round of tools per
message. That assumption is false in general — chained tool calls are routine — and
Sprint 9 made it false *by construction*: the system prompt's "to act on a record,
first look it up with a query tool to obtain its id" (there is deliberately no fuzzy-id
resolver, reconciliation #11) forces a lookup round, so the mutation always lands in
round 2 — the round the two-phase loop cannot service.

Two failures from that one root, both found by driving the real UI, neither reachable
from the unit suite (the mocks answered every `tool_use` and never had to survive a
second message):

1. **The session poisoned itself.** The unserviced `tool_use` was persisted with no
   matching `tool_result`. The Anthropic API rejects such a transcript, so the *next*
   message 400'd — surfaced as the friendly `ANTHROPIC_ERROR` copy ("I'm having
   trouble connecting"), permanently, until the session was cleared or its 12h TTL
   expired. One ordinary retry killed the conversation.
2. **Mutations were unreachable.** The lookup consumed the only round, so a mutation
   could only be staged if the user already knew the uuid.

## Decision

1. **A bounded `while`-loop, not two phases.** Call the API; while
   `stop_reason === 'tool_use'`, execute *every* `tool_use` block — or, for a
   mutation tool, run the turn-1 interceptor (set pending, return the synthetic
   `AWAITING_USER_CONFIRMATION` result **instead of** executing) — append the
   `tool_result`s, call again; until a terminal text turn or the round cap
   (`MAX_TOOL_ROUNDS = 4`).
2. **Cap-hit finalises gracefully, never throws.** On the cap, or on a mid-stream
   failure after `bot:token` has already emitted, finalise with the accumulated text
   plus the friendly copy. Never restart the stream (it would duplicate text already
   on screen), never surface an error. This reuses the graceful-finalisation path of
   `11-THIRD-PARTY-INTEGRATIONS.md` §3.4 — a hard error at the cap would read as
   exactly the "trouble connecting" bug this ADR removes.
3. **`stripDanglingToolUse` enforces pairing in BOTH directions**, keyed on
   `tool_use_id`: a `tool_use` with no following `tool_result`, **and** a
   `tool_result` with no preceding `tool_use` (the API rejects both). It runs at two
   boundaries — **persist**, so a bad transcript is never stored, and **read**,
   before the first API call of every message, so a session poisoned by an earlier
   build heals itself on the user's next message rather than staying broken for its
   whole TTL.

## Consequences

- Supersedes STEP 5's instruction to preserve the Sprint 8 loop shape. That
  instruction assumed the loop was sound; it was not. **The turn-1 confirmation
  interceptor is unchanged and lives INSIDE the new loop** — only the control flow
  around it changed. A mutation `tool_use` still gets the synthetic result, and the
  next round emits the confirmation question and terminates on `end_turn`; that pair
  is well-formed in history and replays cleanly.
- Turn 2 (post-affirmative) still makes **zero model calls** (ADR-014 §5) and never
  enters the loop — `handleTurn2` returns before the loop is reached.
- The single-pending rule (ADR-014 §3) bounds mutation depth to one staged mutation
  per message, so 4 rounds comfortably cover lookups-then-one-mutation for the
  22-tool set. Once a confirmation is staged the loop takes exactly one more stream
  (the question) and stops unconditionally, so a second mutation cannot be staged in
  the same turn and silently discarded. Revisit the cap only if a future tool needs
  3+ lookups to resolve its target.

## Regression locks (STEP 7)

- A message needing lookup-then-act drives ≥2 tool rounds and terminates with no
  dangling `tool_use` persisted.
- A session seeded with a dangling `tool_use` **and** an orphan `tool_result` — a
  simulated pre-fix poisoned session — succeeds on the next message; neither block
  reaches the API.
- A model that calls a tool every round hits the cap and finalises with partial text
  + friendly copy, no throw, and no extra closing stream.
- A mutation `tool_use` inside the loop yields the synthetic result, the next round
  emits the confirmation question, pending is set, nothing is executed.
