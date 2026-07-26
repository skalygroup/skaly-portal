# ADR-023 — Presence via a single Redis hash with heartbeat freshness

**Status:** Accepted • Pre-Sprint 10 (build impact: Sprint 10 STEP 3)
**Cross-refs:** `02-TRD.md` §8 · `11-THIRD-PARTY-INTEGRATIONS.md` §5.2 (patched here) ·
`13-NFRS.md` §1.3 · `10-INFRA-DEPLOYMENT.md` §10 · ADR-011

> **Numbering note.** The Sprint 10 guide calls this ADR-020; that number is taken by this
> sprint's own ADR-020 (notification count). See ADR-020's numbering note for the mapping.

## Context

Presence is one `presence:{staffId}` string key per staff member with a 60s TTL
(`apps/api/src/sockets/presence.ts`). Reading the roster means a wildcard scan of the keyspace.

**Correction to the ruling as drafted:** the as-built code uses `SCAN`, not `KEYS`
(`presence.ts:44`) — Sprint 8 got that part right, and the ADR should not claim otherwise. But
`SCAN` on a request path is still the wrong primitive: it is O(N) across cursor round-trips,
returns no consistency guarantee, and on Upstash bills per command in a loop. It is harmless at
50 keys and stays invisible until it isn't.

The correct primitive for "the set of currently-online staff" is one key, read once.

## Decision

```
key "presence" (one hash) · field = staffId · value = last-seen epoch ms
```

| Operation | Command | When |
|---|---|---|
| online | `HSET presence {staffId} {Date.now()}` | socket connect, and every heartbeat |
| load | `HGETALL presence`, filtered to `now - lastSeen < 60_000` | roster read |
| offline | `HDEL presence {staffId}` | clean disconnect |
| sweep | expired fields `HDEL`'d in the same pass as the read | every roster read |

- **Heartbeat:** the client emits `presence:ping` every **30s** over the existing
  `/ws/presence` socket; the server calls `markOnline`. Half the freshness window, so one
  dropped beat does not flicker someone offline.

- **The freshness filter is REQUIRED, not optional.** A hash field has no per-field TTL, so the
  hash alone trades a blocking-command problem for a ghost-presence problem. **Storing a
  timestamp rather than `"1"` is what makes expiry work** — this is the whole mechanism, and it
  is the one thing that must not be simplified away.

- **The sweep happens on read.** No separate cron. Without it the hash grows monotonically with
  departed staff, which is how you turn a fixed-size key into an unbounded one.

- **`presence:changed` broadcasts on genuine transitions only** — compare against the previous
  set and emit deltas, never the whole roster on every beat. A 30s heartbeat from 50 users is
  100 broadcasts a minute if you skip this.

- **Freelancer isolation (ADR-011):** a freelancer's presence roster is filtered to the staff
  they can already see. Presence must not become a directory of everyone.

### Deploy note — retiring the old keys

A one-time cleanup, not a data migration. The old per-staff keys expire on their own 60s TTL;
this just tidies immediately:

```bash
redis-cli --scan --pattern 'presence:*' | xargs -r redis-cli DEL
```

`SCAN`, not `KEYS` — and it runs once, off the request path.

`11-THIRD-PARTY-INTEGRATIONS.md` §5.2's key registry is patched in the same commit. A Redis key
registry that lies is worse than none.

## Rule

**No `KEYS`, `SCAN`, or wildcard command on a request path. Ever.** Off the request path, in a
one-shot deploy script, `SCAN` is fine.

## Rationale

Rejected: keeping per-staff keys and accepting the scan. It works today and needs no code. It
was rejected because the fix gets harder as it gets more urgent — the scan is cheap precisely
while nobody is looking at it, and the rewrite lands under load or not at all.
