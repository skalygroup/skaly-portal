# ADR-025 — Subscribe before fetch, and reconcile in flight

**Status:** Accepted • Sprint 10.1
**Cross-refs:** `SPRINT-10-AUDIT.md` A2, `ADR-022` (patch-vs-invalidate matrix),
`09-ERROR-HANDLING.md` §5.4 (**amended by this ADR**), `13-NFRS.md` §1.3

> **Numbering note.** The Sprint 10.1 patch guide calls this ADR-022 and refers to the
> patch-vs-invalidate matrix as ADR-019. Both numbers are already taken here: ADR-022
> *is* the matrix, and ADR-019 is query-tool id serialisation. This is **025**.

## Context

Realtime consumers fetched on mount and joined their socket room after the handshake.
Events emitted in that gap reached nobody **and** were absent from the snapshot.

Nothing corrected it afterwards, and that is what made it serious rather than
transient. `providers.tsx` sets `refetchOnWindowFocus: false`; there is no
`refetchInterval`, `refetchOnMount` or `refetchOnReconnect` anywhere in `src`; and no
consumer gated on socket state. **A tab that missed an event was wrong for the rest of
its lifetime, with no visual cue** — silent stale data on a shared operational grid,
which is worse than an error.

### Two gaps, not one

```
PRE-JOIN   mount ──fetch──▶ … socket joins room
                  ▲ events here reach nobody and are not in the snapshot

IN-FLIGHT  join ──▶ fetch issued ──▶ event arrives, patches cache ──▶ fetch resolves
                                                                      from a PRE-event
                                                                      snapshot and
                                                                      overwrites it
```

**Ordering alone closes only the first.** This is not theoretical: invalidate-on-connect
was tried in Sprint 10, and it moved the race later and made it rarer — so it stopped
failing the suite and started presenting as an unreproducible *"the badge sometimes
doesn't update"*. A rarer race that survives the tests is worse than a visible one.

## Decision

1. **Room membership is ACKED.** The client emits `room:join` with a Socket.io
   acknowledgement; the server joins and acks. `'connect'` is a transport signal, not a
   subscription signal. The server's `socket.join` is now **awaited** — under
   `@socket.io/redis-adapter` it is genuinely asynchronous, so the previous
   fire-and-forget `void socket.join(...)` returned before membership existed.

2. **The query is gated on confirmed membership** via TanStack's own `enabled`, so the
   sequencing needs no bespoke orchestration.

3. **Events arriving during the initial fetch are BUFFERED and replayed onto the
   snapshot INSIDE `queryFn`.** Reconciled data is what enters the cache, so there is
   no instant at which the cache holds the un-reconciled snapshot. Draining in an
   effect keyed on `dataUpdatedAt` would leave exactly that instant open.

4. **One `applyEvent` reducer per surface, used twice** — live patching and replay.
   Pure: no `queryClient` inside, which is precisely what makes replay possible. A
   reducer that touched the cache could only ever run live.

5. **ADR-022's matrix is preserved.** Events a payload cannot express (the H-01 holiday
   cascade, task create/update/assign, the ADR-013 dropper recompute) return an
   `INVALIDATE` sentinel, keeping the patch-vs-invalidate decision in one place instead
   of split between a reducer and a separate list that could drift.

6. **Mount and reconnect are ONE mechanism.** Disconnect clears `subscribed`; connect
   re-emits and re-acks; the gated query re-runs, buffering and replaying as at mount.
   There is no separate reconnect branch. Re-subscription also invalidates explicitly,
   because `enabled` alone will not refetch data still inside `staleTime`.

7. **`refetchOnWindowFocus` is enabled on realtime-backed queries ONLY** — the cheap
   self-healing net A2 found missing. The global default stays `false`, or ADR-022's
   fan-out problem returns (50 users, one edit, 50 refetches).

8. **A degraded fallback.** If no ack arrives within 5s the query proceeds unsubscribed,
   with a console warning. Gating is what closes the window, but a client that can never
   reach the socket must not sit on a blank grid forever. The fallback accepts the
   window we would have had anyway — no worse than the pre-ADR-025 behaviour.

9. **`09-ERROR-HANDLING.md` §5.4 is amended in the same commit.** Its instruction —
   *"On reconnect: all stale TanStack Query data refetched"* — prescribes exactly the
   fix that does not work, on every reconnect. Left unamended, Sprint 11 would
   reintroduce the bug straight from the document. The banner now clears on the **ack**,
   not on connect: between the two the user is connected but not subscribed, and saying
   "live" there is a lie.

## Scope — what was actually migrated

| Surface | Status |
|---|---|
| Notification bell | ✅ full seam (patch reducer + replay) |
| Attendance, Tasks, Shoot Planner, Content Dropper | ✅ full seam (invalidate-only reducers) |
| Content Calendar | ✅ full seam (two patch reducers + sender exclusion) |
| Chat | ⚠️ **ordering only** — see below |
| Presence | ordering only, by design: it is a store, not a query, and its events are absolute state rather than deltas |

**Chat is a partial migration and should not be read as done.** Its message list is a
`useInfiniteQuery`, and this hook is built on `useQuery`; buffering pages rather than a
single snapshot is a different problem. The pre-join gap is closed for chat, the
in-flight gap is not. Recorded rather than glossed: a reader comparing the matrix to
the code would otherwise conclude chat has replay when it does not.

## What the evidence actually showed

`notifications.spec.ts:116` failed **3 of 10** runs before this change and passes
**10 of 10** after.

The audit's claim that all six surfaces are equally affected is **structurally true and
empirically unproven**. Three attempts to reproduce the window on a grid all failed —
two of them because the probe itself was wrong (one counted the grid's own mount fetch;
one fired the event before the snapshot was taken, so the fetch simply included it).
The window on grids is narrow enough that ordinary test timing does not land in it.

The seam was still built for all of them, because the structural facts are verified —
no consumer gated on socket state, and nothing self-heals — and because the same code
serves every surface. But the honest position is: **one instance is proven, five are
inferred.**

## Rule

> Never issue the initial fetch before membership is confirmed, and never let a snapshot
> overwrite an event that arrived after it was taken.
