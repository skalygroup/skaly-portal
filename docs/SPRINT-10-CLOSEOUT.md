# SPRINT 10 CLOSE-OUT — CHAT + NOTIFICATIONS + REAL-TIME

**Branch:** `sprint-10-chat-notifications` · **Companion:** `SPRINT-10-DETAILED.md`

Sprint 10 is the sprint where everything became concurrent. What follows is what was
built, what was found, and what was deliberately left.

---

## 1. RECONCILIATIONS THE GUIDE GOT WRONG

The guide is written ahead of the code, so some of it did not survive contact. Each of
these was verified against the repo before anything was built.

| Guide says | As-built | Consequence |
|---|---|---|
| ADRs are 017–020 | **020–023** | 017/018/019 were taken by Sprint 9 (client onboarding, bot tool loop, id contract). Renumbering shipped ADRs referenced in code comments would be churn; the new ones carry a mapping note. |
| `docs/adr/` | `docs/decisions/` | — |
| `apps/web/app/(portal)/` | `apps/web/src/app/(portal)/` | Reconciliation #11 was stale in the same way Sprint 9's was. |
| `apps/api/database/migrations` | `database/migrations/` (repo root) | — |
| `tests/e2e/` | `apps/web/tests/` | — |
| Presence uses `KEYS presence:*` | `SCAN` (`sockets/presence.ts:44`) | The ruling stands — a wildcard on a request path is wrong either way — but ADR-023 states it accurately rather than repeating the guide. |
| PATCH/POST for notifications | **PUT** | 07-API-CONTRACT and 06-IMPL-PLAN both say PUT; the guide is the outlier and the numbered specs win. |
| `?cursor=` on notifications | No cursor | The contract documents the last-50 window as a decision with a rationale (audit L-07). |
| Census: 12 producers exist | **5 existed** | Six types owned by shipped sprints had never been wired. See §3. |
| ADR-005 exists | **Never written** | Cited by the Sprint 8 and 10 guides; `docs/decisions/` has no ADR-004 or ADR-005. The three namespaces do exist in code, so the ruling is satisfied in practice. |

---

## 2. THE FOUR ADRs

| ADR | Ruling |
|---|---|
| **ADR-020** | Notification types = 18, from the schema enum. PRD §4.9 + IMPL-PLAN §13 patched 14 → 18. |
| **ADR-021** | Bot archive: user turn carries `sender_id`, reply is anonymous + `parent_id`, ownership by `COALESCE`. `bot_sessions` is the session envelope, never the ownership source. |
| **ADR-022** | Patch vs invalidate. The line is **correctness**, not performance: patch only when the payload is the complete new state of one addressable entry. |
| **ADR-023** | Presence = one Redis hash, timestamp values, 60s freshness filter, swept on read. |

---

## 3. THE PRODUCER CENSUS — 11 / 7, NOT 12 / 6

STEP 1.3 found **five** types with emitters, not twelve. Six were owned by sprints that
had already shipped and had simply never been wired — `HolidayService` was broadcasting
`attendance:holiday_added` over the socket while writing no notification row, and
`ClientService` did not import `NotificationService` at all. **A socket event and a
notification are different mechanisms; having one is not having the other.**

Five were closed this sprint. The sixth, `account_reactivated`, was **not**, and that is
deliberate: there is no staff reactivate path anywhere — `StaffService` is read-only and
there is no *deactivate* either. Its producer is not a missing call, it is a missing
feature, and that feature is Sprint 11's Settings → Staff. Inventing an emitter to
satisfy a coverage count is exactly what ADR-020 forbids.

**Final: 11 with producers, 7 deferred, 18 total.**

`signup_rejected` routes to the **non-actor admins**, not the applicant: a rejected
applicant has no staff row and `notifications.staff_id` is a NOT NULL FK, so they are
unreachable in-app by construction. It carries the public message only.

---

## 4. WHAT THE TESTS FOUND

Every item here was found by a test, not by review. They are listed because the *class*
of bug matters more than the individual fix.

### Silent data loss

- **The keyset cursor was lossy.** It carried `created_at` through `toISOString()` —
  millisecond precision against a **microsecond** column — so the truncated value sorted
  below the row it came from and every message inside that window was skipped. Passed
  with messages a second apart; dropped half a page the moment two shared a microsecond.
- **The retention job would have deleted whole bot histories.** ADR-021's addendum told
  it to scope by `bot_sessions.last_activity_at`, which is **not expressible** —
  `messages` carries no session reference. The implementation joined on `staff_id`
  instead, so one expired session would delete that person's entire bot archive, live
  conversations included. The ADR is corrected; the rule is now one parent-aware
  statement for both channels.

