# ADR-024 — Rate limiting is per-user, behind a trusted single proxy hop

**Status:** Accepted • Sprint 10.1 (deploy blocker)
**Cross-refs:** `SPRINT-10-AUDIT.md` A1, `07-API-CONTRACT.md` §2, `08-AUTH-MATRIX.md` §3,
`10-INFRA-DEPLOYMENT.md` §4

> **Numbering note.** The Sprint 10.1 patch guide calls this ADR-021. That number was
> taken by *bot archive attribution* in Sprint 10, as was 022 (*realtime cache
> strategy*). This is **024**, and the guide's "ADR-019 patch-vs-invalidate matrix"
> means **ADR-022** here. Same drift the Sprint 10 guide had (017 → 020).

## Context

The global limiter used `@fastify/rate-limit`'s default key — `request.ip` — and Fastify
was constructed with **no `trustProxy`**. Behind Railway's proxy, `request.ip` is the
proxy's address, so **every request from every user keyed to the same bucket**: one
150/min allowance for the entire organisation.

At roughly five REST calls per portal page load, that is about **30 page loads per minute
company-wide** before 429s begin. A twenty-person team on a Monday morning is inside that
number.

**The failure does not look like a rate limit.** A 429 reaches the user as *"Could not
load your profile. Try again."*, a login that times out, or a grid stuck on its error
state. It cost two wrong diagnoses in the Sprint 10 close-out — first login timing, then
an app-side race — before a 170-request curl loop named it in seconds.

**This was not a missing design.** `08-AUTH-MATRIX.md` §3 already says:

> Login rate limits are keyed by `email + IP`, not IP alone. This prevents a shared
> office IP from blocking all staff simultaneously when 15+ people log in at 9am.

The problem was understood and solved for `/auth/login`, and never generalised to the
global limiter.

## Decision

1. **`trustProxy` is a HOP COUNT (`TRUST_PROXY_HOPS`, default 1), never `true`.**
   `true` trusts every entry in `X-Forwarded-For`, including the leftmost value the
   *client* supplies. Because the unauthenticated fallback key is the IP and login's
   brute-force guard is 10/15min, `true` would let an attacker rotate a header per
   request and **bypass login rate limiting entirely** — a security downgrade disguised
   as a fix. A hop count trusts only the address the proxy itself appends. Configurable,
   so a future CDN layer is a config change rather than a code change.

2. **`keyGenerator` prefers the authenticated staff id**, falling back to `` `ip:${ip}` ``
   for unauthenticated routes. The `ip:` prefix namespaces the fallback so an address can
   never collide with a staff id.

3. **⚠️ The limiter registers at a hook that runs AFTER the caller is identified.**
   This is the part that silently defeats the obvious fix, and it is worse in this
   codebase than the patch guide anticipated:

   - `@fastify/rate-limit` defaults to `onRequest`, which runs before any auth.
   - `verifyJwt` here is a **route-level** `preHandler` that routes opt into — not a
     global hook. Fastify runs **global** `preHandler` hooks *before* route-level ones,
     so even `hook: 'preHandler'` still sees `request.user === undefined`.

   So the fix needs both halves: a **global `preHandler` registered before the limiter**
   that resolves the bearer token into `request.user`, and the limiter at `preHandler`
   after it. The identify hook fails silently — it only chooses a bucket; the route's own
   `verifyJwt` remains the authoritative gate and produces the real 401. `verifyJwt`
   reuses the already-resolved user, so the token is verified once (and
   `verifySupabaseToken` is Redis-cached besides).

4. **`/auth/login` keeps its `email + IP` key** at 10/15min. This ADR generalises that
   design; it does not replace it.

5. **150/min is retained but re-based.** It now means 150 per *user* per minute (~30 page
   loads at ~5 calls each), not 150 org-wide. The number is unchanged; what it counts is
   not. Anyone reading the old figure as "tuned" would be reading it wrong.

## Why behavioural tests only

A test that inspected the config would have passed against the broken build: the
`keyGenerator` was *present and correct* while the hook ordering degraded it to the IP on
every request. Only two users' counters moving independently catches that.

`rate-limit-keying.test.ts` asserts, against the real `buildApp()`:

- two authenticated users have independent buckets;
- one user across two source IPs shares a bucket;
- unauthenticated requests key by IP, namespaced;
- **the ordering guard** — an authenticated call does not decrement the IP bucket.

Proven by breaking: removing the `hook` override fails three of the four, with the
authenticated calls visibly draining the anonymous bucket.

## Rule

> A rate limit whose key is wrong is worse than no rate limit. It fails closed, for
> everyone at once, disguised as unrelated application errors.

## Open point

The audit reasons Railway's forwarding behaviour from the *absence* of `trustProxy`
rather than from observing it. Before launch: deploy to staging, log `request.ip` once on
`/v1/health` behind a debug flag, hit it from two networks, confirm a real client address
resolves, remove the flag. Record the result here.
