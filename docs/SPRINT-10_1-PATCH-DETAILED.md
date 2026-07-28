# SPRINT 10.1 — REMEDIATION PATCH: DETAILED PROMPT-BY-PROMPT GUIDE

## Scaly Business Portal • Patch on Sprint 10

**Companion to `SPRINT-10-DETAILED.md`, `SPRINT-10-AUDIT.md`, and `SPRINT-8_1-PATCH-DETAILED.md` (the patch precedent)**
**Same Goal / Prompt / Verify framework as Sprints 0–10**
**Tooling interfaces verified as of July 2026** — Fastify 5 (`trustProxy`, hook ordering), `@fastify/rate-limit` (`keyGenerator`, `hook`), socket.io v4 (**emit acknowledgements**), TanStack Query v5 (`enabled` gating, `dataUpdatedAt`, no `onSuccess` on `useQuery`), Playwright (`globalSetup`, `page.on('request')`).

> **This is a patch, not a sprint.** Scope is fixed by `SPRINT-10-AUDIT.md` plus the close-out defect Sprint 10 was deliberately held on. No new features. If something isn't in the findings table below, it isn't in this patch.

---

## USING THE `/ponytail` PLUGIN IN THIS PATCH

Placement as established in Sprint 9: **between the build prompt and the test prompt**, on the implementation. Absent from manual steps and ADR authoring.

His highest-value target here is STEP 4 — the shared realtime seam. It replaces per-module improvisation across seven surfaces, and if it lands as a 200-line abstraction with options nobody uses, it will get bypassed within a sprint. It should be small enough that using it is easier than not.

---

## WHY THE ORDER CHANGED FROM THE CLOSE-OUT PLAN

The close-out plan opened with reproducing `notifications.spec.ts:116`. **The audit makes that the wrong first step.**

A3 establishes that the E2E suite has been running against an API whose rate limit silently reverted to 150 — and that a full-suite result taken in that state is not trustworthy. A1 establishes *why* 150 is catastrophic: no `trustProxy`, no `keyGenerator`, so the whole organisation shares one bucket, and a 429 surfaces as *"Could not load your profile"* rather than as a rate-limit error.

**So every measurement this patch would take is currently untrustworthy**, including "is `:116` reproducible" and "do the other six surfaces have the same window." Reproducing a race against an environment that intermittently 429s is how you get a third wrong diagnosis after the two A1 already cost.

Therefore: **A3's environment assertion and A1's fix land first**, before anything is reproduced or measured. The audit is right that A1 "does not belong to any sprint" — but that's a statement about its priority, not its schedule. It is currently corrupting the instrument, so the earliest slot is the correct slot, and there is no production traffic yet to block.

One consequence worth noting: **A1's proper fix substantially dissolves A3's fragility.** Per-user buckets don't collide the way one shared IP bucket does, so `RATE_LIMIT_MAX: 100000` stops being load-bearing. Keep the assertion anyway — it's four lines and it's the check that would have caught the reverted limit.

---

## WHAT THIS PATCH FIXES

| Finding | Severity | What | Step |
|---|---|---|---|
| **A3** | Medium | The suite runs against an unasserted environment; a reverted rate limit produces plausible-looking wrong results | **STEP 1** |
| **A1** | **Critical** | `trustProxy` absent + no `keyGenerator` → the whole org shares one 150/min bucket; 429s present as unrelated UI errors | **STEP 2** → ADR-021 |
| **A2** + close-out §5b/§5c | High | A missed realtime event is **permanent** on every realtime surface — no ordering guarantee, and the global query config has no self-healing path | **STEPS 3–7** → ADR-022 |
| **A6** | Low | Date-pinned fixtures (`${PERIOD}-15`) fail in the back half of a month | **STEP 8** |
| — | — | Password-in-URL blast radius (raised at close-out; not in the audit) | **STEP 9** |
| **A4** | Medium | Offboarded staff can never be re-hired (`staff_email_unique` has no partial predicate) | **Sprint 11** — decision carried below |
| **A5** | Low | Optimistic-vs-authoritative race was test-side only; all five grids write back correctly | **Nothing to do** — recorded as a negative finding |

**Estimated time:** 2 days. Day 1 STEPS 1–5 (environment, A1, the ADRs, the shared seam). Day 2 STEPS 6–10 (migration, reconnect, tests, close-out, the held push).

**Prerequisites:**
- Sprint 10 complete and **unpushed**, held at close-out. Working tree on `sprint-10-chat-notifications` (or wherever the held work sits).
- Everything the close-out reports as fixed is fixed: the rate-limit config change, both optimistic-vs-persisted races, the holiday constraint (migration 030), the password-in-URL bug.
- `notifications.spec.ts:116` still failing, deliberately unfixed.
- Docker up; Redis and Postgres healthy.

---

## READ FIRST (Open in Antigravity Split View)

| Doc | Sections | Why |
|---|---|---|
| `SPRINT-10-AUDIT.md` | **All of it** | The scope of this patch |
| `docs/07-API-CONTRACT.md` | **§2 (rate limit table + the `keyGenerator` note)** | A1's intended design — already written down |
| `docs/08-AUTH-MATRIX.md` | **§3 rate-limiting note** ("keyed by `email + IP`, not IP alone… prevents a shared office IP from blocking all staff at 9am") | The spec already solved this for login and never generalised it |
| `docs/09-ERROR-HANDLING.md` | **§5.4 (network drop + WebSocket reconnect)** | The section this patch amends — it currently prescribes the fix that doesn't work |
| `docs/adr/ADR-019` | All | The patch-vs-invalidate matrix whose reducers STEP 4 reuses |
| `docs/13-NFRS.md` | §1.3, §4.3 | Delivery + reconnect budgets |
| `docs/10-INFRA-DEPLOYMENT.md` | §4 (Railway, `healthcheckTimeout`), §8 | Where `trustProxy` matters |
| `apps/api/src/app.ts` | The Fastify constructor + plugin registration order | A1's fix, and the hook-ordering trap |
| `apps/web/providers.tsx` | The `QueryClient` defaults | A2's "nothing self-heals" property |
| `apps/web/lib/socket.ts` | The Sprint 8 singleton | Where the ack handshake lands |

