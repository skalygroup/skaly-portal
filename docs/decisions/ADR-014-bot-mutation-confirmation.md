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

3. **One pending record**, consume-once, 5-minute expiry, under its own key
   `bot:pending:{staffId}`. A new mutation intent replaces it. It is consumed **before**
   execution, so a double-click cannot double-fire.

   *Amended during Sprint 9 STEP 3.* The original ruling put the record inside the
   `bot:session:{staffId}` blob for "one key, one TTL". That is incompatible with
   consume-once, which is the safety property the record exists for:

   - `WATCH`/`MULTI` is scoped to a **connection**, and the app shares one ioredis client.
     Two concurrent consumers on that connection both pass the CAS and both execute.
   - A Lua script would have to `cjson`-decode and re-encode the whole session; `cjson`
     renders an empty `messages: []` as `{}`, corrupting the transcript in order to protect
     the pending record.

   A dedicated key makes the consume a single atomic `GETDEL` on a shared connection. The
   cost is that a pending record can outlive a failed session write — bounded at 5 minutes,
   and version-checked before it can write anything. Cheap next to firing `create_task` or
   `add_client` twice, which are unversioned and would simply succeed twice.

   The key carries a **15-minute** Redis TTL — deliberately longer than the 5-minute gate, so
   an expired confirmation is still readable and can be reported as "that timed out" rather
   than being indistinguishable from one that never existed. The TTL is a janitor; `expiresAt`
   is the gate.

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
