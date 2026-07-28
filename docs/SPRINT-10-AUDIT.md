# Sprint 10 — Close-out Audit

Written 2026-07-27, after the E2E suite stopped hiding behind a slow dev server and
started failing honestly. Every finding below was **verified against the running system**,
not inferred from reading. Where something was checked and found sound, it is recorded
as a negative finding — a clean check is a result.

Severity is by blast radius in production, not by how loud the test was.

---

## A1 — CRITICAL: in production, every user shares one 150 req/min bucket

`app.ts` registers `@fastify/rate-limit` with `max: env.RATE_LIMIT_MAX` (default **150**)
and **no `keyGenerator`**, so it falls back to `request.ip`. Fastify is constructed as
`Fastify(opts)` with `opts = { loggerInstance: logger }` and **no `trustProxy`**.

Behind Railway's proxy, `request.ip` is the **proxy's** address, not the client's.
Without `trustProxy`, `X-Forwarded-For` is ignored no matter what the platform sends.

**Therefore the entire organisation shares a single 150-requests-per-minute bucket.**

Verified locally:

```
$ curl -sD - -o /dev/null http://localhost:3001/v1/health | grep -i x-ratelimit
x-ratelimit-limit: 150
x-ratelimit-remaining: 149
```

**Sizing.** A portal page load issues roughly five REST calls (module data, `/months`,
`/staff/me`, `/staff` when editable, `/notifications`). 150 ÷ 5 ≈ **30 page loads per
minute for the whole company** before 429s begin. A twenty-person team on a Monday
morning is inside that number.

**The failure mode is the dangerous part.** A 429 never reaches the user as a 429. It
arrives as *"Could not load your profile. Try again."*, a login that times out, or a grid
stuck on its error state. That is exactly how it presented in the E2E suite, and it cost
two wrong diagnoses before a 170-request curl loop named it in seconds.

**Fix:** `trustProxy: true` on the Fastify instance (so `request.ip` is the real client)
**and** a `keyGenerator` keyed on the authenticated `staffId` with the IP as fallback for
unauthenticated routes. Per-user limits are the intent; per-IP was never it. Both belong
in the same change — `trustProxy` alone still lets one office NAT share a bucket.

**Confidence.** The configuration facts are verified. The Railway forwarding behaviour is
reasoned from the absence of `trustProxy`, which is sufficient: Fastify cannot use a
forwarded address it has not been told to trust. Worth confirming against a staging
deploy before sizing the new limit.

---

## A2 — HIGH: a missed realtime event is permanent, on six surfaces

Recorded in the close-out §5b as the mount/subscribe window. The audit escalates it on
one point: **nothing ever corrects it.**

`providers.tsx`:

```ts
new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 } },
})
```

- `refetchOnWindowFocus: false` — returning to the tab does not resync.
- No `refetchInterval`, `refetchOnMount` or `refetchOnReconnect` anywhere in `src`
  (grepped, empty).
- No consumer gates its query on socket state — the only `enabled:` across the five grids
  is `canEdit`, a permissions check.

So a tab that misses an event during the mount/join window is **wrong for the rest of its
lifetime**, until the user navigates away and back or reloads. I previously wrote
"nothing later corrects it" about the bell; it is true of all six surfaces, and it is a
property of the global query config rather than of any component.

**Real-world shape:** A opens Attendance. During A's mount window, B edits a cell. A now
shows stale data indefinitely, with no visual cue that anything is out of date. Silent
wrong data on a shared operational grid is worse than an error.

`staleTime: 60_000` is what makes this survivable-looking in testing — it hides nothing,
it just means the data was *allowed* to be a minute old anyway.

Fix as scoped in close-out §5c (ordering **plus** reconciliation, mount and reconnect as
one mechanism). This finding raises its priority.

---

## A3 — MEDIUM: the rate-limit workaround does not survive a restart

The fix in `playwright.config.ts` (`env: { RATE_LIMIT_MAX: '100000' }`) is correct and
also **fragile in a way worth writing down**, because it bit during this very audit.

`reuseExistingServer: !process.env.CI` means Playwright applies `env` **only to a server
it starts itself**. Any API already listening — one started by hand, or a survivor of an
earlier run — keeps the 150 limit, and the config looks right while the suite fails.

Checked mid-audit, after a full run: the live API reported `x-ratelimit-limit: 150`,
i.e. the raised limit had silently reverted at some point. **A full-suite result taken
while that was true is not trustworthy**, and I cannot now separate how much of the
worst run (144/7) was CPU load versus a reinstated rate limit. Both were present.

