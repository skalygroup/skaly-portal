# ADR-029 — Permission changes push to the affected session (UX layer only)

**Status:** Accepted • Pre-Sprint 11 (completes Sprint 8.1 STEP 3.4's deferral)
**Cross-refs:** `08-AUTH-MATRIX.md` §6.3 · ADR-022 (patch vs invalidate) ·
ADR-025 (subscribe before fetch) · `SPRINT-8.1-PATCH-DETAILED.md` STEP 3.4

> **Numbering note.** The Sprint 11 guide calls this ADR-026 and refers to the
> self-healing realtime mechanism as ADR-022. Both numbers are shifted: this is **029**,
> and the mechanism it rides is **ADR-025**. See ADR-026's note.

## Context

`perms:{staffId}` has a 5-minute TTL **and** invalidation-on-write. Enforcement is
already correct and already immediate: the key is deleted on write, so the affected
user's *next* request re-resolves from the database. There is no window in which a
revoked permission still works. This is worth stating plainly, because the obvious
reading of "permissions don't update live" is that there is a security hole, and there
is not.

What is missing is **UX for an idle session**. `GET /v1/staff/me` returns effective
permissions and the sidebar derives nav from them, but nothing refetches it while the
user sits still. So:

- a newly granted module does not appear until they navigate;
- a revoked one stays visible until they click it — and then correctly 403s, having
  offered an action that could only fail.

The second is the one that reads as a bug to the user.

## Decision

1. On **any** `user_permissions` write — allow, deny, or the delete-to-inherit path —
   emit `permission_changed` to that `staffId`'s room. The client refetches
   `/v1/staff/me` and re-derives nav and access.

2. **The push is an enhancement, not the boundary.** If it is missed (client offline —
   audit A2's exact property), the user stays *visually* stale until their next request,
   where the backend re-checks and corrects. Fail-safe by construction. Enforcement
   remains server-side and per-request.

3. Because it has the identical "what if the event is missed" property as every other
   realtime surface, this push **rides ADR-025's self-healing mechanism** — acked room
   membership, gated query, `refetchOnWindowFocus` on realtime-backed queries — rather
   than adding a bespoke recovery path. Building a second self-healing mechanism for one
   event is how two mechanisms drift.

4. Per ADR-022's matrix this is an **invalidate**, not a patch. The payload cannot
   express the resolved permission set — that is the resolver's job, and the resolver
   lives on the server (Sprint 8.1: one resolver, not two).

## Rule

> Never move an enforcement decision onto a delivery channel that can drop messages.
