# Sprint 10.1 — Remediation Patch Close-out

A patch, not a sprint. Scope fixed by `SPRINT-10-AUDIT.md` plus the defect Sprint 10 was
deliberately held on. Everything below was verified against the running system; where a
claim is inferred rather than observed, it says so.

---

## 1. RECONCILIATIONS THE PATCH GUIDE GOT WRONG

| Guide says | Reality | Used |
|---|---|---|
| New `ADR-021` (rate limit) | **taken** — bot archive attribution (Sprint 10) | **ADR-024** |
| New `ADR-022` (realtime ordering) | **taken** — realtime cache strategy (Sprint 10) | **ADR-025** |
| "ADR-019 = the patch-vs-invalidate matrix" | ADR-019 is query-tool id serialisation; the matrix is **ADR-022** | ADR-022 |
| `docs/adr/` | does not exist | `docs/decisions/` |
| `tests/e2e/`, `apps/web/hooks/`, `apps/web/providers.tsx` | no `src/` segment in any of them | `apps/web/tests/`, `apps/web/src/lib/hooks/`, `apps/web/src/components/providers.tsx` |
| `playwright test --list` verifies globalSetup | **`--list` does not run globalSetup** — the guide's verify step would have passed against a broken guard | verified with a real run |

### ⚠️ The one that would have shipped a no-op

The guide's fix for A1 is `hook: 'preHandler'` on the rate limiter. **That alone does not
work in this codebase.**

`verifyJwt` is a **route-level** `preHandler` that routes opt into — not a global hook.
Fastify runs global `preHandler` hooks *before* route-level ones, so a limiter registered
at `preHandler` still sees `request.user === undefined` and its key silently degrades to
the IP. The config would read as fixed while nothing changed — the exact A3 class of
failure the patch exists to eliminate.

The fix needs a second half the guide does not mention: a **global `preHandler`
registered before the limiter** that resolves the bearer token into `request.user`. Only
a behavioural test catches the difference, which is why every assertion in
`rate-limit-keying.test.ts` is about counters moving, never about config.

---

## 2. WHAT LANDED

| Finding | Status |
|---|---|
| **A1** — one org-wide rate-limit bucket (deploy blocker) | ✅ Fixed → ADR-024 |
| **A3** — suite ran against an unasserted environment | ✅ Fixed; caught a reused 150-limit API **three times** during this patch |
| **A2** / close-out §5b — missed realtime events are permanent | ✅ Seam built, 6 surfaces migrated → ADR-025 · ⚠️ chat partial (below) |
| **A6** — date-pinned fixtures | ✅ `periodDates()` helper; 3 specs migrated |
| Password-in-URL blast radius | ✅ Traced in the audit: app code, staging only, CI account, no production deploy |
| **A4** — offboarded staff cannot be re-hired | ➡️ Sprint 11 decision (unchanged) |
| **A5** — optimistic-write race | ➡️ Nothing to do; negative finding confirmed |

---

## 3. THE DEFECT SPRINT 10 WAS HELD ON

`notifications.spec.ts:116` — a second tab opened moments before a notification never
showed a badge.

| | Before | After |
|---|---|---|
| `--repeat-each=10` | **3 failed / 10** | **10 passed / 10** |

---

## 4. WHAT THE EVIDENCE ACTUALLY SHOWED — AND DIDN'T

**STEP 3's blast-radius gate came back negative, and that matters.**

The audit claims all six realtime surfaces share the window. The structural half is
**verified**: no consumer gated its query on socket state, `refetchOnWindowFocus` is
`false` globally, and there is no `refetchInterval`/`refetchOnMount`/`refetchOnReconnect`
anywhere — so a missed event could never self-heal.

The empirical half is **not**. Three attempts to reproduce the window on a grid all
passed, and two of those probes were wrong in ways worth recording:

1. the first counted the observer's **own mount fetch**, making `gets > 0` trivially
   true — it "passed" while measuring nothing;
2. the second fired the event **before** the snapshot was taken, so the fetch simply
   included it. Correct data, no event required.

The band between "snapshot taken" and "room joined" is only tens of milliseconds on a
warm local stack. The guide's rule for this outcome is explicit — *"investigate before
building an abstraction for a problem you have one instance of"* — so it was put to the
owner as a decision rather than assumed. **The call was to build all seven.**