---

## CONSISTENCY RECONCILIATIONS — LOCK THESE BEFORE YOU PROMPT

1. **`trustProxy: true` is the wrong value.** More on this in STEP 2, but lock it now: `true` trusts *every* address in the chain, so `request.ip` becomes the client-supplied leftmost `X-Forwarded-For` entry. Since the unauthenticated fallback key is the IP, and login's brute-force guard is 10/15min, `true` would let an attacker rotate a header per request and **bypass login rate limiting entirely**. Use a **hop count** (`trustProxy: 1` for Railway's single proxy). This is a security escalation of A1 the audit doesn't make.
2. **The rate limiter's `keyGenerator` runs at `onRequest` by default — before auth populates `request.user`.** A `keyGenerator` of `req.user?.staffId ?? req.ip` registered at the default hook always falls through to IP. The config looks correct and the behaviour is unchanged — precisely the A3 class of failure. The registration hook must run **after** the auth plugin.
3. **The spec already intended per-user limits.** Auth-Matrix §3's note explains the shared-office-IP problem and solves it for `/auth/login` with an `email + IP` key. A1 is not a missing design; it is a design applied to one route and never generalised. Fix it as a generalisation, not an invention.
4. **Error-Handling §5.4 currently prescribes a broken fix.** "On reconnect: all stale TanStack Query data refetched" is invalidate-on-connect — the same race, on every reconnect. §5.4 gets amended in this patch (STEP 6), in the same commit as the code, or Sprint 11 reintroduces it from the doc.
5. **ADR-019 is not superseded.** Its patch-vs-invalidate matrix stands. ADR-022 adds *ordering* and *reconciliation* around it. The `applyEvent` reducers STEP 4 introduces are the same logic ADR-019 already required — now named, and used twice.
6. **`refetchOnWindowFocus: false` stays the global default.** Flipping it globally reintroduces the fan-out problem ADR-019 exists to prevent. It is enabled **only** on realtime-backed queries, where the refetch is bounded and the data is shared and mutable.
7. **A5 is closed.** All five grids write the server row back in `onSuccess`. Do not "fix" attendance's inline `.map` idiom — it is correct, and the audit already records the false positive.

---

## STEP-BY-STEP STRUCTURE

| # | Type | What |
|---|---|---|
| 1 | Manual + Prompt | **A3** — assert the test environment before measuring anything |
| 2 | Prompt | **A1** — `trustProxy` hop count + per-user `keyGenerator` at the right hook → ADR-021 |
| 3 | Manual | Reproduce `:116` deterministically; **size A2's blast radius** across every realtime surface |
| 4 | Prompt | **ADR-022** + the shared seam — acked room join, `useRealtimeQuery`, one `applyEvent` reducer per surface |
| 5 | Prompt | Migrate every consumer onto the seam; delete per-module improvisation |
| 6 | Prompt | Reconnect path (the same mechanism, twice) + **amend Error-Handling §5.4** |
| 7 | Prompt | Tests aimed at the window — mount and reconnect, per surface class |
| 8 | Prompt | **A6** — derive fixture dates from the period |
| 9 | Manual | Password-in-URL blast radius + disposition |
| 10 | Manual | Close-out, the held push, and the A4 hand-off to Sprint 11 |

---

## STEP 1: Assert the test environment (A3)

**Goal:** Make the suite refuse to run against a lying API, before anything downstream is measured.

### 1.1 — Confirm the current state

```bash
docker compose ps                                  # postgres + redis healthy
curl -sD - -o /dev/null http://localhost:3001/v1/health | grep -i x-ratelimit
lsof -i :3001 || ss -ltnp 'sport = :3001'          # is an API already listening?
```

If a hand-started API is on 3001, kill it. `reuseExistingServer: !process.env.CI` means Playwright's `env` block never reaches it.

### 1.2 — Prompt

