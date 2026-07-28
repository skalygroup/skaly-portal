# ADR-022 — Grid real-time: patch vs invalidate

**Status:** Accepted • Pre-Sprint 10 (build impact: Sprint 10 STEP 9, and all future grids)
**Cross-refs:** `02-TRD.md` §8 · `13-NFRS.md` §1.3 · ADR-010 · ADR-012 · ADR-013 · Sprint 13 k6

> **Numbering note.** The Sprint 10 guide calls this ADR-019; that number was taken by
> `ADR-019-query-tools-serialise-ids` in Sprint 9. See ADR-020's numbering note.

## Context

With 50 users on the content calendar, one cell edit broadcast to `org:all` makes 50 clients
invalidate `['content-calendar', period]` — 50 refetches for one change, all of which return
data 49 of them could have derived from the payload they were just handed.

The obvious fix is "patch the cache instead of refetching". The obvious fix is wrong as a blanket
rule, because some of our writes fire database triggers whose side effects no single-row payload
can express.

## Decision — the dividing line is correctness, not performance

> **PATCH** the TanStack cache when the event payload contains the **complete new state of a
> single addressable cache entry**.
>
> **INVALIDATE** when it does not — when the change touches a **trigger, a cascade, an
> aggregate, membership, or row ordering**.

| Event | Action | Why |
|---|---|---|
| `content-calendar:updated` | **patch** `['content-calendar', period]` | payload fully specifies one cell |
| `shoot:slot_updated` | **patch** the slot, **invalidate** `['content-dropper', period]` | Trigger 1 recomputes `coming_shoot_date` on the pipeline (ADR-012) |
| `content-dropper:updated` | **patch** if the payload carries the recomputed derived status, else **invalidate** that row | ADR-013 |
| `client:name_updated` | **patch** every cached list holding that client | it is a string |
| `attendance:holiday_added` / `:removed` | **invalidate** `['attendance', period]` | the H-01 cascade — one holiday flips every staff column for that date and reverts logs |
| `task:created` / `:updated` / `:assigned` | **invalidate** `['tasks', period]` | ordering, membership, fan-out |
| `chat:message` / `:deleted` | **patch** the message list | append / tombstone |
| `notify:new` / `:read` | **patch** the bell | the same principle applied to notifications |
| `presence:changed` | **patch** the presence store | ephemeral, never a query |

### Supporting rules

**a. Every patchable event's payload MUST carry the new `version`,** and `setQueryData` must
write it into the cached row. A patch that leaves a stale cached version guarantees the user's
*next* optimistic write 409s spuriously — which presents as a backend bug and is not one. If a
payload cannot carry the version, that event is **invalidate-only by definition**.

**b. The sender is excluded from its own broadcast, in both places.** Server-side via
`socket.broadcast.to(room).emit(...)`; client-side by ignoring events whose `actorStaffId`
equals the current user. Two guards, because the failure mode — a double-applied patch fighting
an in-flight optimistic update — is nearly impossible to diagnose from a bug report.

**c. The matrix is the spec.** If an event is not in the table above, it is not wired. Adding a
subscription means adding a row here first.

## Rule

A patched cache missing a trigger side effect is showing **stale derived data** — worse than
the refetch you avoided. Correctness decides; the fan-out reduction follows for free, because
the hot path (calendar cells) happens to be the patchable one.

## Rationale

The performance framing invites the wrong instinct — "patch where we can, invalidate where we
must be safe" — which degrades into patching everything, because every payload *looks* complete
until you remember what the trigger did. Framing it as correctness makes the question mechanical:
*does this write fire a trigger, touch an aggregate, or change ordering?* If yes, invalidate,
however tempting the payload looks.
