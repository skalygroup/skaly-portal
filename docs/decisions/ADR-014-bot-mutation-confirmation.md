# ADR-014 — Two-turn mutation confirmation as a server-side state machine

**Status:** Accepted • Pre-Sprint 9 (build impact: Sprint 9)
**Cross-refs:** `02-TRD.md` §9.2 · `04-APPFLOW.md` §9 · Audit C-02 · ADR-008 · ADR-013

## Context

Sprint 9 is the first time a probabilistic system (the model) triggers an irreversible write.
`02-TRD.md` §9.2 mandates a two-turn protocol: present a summary, execute on affirmative.
"Turn 2 affirmative executes" is underspecified in two safety-critical ways — **who decides
what counts as affirmative**, and **what the stored call carries**.

## Decision

1. **Consent is never model-classified.** The `[Confirm]` / `[Cancel]` buttons send a
   structured `{ decision, confirmationId }`. Typed text is matched against a narrow
   **exact-match** affirmative allowlist after normalisation. Anything else is not consent.
   Consequence, and it is the desired one: *"yes, but make it Friday"* is **not** consent —
   it clears the pending state and is re-planned as a fresh turn.

2. **Version captured at turn 1.** For versioned targets (`content_pipelines`,
   `content_calendar`) the `expectedVersion` is read when the summary is built and stored in
   the pending record. Without this the bot read-then-writes and becomes last-write-wins,
   silently undoing C-02 for every bot-mediated edit. An interleaving human edit must produce
   an honest 409. `tasks` and `shoot_schedules` are unversioned (ADR-008) and capture nothing.

3. **One pending record**, consume-once, 5-minute expiry, stored inside the existing
   `bot:session:{staffId}` blob — one key, one TTL, atomic with the turn append. A new
   mutation intent replaces it. It is consumed **before** execution, so a double-click cannot
   double-fire.

4. **The summary is server-rendered** from the validated input plus a current-state read.
   The user consents to specific values; the model may not paraphrase them.

5. **Turn 2 makes zero model calls.** Execute, then render the outcome (or the friendly
   error) deterministically. The confirmation of an approved change must not be probabilistic
   prose, and it saves a full round trip.

6. **Re-validate at turn 2:** re-resolve the permission and re-assert the period lock before
   executing. Both may have changed between the summary and the "yes".

## Rule

The pending confirmation is **server state**. The client may reference it by id; it may never
supply the tool, the arguments, or the version.

## Rationale

A gate the model can talk its way through is not a gate. Every element above moves one
decision out of the model and into deterministic server code: what counts as yes, what gets
written, and against which version.