### Consumers wired to producers that did not exist

Twice, in different guises, and neither detectable by any behavioural test:

- Six notification types with no emitter (§3).
- **Four of nine ADR-022 matrix events were never emitted.** The tasks and shoot-planner
  grids were subscribed to `task:created`, `task:updated`, `task:assigned` and
  `shoot:slot_updated` — and nothing sent them. The frontend tests assert
  *classification*; the backend tests never knew the events were expected.

Both are now guarded by **source-reading census tests** (`NotificationCensus`,
`realtime-census`), because in both cases the code was internally consistent and merely
disconnected.

### Cross-channel leak

`getThread` filtered only on `parent_id` — which is **shared with the bot archive**,
since ADR-021 links a bot reply to its question through it. A chat caller could have
pulled someone's private bot conversation from nothing but a message id.

### Unenforced invariants

- **Persist-then-emit passed for nine sprints by luck.** An incidental `await` after the
  emit gave the async assertion time to observe an already-persisted session. Removing it
  — correctly — failed the test with no product regression. It is now a **seam** every
  emitter passes through, and the rule sharpened to *emit after COMMIT, not after write*:
  `NotificationService` writes through the **caller's** `trx`, so it was emitting rows
  that were written but not durable.
- **A mention regex cannot know where a name ends.** `@Rahul can you look` and
  `@Rahul Menon please look` are identical in shape. The parser now emits candidate
  prefixes and the staff table decides.

### Found only by E2E

- The reconnecting banner flashed on **every page load**, disabling the composer.
- The notification panel **crashed on open** behind a stale `@skaly/shared` build.
- Chat had **no delete affordance at all** — `remove()` existed on the service and route
  with nothing able to call it.

---

## 5. ⚠️ OPEN PRODUCT BUG — HOLIDAY DATES ARE PERMANENTLY CONSUMED

**Not fixed. Found by the E2E suite, and out of Sprint 10's scope.**

`holidays` has `UNIQUE (period, date)` with **no partial index on `removed_at`**.
Removing a holiday soft-deletes it (correctly — the app role has no DELETE grant), so
the date stays reserved forever. An admin who removes a holiday by mistake can **never
re-add one on that day**, and the API answers a raw **500**, not a friendly error.

It burned **nine dates in a handful of test runs**, which is what makes it visible: it
also makes any suite that creates holidays non-repeatable.

**Fix:** replace the constraint with a partial unique index —
`UNIQUE (period, date) WHERE removed_at IS NULL` — and map the duplicate to a 409 with a
usable message. That is a migration in Sprint 3's area, hence recorded rather than
taken.

---

## 6. CARRIED / DEFERRED

| Item | Owner |
|---|---|
| `account_reactivated` producer | Sprint 11 (Settings → Staff) |
| Holiday unique-index bug (§5) | Sprint 11 or a patch release |
| 12-month retention **cron** (the query and its tests exist) | Sprint 12 |
| `report_ready` | Sprint 11 |
| `new_comment`, `month_ready`, 3× `rollover_*` | Sprints 12–13 |
| Applicant-facing signup outcome (`SIGNUP_PENDING` / `SIGNUP_REJECTED` error codes) | **Pre-launch gate**, beside the recovery-code redeem path |
| Recovery-code redeem path | **Pre-launch gate** (carried since Sprint 8) |
| `apps/api/scripts/` now typechecked — no errors today, but it was unchecked before | — |

---

## 7. CLOSE-OUT CHECKLIST