**Fix:** assert the environment instead of assuming it — a global-setup check that fails
loudly if `x-ratelimit-limit` is below a threshold, so the suite refuses to run against a
misconfigured API rather than producing a plausible-looking wrong number.

**Lesson:** I attributed that run entirely to machine load. That was a guess presented
with more confidence than it had earned, and this check is what would have caught it.

---

## A4 — MEDIUM: an offboarded employee can never be re-hired

`staff_email_unique` is `UNIQUE (email)` with **no partial predicate**, while `staff`
carries both `deleted_at` and `active` — the same shape as the holiday bug fixed in
migration 030.

**It does not 500**, and that is deliberate. Both staff insert paths pre-check by email:

```
// b. H-04 backstop: a staff row may have appeared (any state) since the
//    request was filed.
.where('email', '=', row.email)      // no deleted_at filter — catches soft-deleted rows
```

The signup request is marked `rejected` with `'Account already exists at approval time'`.

**But the outcome is wrong and the message is a lie.** The account does *not* exist — it
was deleted. A returning employee cannot be re-approved through any flow, and the admin
reviewing the queue is told something untrue about why.

**Fix (Sprint 11, Settings → Staff):** decide the product rule first — reinstate the
existing row, or free the email on delete via a partial index. Either is defensible;
today's behaviour is neither, and it is invisible until the first re-hire.

---

## A5 — LOW: the optimistic-vs-authoritative race was test-side only

Three specs asserted against optimistic writes and then read authoritative state
(content-dropper, content-calendar, shoot-planner). All three are fixed.

**Negative finding — the product is clean here.** All five grids write the server row back
in `onSuccess`, so a second consecutive edit carries a fresh `version`:

| Grid | Write-back |
|---|---|
| attendance | ✅ inline `.map(l => l.id === row.id ? row : l)`, commented "prevents self-inflicted 409s" |
| content-calendar | ✅ | 
| content-dropper | ✅ `replaceRow` |
| shoot-planner | ✅ `replaceSlot` |
| tasks | ✅ |

My first pass flagged attendance as missing it — a regex that did not match the inline
idiom. Reading the code corrected it. Recorded because a grep-shaped "finding" that
nobody opens the file to check is how a clean codebase acquires a false bug report.

---

## A6 — LOW: date-dependent test fixtures

`${PERIOD}-15` is hard-coded as a fixture date in `shoot-planner`, `tasks` and `bot`
specs; `content-calendar` already guards with `TODAY.endsWith('-01') ? -02 : -01`.

The class is proven — the `AttendanceService` backfill test failed this sprint because its
window (today → end-of-period) no longer contained a seeded holiday once the date rolled
past the 15th. The remaining `-15` uses happen to be safe today (the shoot-planner date
input's bounds are period-wide, not future-only — an early theory of mine that the code
disproved).

**Fix:** derive fixture dates from the period the way `content-calendar` does, rather than
pinning a day number. Cheap, and it removes a class of failure that only appears in the
back half of a month.

---

## Negative findings — checked, sound

- **Socket.io handshakes are not rate-limited.** No `x-ratelimit-*` headers on
  `/socket.io/?EIO=4` versus present on `/v1/health`, so the transport attaches beneath
  Fastify's plugins. A1's exposure is REST-only, which materially narrows it.
- **Redis and Postgres were healthy** throughout the failing runs (`PONG`, `Up (healthy)`),
  so the broad socket-delivery failures were not infrastructure.
- **Socket.io is correctly attached** — handshake returns 200 on the default path. An
  earlier 404 was my own error: namespaces (`/ws/notify`) are not URL paths.
- **The approve path handles pre-existing staff in any state** (A4) rather than crashing.
- **No other table pairs a soft-delete column with a non-partial unique index** — only
  `holidays` (fixed, migration 030) and `staff` (A4). `clients`, `messages` and `tasks`
  carry soft-delete columns but no unique constraint that could collide.

---

## Ranked remediation

| # | Finding | Where |
|---|---|---|
| 1 | A1 — `trustProxy` + per-user rate-limit key | **Before any production traffic.** Not Sprint 10.1 — it is a deploy blocker. |
| 2 | A2 — missed events never self-heal | Sprint 10.1 (§5c), priority raised by this audit |
| 3 | A3 — assert the suite's environment | Sprint 10.1, pre-flight |
| 4 | A4 — re-hire is impossible | Sprint 11, Settings → Staff |
| 5 | A6 — date-derived fixtures | Opportunistic |

A1 is the one that does not belong to any sprint. Everything else can wait for its slot;
that one is sitting in front of the first real day of traffic.