> **WHERE WE ARE**
>
> Sprint 10.1, STEP 1. The audit (A3) found the E2E suite ran against an API whose rate limit had silently reverted to 150, making a full-suite result untrustworthy — and it could not afterwards be separated from CPU load as a cause. Read `SPRINT-10-AUDIT.md` A3 and `tests/e2e/playwright.config.ts`.
>
> **WHAT TO BUILD**
>
> 1. **`tests/e2e/global-setup.ts`** (wire it as `globalSetup` in `playwright.config.ts`), which **throws** rather than warns:
>    - `GET /v1/health`, read `x-ratelimit-limit`. If it's missing or below a threshold (10,000), throw with an actionable message: the observed value, the likely cause (*"an API started outside Playwright is being reused — `reuseExistingServer` means the `env` block did not reach it"*), and the fix (*"kill anything on :3001 and re-run"*).
>    - Assert the API is reachable and both Postgres and Redis report `ok` in the health payload — the audit had to rule infrastructure out by hand mid-run.
>    - Log the resolved API base URL and the observed limit, so every run's output records what it actually ran against.
> 2. **After STEP 2 lands, extend it**: authenticate as two seeded users, issue one request each, and assert their `x-ratelimit-remaining` values are **independent**. That proves the per-user `keyGenerator` is live — a config-level assertion would pass while the hook ordering silently defeats it (reconciliation #2). Add a `// TODO(STEP 2.4)` marker now and wire it there.
>
> **RULES**
>
> - Throw, don't warn. A warning in a 200-line Playwright preamble is invisible; the point is to make a misconfigured run impossible, not discouraged.
> - The threshold check must not depend on a specific number — assert "raised", not "equals 100000".
>
> Show me `global-setup.ts` and the config wiring.

**Verify:**

```bash
pnpm exec playwright test --list          # global setup runs, prints the limit, exits clean
# Then prove the guard works:
RATE_LIMIT_MAX=150 pnpm --filter @skaly/api dev &   # a "wrong" API
pnpm exec playwright test --list                    # expect: a loud, actionable throw
```

---

## STEP 2: Rate limiting (A1) — ADR-021

**Goal:** Per-user buckets, a trustworthy client IP, and the hook ordering that makes both real.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 10.1, STEP 2. Fixing A1 — **the deploy blocker**. Read `SPRINT-10-AUDIT.md` A1, `docs/07-API-CONTRACT.md` §2 (the rate limit table), `docs/08-AUTH-MATRIX.md` §3 (**the note explaining that login is keyed by `email + IP` precisely to stop a shared office IP blocking everyone at 9am**), `docs/10-INFRA-DEPLOYMENT.md` §4, and `apps/api/src/app.ts`.
>
> Context that shapes the fix: this is not a missing design. The spec understood the shared-IP problem and solved it for `/auth/login`. It was never generalised to the global limiter, which sits on `@fastify/rate-limit`'s default IP key.
>
> **WHAT TO BUILD**
>
> 1. **`trustProxy` — a hop count, not `true`.**
>    ```ts
>    const app = Fastify({ loggerInstance: logger, trustProxy: 1 });
>    ```
>    **Why not `true`:** it trusts every address in the chain, so `request.ip` becomes the client-supplied leftmost `X-Forwarded-For` value. The unauthenticated fallback key is the IP, and login's brute-force guard is 10/15min — with `true`, an attacker rotates a header per request and **bypasses login rate limiting entirely**. A hop count trusts only the address Railway's proxy supplies, which a client cannot forge. Make the hop count configurable (`TRUST_PROXY_HOPS`, default 1) so a future CDN layer is a config change.
>
> 2. **Per-user `keyGenerator` — and register it at a hook that runs *after* auth.**
>    ```ts
>    await app.register(rateLimit, {
>      max: env.RATE_LIMIT_MAX,
>      timeWindow: '1 minute',
>      hook: 'preHandler',                                   // ⚠️ see below
>      keyGenerator: (req) => req.user?.staffId ?? `ip:${req.ip}`,
>    });
>    ```
>    **⚠️ The trap:** `@fastify/rate-limit` defaults to `onRequest`, which runs **before** the auth plugin populates `request.user`. At the default hook this `keyGenerator` always falls through to IP — the config reads as fixed and the behaviour is unchanged. **First determine which hook the auth plugin uses**, then register the limiter strictly after it. State in your answer which hook auth is on and why the one you chose is later.
>
> 3. **Do not change `/auth/login`'s existing `email + IP` limiter.** It is correct and it is the precedent this change generalises.
>
> 4. **Namespace the fallback key** (`ip:` prefix) so an IP string can never collide with a staffId.
>
> 5. **Re-size the limit now that it means something different.** 150/min *per authenticated user* is generous where 150 org-wide was crippling; the audit's ~5 REST calls per page load makes it ~30 page loads per minute per person. Keep 150, and record the new sizing basis in the ADR so nobody re-reads the old number as tuned.
>
> 6. **`ADR-021-rate-limit-keying.md`:**
>    ```
>    # ADR-021 — Rate limiting is per-user, behind a trusted single proxy hop
>    Status: Accepted • Sprint 10.1 (deploy blocker)
>    Cross-refs: SPRINT-10-AUDIT A1, API-CONTRACT §2, AUTH-MATRIX §3, INFRA §4
>
>    Context: the global limiter used @fastify/rate-limit's default IP key with no
>      trustProxy, so behind Railway's proxy every request keyed to the proxy's address —
>      the entire organisation shared one 150/min bucket. A 429 surfaces to users as
>      "Could not load your profile", a hung login, or a grid stuck in its error state,
>      never as a rate limit. It cost two wrong diagnoses before a curl loop named it.
>
>    Decision:
>      1. trustProxy is a HOP COUNT (default 1), never `true`. `true` trusts the
>         client-supplied X-Forwarded-For, and since the unauthenticated fallback key is
>         the IP and login's brute-force guard is 10/15min, that would make login rate
>         limiting bypassable by rotating a header.
>      2. keyGenerator prefers the authenticated staffId, falling back to `ip:{ip}` for
>         unauthenticated routes.
>      3. The limiter registers at a hook that runs AFTER auth. At the default onRequest
>         hook, request.user is unpopulated and the key silently degrades to IP — the fix
>         appears applied and does nothing.
>      4. /auth/login keeps its email+IP key (AUTH-MATRIX §3). This ADR generalises that
>         design; it does not replace it.
>      5. 150/min is retained but re-based: it now means 150 per USER per minute
>         (~30 page loads at ~5 REST calls each), not 150 org-wide.
>
>    Rule: a rate limit whose key is wrong is worse than no rate limit — it fails closed,
>      for everyone, disguised as unrelated application errors.
>    ```
>
> 7. **Tests** `apps/api/test/rate-limit.test.ts`:
>    - Two authenticated users each burn requests; their `x-ratelimit-remaining` counters are **independent** (the assertion that fails today).
>    - The same user across two different source IPs shares one bucket.
>    - An unauthenticated route keys by IP and namespaces with the `ip:` prefix.
>    - **Hook-ordering regression guard:** a request with a valid JWT produces a `staffId`-keyed bucket, not an IP-keyed one. Assert on behaviour (independent counters), not on config.
>    - `/auth/login` still limits at 10/15min by `email + IP`.
>
> **RULES**
>
> - Behaviour-level assertions only. A test that reads the config would pass while the hook ordering defeats it.
> - Do not raise `RATE_LIMIT_MAX` to paper over anything. If a legitimate flow exceeds 150/user/min, that flow is chatty and gets its own finding.
>
> Show me the Fastify constructor, the limiter registration with your hook justification, and the ADR.

`▶ /ponytail` — small surface, but check the `keyGenerator` isn't doing anything beyond choosing a string.

### 2.4 — Wire the deferred global-setup assertion

Return to `global-setup.ts` and replace the `// TODO(STEP 2.4)` with the two-user independent-counter check from STEP 1.2.2.

**Verify:**

```bash
pnpm --filter @skaly/api test rate-limit
# Prove it end to end — 170 requests as one user must NOT lock out a second user:
for i in $(seq 1 170); do curl -s -o /dev/null -H "Authorization: Bearer $TOKEN_A" http://localhost:3001/v1/staff/me; done
curl -sD - -o /dev/null -H "Authorization: Bearer $TOKEN_B" http://localhost:3001/v1/staff/me | grep -i x-ratelimit
# expect: user B unaffected — this is the exact scenario A1 describes
```

> **Staging confirmation (A1's stated open point).** The audit reasons Railway's forwarding behaviour from the absence of `trustProxy` rather than observing it. Before launch, deploy to staging and confirm `request.ip` resolves to a real client address — log it once on `/v1/health` behind a debug flag, hit it from two networks, and remove the flag. Note the result in the ADR.

---

## STEP 3: Reproduce `:116` and size A2's blast radius (manual)

**Goal:** Establish whether this is one bug or seven — now, against an instrument you can trust.

### 3.1 — Deterministic reproduction

```bash
pnpm exec playwright test tests/e2e/notifications.spec.ts:116 --repeat-each=10 --workers=1
```

It should fail consistently, not flakily. If it now passes, the rate limiter was contributing and you need to widen the window artificially (a deliberate delay between context creation and the socket ack) to keep it reproducible while you fix it.

### 3.2 — Enumerate every realtime-backed query

```bash
grep -rln "socket.on\|useSocket\|realtime" apps/web/app apps/web/components apps/web/hooks
grep -rn "enabled:" apps/web --include=*.tsx --include=*.ts | grep -v canEdit
```

Expect the audit's six — five grids plus the bell — plus the chat message list, and presence (a store, not a query, so it needs the ordering fix but not the buffering one). Write the list down; STEP 5 migrates exactly it.

### 3.3 — Prove the window exists beyond the bell

Take **two** grid specs and tighten them: fire the mutating action in context B **immediately** after context A's `page.goto`, with no wait for rendered data. The audit's point is that the grid specs only pass because they wait for data before acting.

If both fail, this is one bug with seven instances and the shared-seam approach is justified. If neither does, investigate before building an abstraction for a problem you have one instance of.

Record the outcome — STEP 4's prompt needs it.

---

## STEP 4: The shared seam (ADR-022)

**Goal:** One mechanism, correct at mount and at reconnect, small enough that nobody routes around it.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 10.1, STEP 4. Building the realtime subscription seam. Read `SPRINT-10-AUDIT.md` A2, `SPRINT-10-DETAILED.md` close-out §5b/§5c, `docs/adr/ADR-019`, `docs/09-ERROR-HANDLING.md` §5.4, `apps/web/lib/socket.ts`, and `apps/web/providers.tsx`.
>
> My STEP 3.3 finding: **[paste — how many surfaces exhibit the window]**.
>
> **The defect, precisely.** Two gaps, not one:
> - **Pre-join:** mount issues a fetch; the socket joins its room milliseconds later; anything emitted in between reaches nobody and isn't in the snapshot.
> - **In-flight:** even with the room joined first, an event arriving *while the initial fetch is in flight* patches the cache, and then the fetch — a server snapshot taken before that event — resolves and overwrites it.
>
> Ordering alone closes only the first. That is why the obvious fix (invalidate on connect) made things worse: it moved the race later and made it rarer, which is worse than leaving it visible.
>
> **And A2's escalation:** nothing corrects it afterwards. `providers.tsx` sets `refetchOnWindowFocus: false`, there is no `refetchOnReconnect` or `refetchInterval` anywhere, and no consumer gates on socket state. A tab that misses an event is wrong for the rest of its lifetime, silently, on a shared operational grid.
>
> **WHAT TO BUILD**
>
> 1. **Acked room membership** — `apps/web/lib/socket.ts`:
>    - Client emits `room:join` with the rooms it needs and a **Socket.io acknowledgement callback**; the server joins and acks. Membership is confirmed, not assumed.
>    - Expose `useSocketRooms(rooms): { subscribed: boolean }`.
>    - On `disconnect`, `subscribed` → `false`. On `connect`, re-emit and re-ack. **One mechanism, used at mount and at reconnect** — the reconnect path is not a separate code path.
>    - Preserve the Sprint 8 C-05 refresh handshake.
>
> 2. **`useRealtimeQuery`** — `apps/web/hooks/useRealtimeQuery.ts`. The reconciliation happens **inside the query function**, so reconciled data is what enters the cache and there is no window at all:
>    ```ts
>    const queryFn = async (ctx) => {
>      buffer.current = [];
>      collecting.current = true;          // socket handler buffers instead of patching
>      const snapshot = await fetcher(ctx);
>      collecting.current = false;
>      return buffer.current.reduce(applyEvent, snapshot);   // replay onto the snapshot
>    };
>    ```
>    - Gate with `enabled: subscribed && (opts.enabled ?? true)` — TanStack's own flag does the sequencing; no bespoke orchestration.
>    - While `collecting` is true, the socket handler pushes to the buffer. Otherwise it patches the cache via `setQueryData`.
>    - **Do not** drain in a `useEffect` on `dataUpdatedAt`. That leaves a gap between the fetch resolving and the drain running. Replaying inside `queryFn` closes it completely.
>    - Enable `refetchOnWindowFocus: true` **on this hook only**. It is the cheap self-healing net A2 says is missing, and scoping it here keeps `providers.tsx`'s global `false` intact so ADR-019's fan-out concern is untouched.
>
> 3. **⭐ One `applyEvent` reducer per surface, used twice.** `(snapshot, event) => snapshot` — pure, no cache access. The **same** function does live patching and buffer replay. This is not new logic: it is exactly what ADR-019's matrix already required, now named and reused. Invalidate-only events (per ADR-019: the H-01 holiday cascade, task create/update/assign) return a sentinel that tells the hook to invalidate rather than patch, so the matrix stays in one place.
>
> 4. **`ADR-022-realtime-subscription-ordering.md`:**
>    ```
>    # ADR-022 — Subscribe before fetch, and reconcile in flight
>    Status: Accepted • Sprint 10.1
>    Cross-refs: SPRINT-10-AUDIT A2, ADR-019, ERROR-HANDLING §5.4 (amended), NFR §1.3
>
>    Context: realtime consumers fetched on mount and joined their room after the
>      handshake. Events in that gap reached nobody and were absent from the snapshot.
>      Nothing corrected it afterwards — refetchOnWindowFocus is false globally, there is
>      no refetchOnReconnect or refetchInterval, and no consumer gated on socket state —
>      so an affected tab stayed silently wrong for its whole lifetime.
>
>      Two gaps, not one. Ordering closes the pre-join gap. It does not close the
>      in-flight gap: an event arriving during the initial fetch patches the cache, then
>      the fetch resolves from a pre-event snapshot and overwrites it. Fixing only the
>      first moves the race later and makes it rarer — worse, because it then survives
>      the suite and presents as an unreproducible "sometimes it doesn't update".
>
>    Decision:
>      1. Room membership is ACKED. The query is gated on confirmed membership via
>         TanStack's `enabled`.
>      2. Events arriving while the initial fetch is in flight are BUFFERED and replayed
>         onto the snapshot INSIDE the query function, so reconciled data is what enters
>         the cache. Draining in an effect after resolution leaves a gap.
>      3. ONE applyEvent reducer per surface serves both live patching and replay. It is
>         the same logic ADR-019's matrix already required.
>      4. Mount and reconnect are the SAME mechanism. Reconnect sets subscribed=false,
>         rejoins with ack, and re-runs the gated query — which re-buffers and replays.
>      5. refetchOnWindowFocus is enabled on realtime-backed queries only, as the
>         self-healing net. The global default stays false (ADR-019 fan-out).
>      6. ERROR-HANDLING §5.4 is amended in the same commit: its "on reconnect, refetch
>         all stale data" prescribes invalidate-on-connect, which has this exact race on
>         every reconnect.
>
>    Rule: never issue the initial fetch before membership is confirmed, and never let a
>      snapshot overwrite an event that arrived after it was taken.
>    ```
>
> **RULES**
>
> - Keep the hook small. It replaces improvisation on seven surfaces; if it grows options nobody uses, it will be bypassed within a sprint.
> - `applyEvent` is pure. No `queryClient` inside it — that's what makes it reusable for replay.
> - Reconnect must not be a second code path.
>
> Show me `useSocketRooms`, then `useRealtimeQuery` with the in-queryFn replay, then one `applyEvent`.

`▶ /ponytail` — the highest-value target in this patch. The buffer/collecting refs plus the enabled gate plus the reducer dispatch will want to be four hooks. Ask him how much of it is genuinely one.

**Verify:**

```bash
pnpm --filter @skaly/web test hooks/useRealtimeQuery
pnpm typecheck
```

---

## STEP 5: Migrate every consumer

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 10.1, STEP 5. Migrating every realtime surface onto the STEP 4 seam. My STEP 3.2 inventory: **[paste the list]**.
>
> **WHAT TO BUILD**
>
> 1. Convert each surface's `useQuery` to `useRealtimeQuery`, supplying its rooms and its `applyEvent` reducer.
> 2. **Extract the existing patch logic into the reducer.** The bodies of the current `socket.on` handlers already contain it — move, don't rewrite, so ADR-019's matrix carries over unchanged and this patch introduces no behaviour drift.
> 3. **Delete every per-module socket subscription** the hook now owns. Leaving one behind means double-applied patches, which is the failure mode ADR-019 rule (b) already warns about.
> 4. **Presence** takes the ordering fix (gate on `subscribed`) but not the buffering — it's a store, not a query, and its events are absolute state rather than deltas. Say so in a comment so the asymmetry reads as deliberate.
> 5. Grep confirmation that no consumer subscribes outside the hook:
>    ```bash
>    grep -rn "socket.on(" apps/web --include=*.tsx --include=*.ts | grep -v lib/socket.ts | grep -v useRealtimeQuery
>    ```
>
> **RULES**
>
> - Move the logic; don't rewrite it. This patch fixes ordering, not behaviour.
> - One subscription path. If a component still calls `socket.on` directly, it isn't migrated.
>
> Show me the two most different surfaces — the bell and the content calendar — then the grep.

`▶ /ponytail` — seven reducers extracted from seven handlers. Ask which of them are genuinely the same shape and whether the differences are real or historical.

**Verify:**

```bash
pnpm --filter @skaly/web test
pnpm exec playwright test tests/e2e/notifications.spec.ts:116 --repeat-each=10   # green, 10/10
```

---

## STEP 6: Reconnect + amend Error-Handling §5.4

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 10.1, STEP 6. Reconnect, and the doc that currently prescribes the broken fix. Read `docs/09-ERROR-HANDLING.md` §5.4, `docs/adr/ADR-022`, `docs/13-NFRS.md` §1.3.
>
> **WHAT TO BUILD**
>
> 1. **Reconnect reuses the mount path.** On `connect` after a drop: `subscribed = false` → re-emit `room:join` → await ack → `subscribed = true` → the gated query re-runs, buffering and replaying as at mount. **No separate reconnect branch.** Keep Socket.io's built-in backoff (1s → 2s → 4s → 8s, max 30s) — it already matches §5.4.
> 2. **The banner clears on ack, not on `connect`.** Between socket connect and room ack the client is connected but not subscribed; clearing early tells the user they're live when they aren't.
> 3. **Amend `docs/09-ERROR-HANDLING.md` §5.4** — replace:
>    ```
>    On reconnect: all stale TanStack Query data refetched
>    ```
>    with the sequenced version:
>    ```
>    On reconnect:
>      1. Socket reconnects (backoff 1s → 2s → 4s → 8s, max 30s)
>      2. Client re-emits room:join and AWAITS the server acknowledgement
>      3. Only then are stale queries refetched — events arriving during the refetch are
>         buffered and replayed onto the result (ADR-022)
>      4. The reconnecting banner clears on ack, not on connect
>    Refetching before membership is confirmed reintroduces the mount-window race on
>    every reconnect. See ADR-022.
>    ```
>    Add a cross-ref to ADR-022 in §5.4's header.
> 4. **Same commit.** The code and the doc amendment ship together, or Sprint 11 reintroduces the race from a spec that still says to.
>
> **RULES:** one mechanism, two entry points. Don't reimplement backoff.
>
> Show me the reconnect handler and the §5.4 diff.

**Verify:**

```bash
grep -n "all stale TanStack Query data refetched" docs/09-ERROR-HANDLING.md   # expect: nothing
pnpm --filter @skaly/web test
```

---

## STEP 7: Tests aimed at the window

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 10.1, STEP 7. Tests that aim at the window deliberately — the audit's point is that the grid specs pass only because they wait for rendered data before acting.
>
> **WHAT TO BUILD**
>
> 1. **Unit — `useRealtimeQuery`:**
>    - The query does **not** fire before the room ack resolves.
>    - An event delivered **during** the in-flight fetch is present in the cached result afterwards. *(The in-flight gap — the one ordering alone doesn't close.)*
>    - A pre-join event, then the ack, then the fetch → the snapshot contains it (it was in the server's state).
>    - An invalidate-only event triggers `invalidateQueries`, not `setQueryData` (ADR-019 preserved).
>    - `applyEvent` is pure — same input, same output, no cache access.
>    - On disconnect → reconnect, the query re-runs **after** the new ack, not before.
>
> 2. **E2E — per surface class**, two contexts, event fired **immediately** after `page.goto` with no wait for rendered data:
>    - **Bell** — `notifications.spec.ts:116`, now green.
>    - **Patch-path grid** (content calendar) — B's cell updates and B issues **no** additional GET (`page.on('request')`).
>    - **Invalidate-path grid** (attendance holiday) — B **does** refetch and every staff column flips.
>    - **Chat** — a message sent during B's mount appears.
>    - **Reconnect** — drop B's socket, mutate in A, restore → B catches up; assert the banner clears **after** the ack.
>    - Run each with `--repeat-each=5`. A race that passes once proves nothing.
>
> 3. **A regression guard for the wrong fix.** A test asserting that a bare `invalidateQueries` on connect — without the ack gate — leaves the cache stale. The close-out already documents that trap; this makes it executable, so the next person who reaches for it gets a red test instead of a plausible-looking diff.
>
> **RULES:** every test fails without its fix. Fire events inside the fetch flight, not after it — a test that waits for rendered data is testing nothing.
>
> Show me the in-flight test and the wrong-fix guard first.

**Verify:**

```bash
pnpm --filter @skaly/web test
pnpm exec playwright test --repeat-each=5     # ENTIRE suite, 5×
```

---

## STEP 8: Date-derived fixtures (A6)

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 10.1, STEP 8. A6 — `${PERIOD}-15` is pinned in the `shoot-planner`, `tasks` and `bot` specs. `content-calendar` already guards correctly with `TODAY.endsWith('-01') ? -02 : -01`. The class is proven: the `AttendanceService` backfill test failed this sprint when its today→end-of-period window no longer contained a seeded holiday after the 15th.
>
> **WHAT TO BUILD**
>
> 1. A shared helper in the E2E fixtures — `datesInPeriod(period)` returning `{ early, mid, late, safeFuture, safePast }`, each derived from the period and today's position within it, never a pinned day number.
> 2. Migrate the three specs; migrate `content-calendar`'s inline guard onto the helper so there's one implementation.
> 3. Audit `apps/api/test/` for the same class — the backfill test proves it isn't E2E-only.
> 4. **Prove it:** run the suite with the system clock faked to the 1st, the 15th, and the 28th of the current period.
>
> **RULES:** derive from the period, never pin a day. If a test needs "a date in the future within this period", the helper answers that, not the author.
>
> Show me the helper and one migrated spec.

**Verify:**

```bash
grep -rn '\-15`\|-15"' tests/e2e apps/api/test | grep -i period    # expect: nothing
pnpm exec playwright test
```

---

## STEP 9: Password-in-URL blast radius (manual)

Raised at close-out, not in the audit — so it needs an explicit disposition rather than an assumption.

1. **Where did it run?** Test helper only, or application code?
   ```bash
   git log -S "password=" --oneline -- apps/ tests/
   git log -p --all -S "password=" | head -100
   ```
2. **Did it reach a deployed environment?** Pino logs `request.url`, so any such request may be in Railway's structured logs. Check staging and production log retention for the pattern.
3. **Were the credentials real?** Seeded test credentials are a different fact from staff passwords.
4. **Disposition, written down:**
   - Confined to a test helper with seeded credentials → record that and close it.
   - Reached a deployed environment with real credentials → rotate the affected passwords, invalidate the sessions (NFR §4.1: password reset invalidates all sessions for that user), and note the log-retention window.
5. Add the finding and its disposition to `ADR-021` as a short "related" section, or its own note. *"We found it and it was contained"* is a materially different claim from *"we found it"*, and only one of them is closeable.

---

## STEP 10: Close-out and the held push

### 10.1 — Manual verification

1. **A1:** 170 requests as user A; user B unaffected. `x-ratelimit-limit` present; a request through the proxy resolves a real client IP.
2. **A3:** start an API by hand at the default limit → the suite **refuses to run** with an actionable message.
3. **A2, patch path:** two windows, DevTools Network open. Mutate in A **the instant** B's page loads → B updates, **no additional GET**.
4. **A2, invalidate path:** holiday added during B's mount → B refetches, all columns flip.
5. **Reconnect:** drop B's socket, mutate in A, restore → B catches up; the banner clears **after** the ack, not before.
6. **The self-healing net:** switch away from the tab, mutate in A, switch back → the data corrects (`refetchOnWindowFocus` on realtime queries).
7. **A6:** suite green with the clock faked to the 1st, 15th and 28th.
8. **NFR §1.3 re-measured** now that the instrument is trustworthy: WS delivery < 500ms, presence < 2s, reconnect < 30s. The Sprint 10 numbers were taken under a possibly-reverted rate limit and should not be carried forward.

`▶ /ponytail` — full-patch review before the checklist.

### 10.2 — Close-out checklist

```
A3 — ENVIRONMENT
  [ ] global-setup asserts a raised rate limit and throws (not warns) with an actionable message
  [ ] Asserts Postgres + Redis healthy; logs the API base URL and observed limit each run
  [ ] Two-user independent-counter assertion wired (STEP 2.4)
  [ ] Guard proven: a wrong API makes the suite refuse to start

A1 — RATE LIMITING (ADR-021) — DEPLOY BLOCKER
  [ ] trustProxy is a HOP COUNT, configurable; NOT `true`
  [ ] keyGenerator prefers staffId, falls back to namespaced `ip:{ip}`
  [ ] ⚠️ Registered at a hook AFTER auth — justified in writing, asserted by behaviour
  [ ] Two users have independent buckets (TESTED)
  [ ] One user across two IPs shares a bucket (TESTED)
  [ ] /auth/login keeps its email+IP key, still 10/15min (TESTED)
  [ ] 150/min re-based as per-user in the ADR
  [ ] Staging confirmation of real client IP scheduled before launch

A2 — REALTIME (ADR-022)
  [ ] Room membership ACKED; query gated on confirmed membership
  [ ] In-flight events buffered and replayed INSIDE queryFn (not in an effect)
  [ ] ⭐ One applyEvent reducer per surface, used for BOTH live patch and replay
  [ ] ADR-019's matrix preserved — invalidate-only events still invalidate (TESTED)
  [ ] Reconnect reuses the mount path; no separate branch
  [ ] Banner clears on ACK, not on connect
  [ ] refetchOnWindowFocus enabled on realtime queries ONLY; global default still false
  [ ] Every surface migrated; no socket.on outside the seam (grep clean)
  [ ] Presence gated on subscribed; buffering deliberately omitted, with a comment
  [ ] notifications.spec.ts:116 green at --repeat-each=10
  [ ] In-flight event test green (the gap ordering alone doesn't close)
  [ ] Wrong-fix regression guard in place (bare invalidate-on-connect leaves cache stale)
  [ ] ERROR-HANDLING §5.4 amended IN THE SAME COMMIT; old wording gone (grep clean)

A6 — FIXTURES
  [ ] datesInPeriod helper; three specs migrated; content-calendar's inline guard folded in
  [ ] apps/api/test audited for the same class
  [ ] Suite green with the clock at the 1st, 15th and 28th

PASSWORD-IN-URL
  [ ] Blast radius determined and WRITTEN DOWN (test-only vs deployed; real vs seeded)
  [ ] Rotation performed if warranted; log-retention window noted

CARRIED FORWARD
  [ ] A4 recorded as a Sprint 11 decision (below), not silently deferred
  [ ] A5 recorded as a negative finding — nothing to change

SUITE
  [ ] pnpm typecheck + pnpm lint clean
  [ ] Full API suite green
  [ ] Full Playwright suite green at --repeat-each=5, workers=1 AND default
  [ ] NFR §1.3 re-measured against a trustworthy environment
  [ ] /ponytail run at each build step — no outstanding flags
```

### 10.3 — Commit and the held push

```bash
git add -A
git commit -m "Sprint 10.1: per-user rate limiting behind a trusted proxy hop (ADR-021, A1 deploy blocker); subscribe-before-fetch with in-flight replay across all realtime surfaces (ADR-022, A2); assert the E2E environment (A3); date-derived fixtures (A6); amend ERROR-HANDLING §5.4"
git push -u origin sprint-10-chat-notifications
```

Open the PR to `main` — Sprint 10 **and** 10.1 together. CI fully green before merge. This is the push Sprint 10 was held on; it now goes out with the defect fixed rather than documented.

---

## DECISIONS TO MAKE BEFORE SPRINT 11

- **⚠️ A4 — an offboarded employee can never be re-hired.** `staff_email_unique` is `UNIQUE (email)` with no partial predicate, while `staff` carries both `deleted_at` and `active` — the same shape as the holiday bug fixed in migration 030. It doesn't 500, because both insert paths pre-check by email with no `deleted_at` filter (the H-04 backstop) and mark the signup request `rejected` with *"Account already exists at approval time"*. **The outcome is wrong and the message is untrue** — the account doesn't exist, it was deleted — and the admin reviewing the queue is told something false about why. Sprint 11 builds Settings → Staff, which is exactly where this surfaces. Decide the product rule first: **(a)** reinstate the existing row on re-approval, or **(b)** free the email on delete via a partial unique index. Either is defensible; today's behaviour is neither, and it is invisible until the first re-hire. *Recommendation: (a) — it preserves the audit trail and the historical operational data that ADR-001 exists to keep, where (b) permits two rows for one person and breaks that continuity.*

- **⚠️ Client lifecycle is one-way** (carried from the Sprint 10 gate, unanswered). No reactivate endpoint, no `reactivate_client` tool, no spec — yet Sprint 5's backfill contemplated "created **or reactivated**", and Settings → Clients is where an admin will expect an undo. *Recommendation: add reactivate — the backfill logic already exists from `create`, and a one-way destructive action with no undo in an admin panel generates a support request in week one.* **Note the symmetry with A4**: staff and clients have the same lifecycle gap. Decide them together and apply one rule.

- **⚠️ PDF generation is the first CPU-bound request on the API server** (carried, unanswered). NFR §1.2 budgets p95 < 10s / p99 < 20s; `@react-pdf/renderer` renders synchronously on the event loop, so a 15s render blocks every other request on the single Railway instance — including health checks (`healthcheckTimeout = 30`, Infra §4). **A1 sharpens this:** with per-user rate limiting now correct, a blocked event loop no longer even presents as throttling — it presents as everyone's requests hanging. Decide the execution model before writing any PDF code: **(a)** inline with a hard timeout and concurrency cap of 1, **(b)** a worker thread, or **(c)** async job + `report_ready` notification + presigned link. *Recommendation: (c). `report_ready` is already in the enum and `REPORT_EXPIRY_SECONDS` is 24h precisely so notification links survive a working day — the spec has been designed for it since the schema was written.*

- **Audit log export at ~50k rows** (carried). Stream CSV via a cursor rather than buffering — a 50k-row buffered response is a memory spike on the same instance that's now also rendering PDFs.

- **The 5-minute permissions cache vs. the Settings → Permissions UI** (carried). Admins will toggle a permission and immediately test it. Confirm invalidation fires on every write path the new UI uses, and decide whether Sprint 11 adds the push event 8.1 STEP 3.4 deferred, now that a UI makes permission changes routine.

- **Still deferred, on schedule:** comment system + `new_comment` producer (Sprint 12), attachment orphan cron + `coming_shoot_date` rollover recompute (Sprint 12), rollover + its four notification types (Sprint 12–13), Socket.io Redis adapter verification before any second API instance.

- **⚠️ Pre-launch gate — the recovery-code redeem path.** Carried since Sprint 8 STEP 8.4, now through four sprints. Codes are generated and stored; there is no redeem flow. MFA is mandatory for admin and manager, and the only recovery is another admin resetting it (Auth-Matrix §10) — which fails if the only admin is locked out. This needs an owner before launch, not another deferral.

---

## TROUBLESHOOTING — SPRINT 10.1 SPECIFIC

### The rate-limit fix is deployed and everyone still shares a bucket
The `keyGenerator` is registered at the default `onRequest` hook, which runs before auth populates `request.user`, so it always falls through to IP. Register the limiter after the auth plugin. The config reads as correct; only a behavioural test catches it.

### After setting `trustProxy`, rate limits stop working entirely
You used `true`. It trusts the client-supplied `X-Forwarded-For`, so every request keys to whatever the caller claims. Use a hop count. On Railway that's `1`.

### `:116` passes now but the other surfaces still miss events
Only the bell was migrated. The window is a property of the mount/fetch/join sequence, not of any component — every surface needs the seam (STEP 5), and the grep for stray `socket.on` calls is how you confirm it.

### An event arrives during the initial fetch and is still lost
The replay is draining in a `useEffect` on `dataUpdatedAt` rather than inside `queryFn`. That leaves a gap between the fetch resolving and the drain running. Replay onto the snapshot *before* returning it.

### Patches are applied twice
A per-module `socket.on` survived the migration alongside the hook's subscription. Grep for `socket.on` outside `lib/socket.ts` and the seam.

### The reconnect banner clears but the data is stale
It's clearing on `connect` instead of on the room ack. Between those two the client is connected and unsubscribed — the worst state to tell a user they're live in.

### The suite passes locally and fails in CI, or vice versa
Check global-setup's logged rate limit for both. `reuseExistingServer: !process.env.CI` means local and CI can be running against differently-configured APIs, which is the ambiguity A3 exists to remove.

### A test in the back half of the month fails on a date
A6 — a pinned `-15`. Use `datesInPeriod`.

---

## END OF SPRINT 10.1 PATCH GUIDE

*Companion to `SPRINT-10-DETAILED.md` and `SPRINT-10-AUDIT.md`. Source-of-truth precedence: the numbered spec docs (`01`–`14`) + the schema win, then this patch's reconciliations and the ADRs it executes (019, 021, 022), then the Master Build Guide's shorthand. Two findings here share a shape worth remembering: A1 and A2 were both invisible because they failed as something else — a rate limit presenting as "could not load your profile", a missed event presenting as data that was merely a little old. Both cost wrong diagnoses before the right one. The instrument fixes (A3's assertion, STEP 7's window-aimed tests) matter as much as the defect fixes, because the next one of these will also arrive wearing a disguise.*