```
PRE-FLIGHT
  [x] Sprint 9 verified green (typecheck, lint, API 49/49)
  [x] E2E clearance re-verified — 3 failures found, all ONE root cause:
      login() needs up to 33.5s and the global budget was 30s. Not flaky;
      over budget by construction. Raised to 60s.
  [x] Producer census done — 5 built, 6 gaps, 7 deferred (11/7 final)
  [x] Bot-persistence state determined: B-variant, no orphans, no backfill
  [x] Socket.io Redis adapter verified present (sockets/index.ts:113)
  [x] ADR-020/021/022/023 committed
  [x] PRD §4.9 + IMPL-PLAN §13 patched 14 → 18
  [x] THIRD-PARTY §5.2 presence key row patched to the hash

BOT ARCHIVE (ADR-021)
  [x] User turn persists with sender_id, BEFORE the model call
  [x] Bot reply: sender_id NULL + parent_id
  [x] Ownership via COALESCE — cross-user assertion TESTED
  [x] bot_sessions envelope; last_activity_at bumped; no duplicate rows
  [x] GET /v1/bot/session/current falls back to the DB (TESTED)
  [x] No migration, no backfill
  [x] Dead lib/bot/stream-handler.ts deleted (archived bot text as sender_type 'user')

PRESENCE (ADR-023)
  [x] Single hash; value is a TIMESTAMP (asserted directly)
  [x] 30s heartbeat, 60s filter, swept on read — filter AND sweep asserted
  [x] presence:changed on transition only (socket-level test; proven by breaking)
  [x] Roster scoped via getOnlineAmong — no overload returns everyone
  [x] No KEYS/SCAN on any request path (grep clean)
  [x] Deploy note added (INFRA §5.1)

NOTIFICATIONS (ADR-020)
  [x] Registry ↔ enum set equality, BOTH directions, enum read from Postgres
  [x] 11 producer types exercised; 7 deferred asserted by name
  [x] Producers asserted to EXIST in src (the guard nothing else could provide)
  [x] No enum value for ordinary chat messages
  [x] Dedup on (recipient, type, record) within 24h (TESTED both ways)
  [x] notify:new renders without a refetch (asserted by counting query-fn calls)
  [x] Never notify the actor
  [x] Bell badge 99+, Today/Earlier, deep links, cross-tab mark-read

CHAT
  [x] send → message + mentions + N notifications for N distinct non-author
  [x] Self-mention: row created, NO notification
  [x] Keyset pagination — no duplicates, no gaps, incl. same-timestamp
  [x] Soft delete via lib/queries.ts; tombstone; replies survive
  [x] /v1/chat/search separate from /v1/search
  [x] chat.access via PermissionService — BOTH directions, service AND route
  [x] Content stored RAW; no dangerouslySetInnerHTML (grep clean)
  [x] Typing throttled client AND server; never persisted

REAL-TIME (ADR-022)
  [x] Every // TODO(Sprint 10) marker deleted
  [x] Event→action table matches the ADR (TESTED per row)
  [x] ⭐ Patch path issues NO refetch (E2E, request interception)
  [x] ⭐ Invalidate path DOES refetch (E2E, H-01 cascade)
  [x] Patch payloads carry version (proven by breaking)
  [x] Sender excluded client-side; server-side where a socket originates it
  [x] No new namespace

FRONTEND
  [x] initialPageParam present (asserted — a runtime error that survives tsc)
  [x] ⚠️ Scroll anchoring — compensated, proven by breaking, + E2E bounding box
  [x] Auto-scroll only near bottom; pill otherwise
  [x] Grouping, mention highlight, presence dots, avatars, tombstones, thread counts
  [x] Reconnection banner — amber, non-blocking, backoff NOT hand-rolled
  [x] Refetch-on-reconnect (once, no key); composer disabled offline

TESTS + NFRs
  [x] API 61 files green; web 20 files / 198 tests green
  [x] typecheck + lint clean
  [x] Every new test fails without its fix (prove-by-breaking used throughout)
  [ ] NFR §1.3 measured — see §8
  [ ] Full Playwright suite, chromium + webkit — see §8
```

---

## 8. NFR MEASUREMENT (§1.3)

Filled in from the run recorded at close-out. See the commit for raw numbers.

| NFR | Target | Observed |
|---|---|---|
| WS delivery | < 500ms | chat delivery asserted < 2s in CI; the spec logs the measured value |
| Presence propagation | < 2s | transition-only broadcast; asserted at the socket layer |
| Reconnect | < 30s | banner clears inside 30s (socket.io backoff cap) |
| Chat FCP, 100+ messages | < 1.5s | not measured — see below |

**Chat FCP is not measured.** The existing NFR perf specs (`content-calendar.spec.ts`
§NFR 1.1) are chromium-only and were written for a virtualised grid; chat is not
virtualised and 100+ messages were not seeded. Recorded as unmeasured rather than
asserted from a run that did not happen.

---

## 9. TOOLCHAIN FIX WORTH KEEPING

`apps/api/tsconfig.json` had `include: ["src/**/*.ts"]` **on the config that also
emitted**, so `pnpm typecheck` never read a test file — and eleven of this sprint's
thirteen steps lean on that gate. It reported success while 33 call sites were broken.

Split into `tsconfig.json` (src + test + scripts, `noEmit`) and `tsconfig.build.json`
(`rootDir: "src"`, emits). **Not** a widened `include` on the emitting config: TypeScript
infers the common source root from the file set, so `dist/server.js` would have silently
become `dist/src/server.js` and Railway's `node dist/server.js` would fail on deploy
rather than in CI.

Proven both directions — a deliberate type error in a test now fails the gate, and a
clean build still emits `dist/server.js` with no `dist/src`.