The honest position: **one instance proven, five inferred from verified structural
facts.** `realtime-window.spec.ts` now holds the window open deliberately (by delaying
B's socket handshake at the network layer) so the property is testable without relying
on a coin-flip race.

---

## 5. ⚠️ CHAT IS A PARTIAL MIGRATION

Chat's message list is a `useInfiniteQuery`; `useRealtimeQuery` is built on `useQuery`.

- **Pre-join gap:** closed.
- **In-flight gap:** **not closed** — buffering pages rather than a single snapshot is a
  different problem.

Stated here and in ADR-025's scope table because a reader comparing the matrix to the
code would otherwise conclude chat has replay when it does not. It needs an
infinite-query variant of the seam, and that is a change of its own.

---

## 6. THE WRONG FIX, MADE EXECUTABLE

`invalidate-on-connect` is the fix everyone reaches for, `09-ERROR-HANDLING` §5.4
prescribed it, and it is wrong: the refetch is issued before membership is
re-established, so it can resolve from a snapshot predating an event that arrived in the
meantime and overwrite it. Tried in Sprint 10 — it turned one failing assertion into two.

Three things now stand in the way of it coming back:

1. **§5.4 is amended** in the same commit as the code, with the reasoning inline.
2. **`use-connection-state` no longer calls `invalidateQueries()` on connect** — that
   code existed and matched the spec.
3. **The banner test that asserted the old behaviour is now a regression guard against
   it.** The next person to reach for it gets a red test rather than a plausible diff.

---

## 7. BUGS WRITTEN AND CAUGHT DURING THIS PATCH

Recorded because "the tests caught it" is only meaningful if the misses are listed too.

- **Reconnect resync used "were we subscribed last render"** instead of "have we ever
  been subscribed". That makes every reconnect look like a first subscribe, so the
  resync would never fire. Written first, caught by its own test, fixed.
- **The first window probe counted the mount fetch** (§4).
- **A grep-shaped false positive** in the audit claimed `attendance-grid` never wrote
  back the authoritative row. Reading the file disproved it — the write-back is inline,
  with a comment about preventing self-inflicted 409s.

---

## 8. CLOSE-OUT CHECKLIST

```
A3 — ENVIRONMENT
  [x] global-setup THROWS (not warns) with an actionable message
  [x] Asserts Postgres + Redis healthy; logs API base + observed limit every run
  [x] Two-caller independent-bucket assertion wired (STEP 2.4)
  [x] Guard proven — it fired on a real reused API three separate times

A1 — RATE LIMITING (ADR-024) — DEPLOY BLOCKER
  [x] trustProxy is a HOP COUNT (TRUST_PROXY_HOPS, default 1), never `true`
  [x] keyGenerator prefers staffId, falls back to namespaced `ip:{ip}`
  [x] ⚠️ Registered AFTER a global identify hook — the guide's fix alone was a no-op
  [x] Two users have independent buckets (TESTED)
  [x] One user across two IPs shares a bucket (TESTED)
  [x] Unauthenticated keys by IP, namespaced (TESTED)
  [x] Hook-ordering regression guard (TESTED — fails without the fix)
  [x] 150/min re-based as per-user in ADR-024
  [ ] Staging confirmation of a real client IP — before launch, noted in ADR-024

A2 — REALTIME (ADR-025)
  [x] Room membership ACKED; server-side join awaited (async under the Redis adapter)
  [x] Query gated on confirmed membership via TanStack `enabled`
  [x] In-flight events buffered and replayed INSIDE queryFn, not in an effect
  [x] One pure applyEvent per surface, used for BOTH live patch and replay
  [x] ADR-022's matrix preserved — invalidate-only events still invalidate (TESTED)
  [x] Reconnect reuses the mount path; no separate branch (TESTED)
  [x] Banner clears on ACK, not on connect
  [x] refetchOnWindowFocus on realtime queries ONLY; global default still false
  [x] use-realtime-sync.ts DELETED — one subscription path, not two
  [x] Degraded fallback so a blocked socket cannot hide the page forever
  [x] §5.4 amended IN THE SAME COMMIT
  [x] notifications.spec.ts:116 green at --repeat-each=10
  [x] Wrong-fix regression guard in place
  [~] Chat: ordering only — §5

A6 — FIXTURES
  [x] periodDates() helper; 6 tests at the 1st / 15th / 28th / last day / Feb / leap
  [x] Three specs migrated off ${PERIOD}-15
  [x] apps/api/test audited — pinned dates exist but none are window-dependent

SUITE
  [x] typecheck clean · lint clean
  [x] API 62 files green
  [x] Web 22 files / 184 tests green
  [x] Full Playwright suite, both engines — 152 passed / 0 failed / 6 skipped
```

---

## 9. THE WINDOW E2E WAS WRITTEN, AND DELETED

STEP 7 asks for an E2E that fires an event inside the mount window. It was built, it
passed — **and it passed just as happily with `enabled: subscribed` removed.** A test
that cannot tell the fixed build from the broken one is worse than no test, because it
reads as proof.

The reason is architectural and worth writing down:

> The **server** joins a socket's rooms in its `connection` handler, so real membership
> exists the moment the transport connects. `room:join` **confirms** that to the client;
> it does not create it. Delaying the ack delays the client's *knowledge*, not the
> server's *delivery* — so an end-to-end observer cannot distinguish gated from ungated
> fetching.

The gate is still correct and still necessary: without it the client's initial fetch
races its own connection, and an event landing in that gap is absent from the snapshot
*and* delivered to nobody. That property is proven where it is actually observable —
`use-realtime-query.test.tsx`, which fails on the in-flight case when the buffering is
removed and on the reconnect case when the "ever subscribed" flag is wrong. Both were
verified by breaking them.

A banner-level E2E was also tried and removed: it flaked across engines, and
`connection-banner.test.tsx` already covers the same behaviour deterministically.

**Net:** the mechanism is proven by unit tests that break correctly, and the real defect
is proven by `notifications.spec.ts:116` going from 3-of-10 failing to 10-of-10 passing.
No E2E in this patch claims more than it can show.

---

## 10. SUITE RESULT

| Gate | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| API unit | **62 files green** |
| Web unit | **22 files / 184 tests green** |
| Playwright, chromium + webkit | **152 passed · 0 failed · 6 skipped (14.1m)** |
| `notifications.spec.ts:116` × 10 | **10 / 10** |

The full suite is green on both engines — the first time in this effort. Sprint 10's
held push goes out with the defect **fixed**, not documented.
