# SPRINT 10 — CHAT + NOTIFICATIONS + REAL-TIME: DETAILED PROMPT-BY-PROMPT GUIDE

## Scaly Business Portal • Sprint 10 of 13

**Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1..9-DETAILED.md` + `SPRINT-8_1-PATCH-DETAILED.md`**
**Same Goal / Prompt / Verify framework as Sprints 0–9**
**Tooling interfaces verified as of July 2026** — socket.io v4 + socket.io-client v4 (`auth` handshake, namespaces, `socket.broadcast.to()`), `@socket.io/redis-adapter` (`createAdapter(pub, sub)`), TanStack Query v5 (**`useInfiniteQuery` now requires `initialPageParam`**, `setQueryData` for cache patching, object-form `invalidateQueries`), Next.js 15 App Router, Zustand 5, Framer Motion 11, DOMPurify, date-fns, ioredis (`HSET`/`HGETALL`/`HDEL`), Playwright latest (multi-context for concurrency tests), Lucide React.

> **Risk note:** Sprint 10 is the sprint where **everything becomes concurrent**. Every prior sprint's grid was a single-user surface with an optimistic update; this one puts 50 people on the same rows at the same time. The two places that will hurt are reverse infinite scroll (STEP 11) and cache patching under concurrent edits (STEP 9). Neither is hard; both are unforgiving of shortcuts.


> **⚠️ ADR NUMBERING CORRECTED.** This guide originally numbered the four ADRs it
> creates **017/018/019/020**. In `docs/decisions/` they are **020** (notification-type-count),
> **021** (bot-archive-attribution), **022** (realtime-cache-strategy) and **023** (presence-hash)
> — every reference has been shifted to match, including the filenames. ADR-017 is
> client-onboarding-atomicity, an unrelated ruling, so the original numbers sent a reader
> to the wrong document. Same drift as Sprints 11 and 13; same resolution:
> `docs/decisions/` wins over a guide's shorthand.
>
> Untouched, because they are not this drift: the five `ADR-005` mentions (that ruling
> lives in `docs/decisions/DECISIONS.md`, not as a numbered ADR file), and one
> retention/`parent_id` reference in the close-out that may belong to ADR-030 rather
> than 021 — flagged rather than guessed.

---

## USING THE `/ponytail` PLUGIN IN THIS SPRINT

Placement as established in Sprint 9: **between the build prompt and the test prompt** — on the implementation, before anything is written against its shape. He is absent from manual steps, ADR authoring, branch creation, and census greps.

**Where he earns his keep this sprint:** the event→cache-action matrix (STEP 9 — this will want to be a switch and should be a table), the chat message renderer (STEP 11 — grouping, threading, and mention highlighting will collapse into each other), the notification type registry (STEP 4 — eighteen types, one shape), and the presence heartbeat (STEP 3 — three functions that want to be one).

---

## WHAT YOU'RE BUILDING IN SPRINT 10

Sprint 8 built the socket client. Sprints 3–7 left `// TODO(Sprint 10)` markers where their grids should have subscribed. This sprint attaches all of it, and adds the two human-facing real-time surfaces: chat and notifications. By the end of this week:

- **The four pre-Sprint-10 decisions are recorded** as **ADR-020** (notification count), **ADR-021** (bot archive attribution), **ADR-022** (grid cache strategy), **ADR-023** (presence).
- **The bot archive is fixed *before* chat touches `messages`** — the user's bot turn persists with `sender_id`, the reply links via `parent_id`, ownership resolves by join, and `bot_sessions` finally holds the session envelope it was created for. This is deliberately the first build step: fixing the bot's write shape while simultaneously adding chat's write path to the same table is how you get two half-right writers.
- **Presence uses a single Redis hash** with heartbeat timestamps and a freshness filter — `KEYS presence:*` is retired.
- **All 18 notification types are accounted for**: every one with an MVP producer is tested; the six whose producers land in Sprints 11–13 are enumerated by name with their owning sprint. PRD §4.9 and Impl-Plan §13's stale "14" are patched in the same commit.
- **The notification bell works** — unread count, `notify:new` live delivery, mark-read, deep links.
- **Common chat works** — reverse infinite scroll, threads, @mentions with notification fan-out, typing indicators, presence dots, soft delete, and chat search.
- **`chat.access` is exercised for the first time** — the freelancer 🔧 default-off key from Auth-Matrix §3. Sprint 9 wrote `changed_by_source='bot'` for the first time; this sprint is that key's turn.
- **Every grid subscribes**, following ADR-022's matrix: patch the cache where the payload fully specifies one addressable entry, invalidate where it doesn't. Every `// TODO(Sprint 10)` marker from Sprints 3–7 is gone.
- **Reconnection UX** matches Error-Handling §5.4 — amber banner, backoff, refetch-on-reconnect.
- **Tests prove it** under genuine concurrency: two Playwright browser contexts, one editing, one observing.

**Estimated time:** 5 working days (Week 11 per `06-IMPLEMENTATION-PLAN.md` §13; owners TL + D1 + D2). Day 1 pre-flight + ADR-021 + presence; day 2 notifications end-to-end; day 3 chat backend + tests; day 4 grid subscriptions (ADR-022) + chat frontend; day 5 reconnection UX + E2E + close-out.

**Prerequisites from Sprint 9** (all green — stop and fix if any is not):

- Sprint 9 close-out fully checked; CI green on `main`; the confirmation machine, 11 mutation tools, search, and activity feed all live.
- **The 4 carried E2E failures are cleared** (Sprint 9 STEP 1.2). STEP 1.2 below re-verifies — if any were reclassified or descoped rather than fixed, that is this sprint's first problem, not next sprint's.
- `apps/web/lib/socket.ts` singleton with the C-05 refresh handshake, proven under bot streaming.
- `NotificationService` exists (Sprint 2) and is called by Sprints 3–7's producers.
- `EventBus` + `apps/api/src/events/listeners.ts` wired for both cross-module triggers.
- `PermissionService` is the single permission resolver (8.1), with the `no-restricted-imports` guard active.
- All grid modules built with their `// TODO(Sprint 10)` subscription markers in place.
- `pnpm typecheck`, `pnpm lint`, and the full suite green on `main`.

---

## THE PRE-SPRINT-10 DECISIONS — WHERE THEY LAND

Ruled at the pre-Sprint-10 gate; **inputs** to this sprint. STEP 1 records the four ADRs; the steps below execute them.

| Decision | Ruling | Executed in |
|---|---|---|
| **Notification types = 18** | Schema enum wins over PRD/Impl-Plan's stale 14. The discrepancy is almost certainly `month_ready` + the three `rollover_*` types (18 − 4 = 14) — the PRD counted user-facing events and skipped the system ones. → **ADR-020** | STEP 1 (census + record) + STEP 4 |
| **↳ Coverage test asserts MVP producers, enumerates the deferred** | A bare "18 types tested" would force you to invent emitters for types whose producers land in Sprints 11–13. Test what exists; name what doesn't and when it arrives. | STEP 1.3 + STEP 8 |
| **Bot archive: `parent_id` + `bot_sessions`, both** | Ownership by `COALESCE(sender_id, parent.sender_id)`. `parent_id` owns the message graph; `bot_sessions` owns the session lifecycle. Orthogonal jobs, so no dual-write drift. → **ADR-021** | STEP 1 (record) + **STEP 2** |
| **↳ Lands before common-chat writes** | Sprint 10 makes chat a second writer to `messages`. Fix the bot's shape first. | **STEP 2 precedes STEP 6** |
| **↳ The user's bot turn must persist to `messages` first** | `parent_id` gives ownership *by join* — that only works if the row it points at carries `sender_id`. STEP 1.4 determines whether this already happens. | STEP 1.4 + STEP 2 |
| **Grid real-time: patch vs invalidate** | Patch when the payload fully specifies one addressable cache entry; invalidate when the change touches a trigger, cascade, aggregate, or row ordering. Correctness-first — the fan-out reduction falls out for free on the hot path. → **ADR-022** | STEP 1 (record) + STEP 9 |
| **↳ Patch payloads carry the new `version`** | A patch that doesn't update the cached version guarantees the next optimistic write 409s spuriously. | STEP 9 |
| **↳ Senders excluded from their own broadcast** | The originator already has the optimistic update; re-patching from the echo double-applies or fights the in-flight mutation. | STEP 9 |
| **Presence: single hash + heartbeat + freshness filter** | `HSET presence {staffId} {lastSeenEpoch}`, `HGETALL` filtered to 60s, swept on read. The freshness filter replaces the per-key TTL that per-staffId keys gave for free. → **ADR-023** | STEP 1 (record) + STEP 3 |

---

## READ FIRST (Open in Antigravity Split View)

| Doc | Sections | Why |
|---|---|---|
| `docs/02-TRD.md` | **§8 (socket namespaces, rooms, presence)**, §10 (notification system), §9.4 (bot archive claim — the one ADR-021 corrects) | The real-time architecture |
| `docs/04-APPFLOW.md` | **Chat flow (send, thread, mention, typing)**, notification flow (bell → panel → deep link), presence | Every interaction |
| `docs/07-API-CONTRACT.md` | `/v1/chat/*` (incl. `GET /v1/chat/search`), `/v1/notifications/*`, §1.1 envelopes, §2 rate limits | Exact shapes |
| `docs/08-AUTH-MATRIX.md` | **§3 (`/chat` — freelancer 🔧 blocked by default)**, §6.2 (`chat.access` key), §6.3 (Redis perms cache) | The key this sprint first exercises |
| `docs/03-UIUX.md` | Chat page, notification bell + panel, presence dots, typing indicator, §22 (animation), §4.3 (chips) | Every visual rule |
| `docs/05-BACKEND-SCHEMA.md` | `messages` (**`sender_id` NULL comment**, `parent_id`, `sender_type`, `content_type`, `search_vector`), `message_mentions`, `notifications` (**the 18-value enum**), `bot_sessions`, §11 (grants) | Column truth |
| `docs/09-ERROR-HANDLING.md` | **§5.4 (network drop + WebSocket reconnect UX)**, §2 | The reconnection contract |
| `docs/13-NFRS.md` | **§1.3 (WS delivery < 500ms, presence < 2s, reconnect < 30s)**, §4.3 (DOMPurify), §5.2 (12-month message retention), §2.2 (~15k messages) | The numbers you must hit |
| `docs/11-THIRD-PARTY-INTEGRATIONS.md` | §5.2 (**Redis key registry — `presence:{staffId}` is what ADR-023 replaces**) | Update this doc |
| `docs/10-INFRA-DEPLOYMENT.md` | §10 (Socket.io Redis adapter — the scaling prerequisite) | Verify it's actually wired |
| `docs/06-IMPLEMENTATION-PLAN.md` | §13 | Sprint 10 checklist (**patch its "14"**) |
| `docs/12-TESTING-STRATEGY.md` | Real-time + concurrency sections | The tests you must reproduce |
| `docs/adr/` | **ADR-005, 006, 010, 011, 013**, + **017/018/019/020** (created STEP 1) | The rulings this sprint must not violate |

---

## CONSISTENCY RECONCILIATIONS — LOCK THESE BEFORE YOU PROMPT

1. **Notification count is 18, not 14** (schema enum + TRD §10.1). PRD FR-NOTIF-02 and Impl-Plan §13 are stale and get patched this sprint. Do not write a test asserting 14.
2. **There is no generic "new chat message" notification type.** The 18 include `mention` and `new_comment` — not a per-message notify. Chat messages deliver via socket only; **only @mentions create a notification row.** If you find yourself adding an enum value for chat messages, stop — that is scope drift, and the enum is a CHECK constraint that would need a migration.
3. **ADR-010's amendment already pulled the socket *client* into Sprint 8.** Sprint 10 attaches *consumers*; it does not build the client. Do not create a second socket singleton.
4. **ADR-005: no fourth namespace.** Bot streaming shares `/ws/notify`. Chat uses the existing TRD §8 namespaces — verify which before wiring, and do not add one for chat.
5. **`messages.sender_id` is NULL for bot rows by design** (schema comment) — ADR-021 does **not** change that. It adds the `parent_id` link and the `bot_sessions` envelope around it. Do not "fix" the schema comment by backfilling `sender_id` on bot rows; ownership resolves by join.
6. **`softDelete` lives in `lib/queries.ts`, not on `BaseService`** (as-built correction from Sprint 9). Message deletion uses that helper; `softDeletable` remains the separate SELECT filter.
7. **Freelancer chat is a *permission* check, not a role check.** Auth-Matrix §3 marks `/chat` 🔧 for freelancers — default-denied, admin-grantable via the `chat.access` key (§6.2). Route guards must call `PermissionService`, not `requireRole`. This is the key's first real use.
8. **TanStack Query v5 `useInfiniteQuery` requires `initialPageParam`.** Omitting it is a runtime error, not a type error, and the message is unhelpful. Pair it with `getNextPageParam`.
9. **Chat scrolls *up* for history.** Every prior grid paginated downward. Prepending older messages without scroll-anchoring makes the viewport jump — this is the single most common chat bug and it is not caught by any unit test.
10. **DOMPurify is belt-and-braces, not the primary defence.** NFR §4.3 mandates it; React already escapes text children. The real exposure is `dangerouslySetInnerHTML`. Render message content as **text** with a linkifier; reach for DOMPurify only where HTML is genuinely rendered, and never introduce `dangerouslySetInnerHTML` to justify it.
11. **Frontend path `apps/web/app/(portal)/`** (no `src/`), matching Sprints 3–9.
12. **Presence key registry changes.** Third-Party §5.2 documents `presence:{staffId}` (string, 60s TTL). ADR-023 replaces it with one `presence` hash. **Patch that doc in the same commit** — a Redis key registry that lies is worse than none.

---

## AUDIT + ADR ITEMS THIS SPRINT MUST HANDLE

| ID | What | Where |
|---|---|---|
| **ADR-020 (new)** | Notification count = 18; producer census; PRD §4.9 + Impl-Plan §13 patched; coverage test scoped to MVP producers with deferred types named. | STEP 1 + 4 + 8 |
| **ADR-021 (new)** | Bot archive: user turn persisted with `sender_id`, reply linked by `parent_id`, ownership via `COALESCE`; `bot_sessions` as session envelope. **Before chat writes.** | STEP 1 + **STEP 2** |
| **ADR-022 (new)** | Patch-vs-invalidate matrix; payloads carry `version`; senders excluded from own broadcast. | STEP 1 + 9 |
| **ADR-023 (new)** | Presence hash + heartbeat + freshness filter + sweep; `KEYS` retired; Third-Party §5.2 patched. | STEP 1 + 3 |
| **ADR-006 (inherited)** | Mention fan-out is per-mentioned-user, never combined — and **never to the author** (same non-actor rule as task assignment). | STEP 6 |
| **ADR-011 (inherited)** | Freelancer isolation — chat access is permission-gated; presence must not leak staff a freelancer can't otherwise see. | STEP 3 + 7 |
| **NFR §1.3** | WS delivery < 500ms, presence propagation < 2s, reconnect < 30s. **Measured, not asserted.** | STEP 13 |
| **NFR §4.3** | DOMPurify / no `dangerouslySetInnerHTML` on message content. | STEP 11 |

If you skip the test for any of these, Sprint 10 is not done. They reappear in CI when you push.

---

## STEP-BY-STEP STRUCTURE

| # | Type | What |
|---|---|---|
| 1 | Manual | Pre-flight — Sprint 9 green, **re-verify the E2E clearance**, **notification producer census**, **determine bot-persistence state**, verify the Redis adapter, record ADR-020/018/019/020, branch |
| 2 | Prompt | **ADR-021 — bot archive attribution (before chat touches `messages`)** |
| 3 | Prompt | ADR-023 — presence hash + heartbeat + sweep |
| 4 | Prompt | `NotificationService` completion — 18-type registry, `notify:new`, dedup |
| 5 | Prompt | Notification routes + bell/panel frontend |
| 6 | Prompt | `ChatService` — send, paginate, threads, mentions, soft delete, search |
| 7 | Prompt | Chat routes + `chat.access` gate + socket namespace wiring |
| 8 | Prompt | Backend tests — chat, notifications, mentions, presence, coverage census |
| 9 | Prompt | **ADR-022 — grid subscriptions; retire every `// TODO(Sprint 10)`** |
| 10 | Prompt | Frontend chat UI — reverse infinite scroll, threads, typing, presence |
| 11 | Prompt | Frontend — reconnection UX (Error-Handling §5.4) + DOMPurify pass |
| 12 | Manual + Prompt | Playwright — **two-context concurrency** specs |
| 13 | Manual | End-to-end smoke + NFR measurement + commit + close-out |

---

## SPRINT 10 — STEP 1: Pre-flight (manual)

### 1.1 — Confirm Sprint 9

```bash
git checkout main && git pull
docker compose up -d && docker compose ps
pnpm install
pnpm --filter @skaly/api db:status                 # 0 pending
pnpm typecheck && pnpm lint && pnpm --filter @skaly/api test
```

### 1.1a — ⚠️ Make `pnpm typecheck` an honest gate (do this FIRST)

`apps/api/tsconfig.json` had `include: ["src/**/*.ts"]` on the config that **also emitted**, so
`pnpm typecheck` never read a test file. STEP 2 changed a required field and broke 33 call sites
under `test/` while the gate stayed green — they surfaced only under vitest, at runtime. Eleven
of this sprint's thirteen steps lean on that gate. **A gate that passes while broken is worse
than no gate: it converts "I checked" into "I didn't check, confidently."**

Fix with a **config split, not a broadened `include`** — and note the trap in doing it the
obvious way. If you widen `include` on the config that emits, TypeScript widens the inferred
common source root and `dist/server.js` silently becomes `dist/src/server.js`, breaking Railway's
`start: node dist/server.js`. You would find that on deploy, not in CI.

- `apps/api/tsconfig.json` → `include: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"]`, `noEmit: true`
- `apps/api/tsconfig.build.json` → `rootDir: "src"`, `include: ["src/**/*.ts"]`, emits
- `package.json` → `"build": "tsc -p tsconfig.build.json"`, `"typecheck": "tsc -p tsconfig.json"`

```bash
# check the other workspaces for the same narrow include
grep -n '"include"' apps/web/tsconfig.json packages/*/tsconfig.json
# ^ apps/web is already **/*.ts + noEmit; packages/shared has no tests. Only api was wrong.

# prove the fix by BREAKING it — the "every test fails without its fix" discipline,
# applied to the toolchain. It is the only way to know the program actually widened.
echo 'const x: number = "nope";' >> apps/api/test/services/BotArchive.test.ts
pnpm typecheck                      # MUST fail
sed -i '/const x: number/d' apps/api/test/services/BotArchive.test.ts
pnpm typecheck                      # green again

# and prove the deploy path did not move
rm -rf apps/api/dist && pnpm --filter @skaly/api build
ls apps/api/dist/server.js          # must exist; dist/src/ must NOT
```

**Expect a fresh crop of errors on the first honest run** — 15 of them, in 10 test files. That is
pre-existing debt becoming visible, not new breakage. (Sprint 10 found: 11 missing non-null
assertions, `jose` v6 dropping `KeyLike` in favour of `CryptoKey`, one bogus `as unknown as Date`,
one untyped `decorate` stub.)

### 1.2 — ⚠️ Re-verify the E2E clearance

Sprint 9 STEP 1.2 was supposed to fix the four carried failures (3 shoot-planner, 1 signup-requests).

```bash
pnpm exec playwright test --reporter=list
grep -rn "test.skip\|test.fixme\|\.only" tests/e2e/    # expect: nothing
```

**Both must be clean.** If any of the four was skipped, `fixme`'d, or descoped rather than fixed, that is Sprint 10's first task — this sprint adds a large E2E surface (chat, notifications, presence, two-context concurrency), and inheriting red specs under that load is the same trap one sprint deeper. Fix them here before proceeding.

### 1.3 — ⚠️ Notification producer census (ADR-020)

Do not lock a number before you know which types have emitters. Reconcile three lists — the enum, the producers in code, and the sprint that owns each.

```bash
# the enum's 18 values
grep -rn "notifications_type_check" apps/api/database/migrations

# every emitter in code
grep -rn "NotificationService\.\|createNotification" apps/api/src --include=*.ts | grep -v test
```

Expected reconciliation — confirm each row against what you actually find:

| Type | Producer | Owning sprint | In the MVP coverage test? |
|---|---|---|---|
| `task_assigned` | `TaskService.create/assign` | 4 | ✅ |
| `task_overdue` | overdue sweep | 4 | ✅ |
| `dependency_resolved` | `TaskService.update` | 4 | ✅ |
| `shoot_confirmed` | `ShootPlannerService.update` | 5 | ✅ |
| `holiday_added` | `HolidayService.create` | 3 | ✅ |
| `holiday_removed` | `HolidayService.remove` | 3 | ✅ |
| `signup_request` | signup flow | 1–2 | ✅ |
| `signup_approved` | approve flow | 2 | ✅ |
| `signup_rejected` | reject flow | 2 | ✅ |
| `account_reactivated` | staff reactivate | 2 | ✅ |
| `client_updated` | `ClientService` name update | 6 | ✅ |
| **`mention`** | **chat mentions** | **10 — this sprint** | ✅ |
| `report_ready` | report generation | 11 | ⏸ deferred |
| `new_comment` | comment system | 12 | ⏸ deferred |
| `month_ready` | rollover | 12–13 | ⏸ deferred |
| `rollover_success` | rollover | 12–13 | ⏸ deferred |
| `rollover_failed` | rollover | 12–13 | ⏸ deferred |
| `rollover_view_refresh_failed` | rollover | 12–13 | ⏸ deferred |

**12 testable this sprint, 6 deferred with named owners. 18 total.**

Note the arithmetic: the six deferred include `month_ready` + the three `rollover_*` — exactly four system-generated types. **18 − 4 = 14.** That is almost certainly where the PRD's number came from: it counted user-facing events and skipped the system ones. Record that in the ADR; an explained discrepancy stays fixed, a declared winner reseeds.

**If your grep finds an enum value with no producer in any sprint**, stop and flag it — do not invent an emitter to satisfy a coverage test.

### 1.4 — ⚠️ Determine the bot-persistence state (scopes STEP 2)

ADR-021's `parent_id` link only works if the row it points at carries `sender_id`. Find out whether bot turns reach `messages` at all, or live only in the Redis session:

```bash
grep -rn "channel.*'bot'\|channel: 'bot'" apps/api/src --include=*.ts | grep -v test
grep -rn "insertInto('messages')" apps/api/src --include=*.ts
grep -rn "bot_sessions" apps/api/src --include=*.ts        # expect: nothing (the orphan)
```

Then check live data after using the bot once:

```sql
SELECT channel, sender_type, sender_id IS NULL AS anon, parent_id IS NULL AS unlinked, count(*)
FROM messages GROUP BY 1,2,3,4;
```

Three possible findings, each changing STEP 2's size:

- **(A) Nothing in `messages`** — the archive is Redis-only and TRD §9.4's claim is aspirational. STEP 2 builds the whole persistence path. *Largest.*
- **(B) Both turns persisted, no `parent_id`** — STEP 2 adds the link + backfill. *Smallest.*
- **(C) Bot replies only, `sender_id` NULL, no user turns** — the worst case: rows exist that can never be attributed. STEP 2 adds the user turn, the link, and decides what to do with the orphans.

Write down which you found. STEP 2's prompt needs it.

### 1.5 — Verify the Socket.io Redis adapter

Infra §10 says it was configured in Sprint 0 as the scaling prerequisite.

```bash
grep -rn "createAdapter\|@socket.io/redis-adapter" apps/api/src
```

If absent, note it — MVP is single-instance so nothing breaks today, but Infra §10 calls it "the first change before scaling beyond one instance," and a spec claiming it exists when it doesn't is exactly the drift this process catches. Do not build it now; record it.

### 1.6 — Record ADR-020, 018, 019, 020 (Prompt)

> **WHERE WE ARE**
>
> Sprint 10, STEP 1.6. Recording the four pre-Sprint-10 rulings before any code references them. Read `docs/adr/ADR-016` for the house format, `docs/05-BACKEND-SCHEMA.md` (`messages`, `notifications`, `bot_sessions`), `docs/11-THIRD-PARTY-INTEGRATIONS.md` §5.2, and `docs/02-TRD.md` §8 + §9.4.
>
> My STEP 1.3 census found: **[paste the producer table]**. My STEP 1.4 finding is: **[A / B / C — paste the query output]**.
>
> **WHAT TO BUILD** — four files in `docs/adr/`:
>
> **`ADR-020-notification-type-count.md`**
> ```
> # ADR-020 — Notification types: 18, sourced from the schema enum
> Status: Accepted • Pre-Sprint 10
> Cross-refs: 05-BACKEND-SCHEMA (notifications_type_check), TRD §10.1,
>             PRD FR-NOTIF-02 (stale), IMPL-PLAN §13 (stale)
>
> Context: schema + TRD say 18; PRD + Impl-Plan say 14. Source-of-truth precedence
>   gives it to the schema. The discrepancy is explained, not arbitrary: the six types
>   without an MVP-by-Sprint-10 producer include month_ready + the three rollover_*
>   types — exactly four system-generated events. 18 - 4 = 14. The PRD counted
>   user-facing notifications and skipped the system ones.
>
> Decision:
>   1. The canonical count is 18. PRD §4.9 and IMPL-PLAN §13 are patched to 18 in the
>      same commit as this ADR.
>   2. The MVP coverage test asserts every type WITH a producer (12 at Sprint 10) and
>      enumerates the deferred six by name with their owning sprint. A bare "18 tested"
>      would force inventing emitters for types that do not exist yet.
>   3. No enum value is added for ordinary chat messages. Chat delivers via socket;
>      only @mentions create a notification row. The enum is a CHECK constraint —
>      adding a value is a migration, and doing so for chat would be scope drift.
>
> Rule: the enum is the count. Any doc that disagrees is patched, not worked around.
> ```
>
> **`ADR-021-bot-archive-attribution.md`**
> ```
> # ADR-021 — Bot conversation ownership in the messages archive
> Status: Accepted • Pre-Sprint 10 (build impact: Sprint 10 STEP 2, before chat writes)
> Cross-refs: TRD §9.4, 05-BACKEND-SCHEMA (messages, bot_sessions), NFR §5.2, ADR-014
>
> Context: TRD §9.4 claims a persistent archive at messages/channel='bot'. It cannot
>   work as built: messages.sender_id is NULL for bot rows by canonical design, and
>   there is no recipient_id, owner column, or session reference — every bot reply to
>   every user is indistinguishable. Once the 12h Redis TTL expires, ownership is
>   unrecoverable, which makes NFR §5.2's 12-month retention meaningless. Meanwhile
>   bot_sessions (migration 020, with staff_id and a DELETE grant) is written by no sprint.
>
> Decision:
>   1. The USER's bot turn persists to messages with sender_id = staffId, channel='bot'.
>      This must happen FIRST — parent_id gives ownership by join, which only works if
>      the row it points at carries the owner.
>   2. The BOT's reply persists with sender_id = NULL (unchanged, per the schema comment)
>      and parent_id = the user turn's id. Zero migration: parent_id exists and already
>      FKs messages(id), and a bot reply genuinely is a reply.
>   3. Ownership resolves as COALESCE(m.sender_id, parent.sender_id).
>   4. bot_sessions holds the SESSION ENVELOPE: one row per conversation, staff_id,
>      last_activity_at bumped per turn. It is the handle for the 12-month retention job
>      and any future resume-session feature. It is NOT the ownership source and is NOT
>      re-derived per message — parent_id owns the message graph, bot_sessions owns the
>      session lifecycle. Orthogonal jobs, so neither has to agree with the other.
>   5. This lands BEFORE common chat becomes a second writer to messages.
>
> Rule: two mechanisms, two questions. parent_id answers "whose message"; bot_sessions
>   answers "whose conversation, and when". Never make them redundant.
> ```
>
> **`ADR-022-realtime-cache-strategy.md`**
> ```
> # ADR-022 — Grid real-time: patch vs invalidate
> Status: Accepted • Pre-Sprint 10 (build impact: Sprint 10 STEP 9, all future grids)
> Cross-refs: TRD §8, NFR §1.3, ADR-012, ADR-013, Sprint 13 k6
>
> Context: with 50 users on the content calendar, one cell edit broadcast to org:all
>   makes 50 clients invalidate ['content-calendar', period] — 50 refetches for one change.
>
> Decision — the dividing line is correctness, not performance:
>   PATCH the TanStack cache when the event payload contains the COMPLETE new state of a
>     single addressable cache entry.
>   INVALIDATE when it does not — when the change touches a trigger, a cascade, an
>     aggregate, membership, or row ordering.
>
>   Patch:      content-calendar:updated (clientId+period+date+value+version)
>               shoot:slot_updated (the slot's OWN fields)
>               client:name_updated
>   Invalidate: attendance:holiday_added/removed (one holiday flips every staff column
>                 for that date + reverts logs — the H-01 cascade)
>               task:created / :updated / :assigned (ordering, membership, fan-out)
>               content-dropper derived-status shifts (ADR-013) unless the payload
>                 carries the recomputed status
>               the pipeline side of shoot:slot_updated when Trigger 1 recomputes
>                 coming_shoot_date
>
>   Supporting rules:
>   a. Every patchable event's payload MUST carry the new version. A patch that leaves a
>      stale cached version guarantees the next optimistic write 409s spuriously.
>      If a payload cannot carry it, that event is invalidate-only by definition.
>   b. The sender is excluded from its own broadcast. The originator already has the
>      optimistic update; re-patching from the echo double-applies or fights the
>      in-flight mutation.
>
> Rule: a patched cache missing a trigger side effect is showing stale derived data —
>   worse than a refetch. Correctness decides; the fan-out reduction follows for free,
>   because the hot path (calendar cells) is the patchable one.
> ```
>
> **`ADR-023-presence-hash.md`**
> ```
> # ADR-023 — Presence via a single Redis hash with heartbeat freshness
> Status: Accepted • Pre-Sprint 10
> Cross-refs: TRD §8, THIRD-PARTY §5.2, NFR §1.3, INFRA §10
>
> Context: GET /chat load does KEYS presence:* — O(N), blocks Redis's single-threaded
>   event loop, and bills per command on Upstash. Harmless at 50 keys; still the wrong
>   primitive, and invisible until it pages someone.
>
> Decision:
>   key "presence" (one hash) · field = staffId · value = last-seen epoch
>   online:  HSET presence {staffId} {now}      (client heartbeat ~30s over the socket)
>   load:    HGETALL presence, filtered to now - lastSeen < 60s
>   offline: HDEL presence {staffId} on clean disconnect
>   sweep:   expired fields HDEL'd on read, so the hash does not grow with departed staff
>
>   The freshness filter is REQUIRED, not optional: a hash field has no per-field TTL,
>   so the hash alone would trade a blocking-command problem for a ghost-presence problem.
>   Storing a timestamp rather than "1" is what makes expiry work.
>
>   THIRD-PARTY §5.2's key registry is patched in the same commit — a Redis key registry
>   that lies is worse than none.
>
> Rule: no KEYS, SCAN, or wildcard command on a request path. Ever.
> ```
>
> Then **patch the stale docs in this same change**: `docs/01-PRD.md` §4.9 (FR-NOTIF-02: 14 → 18), `docs/06-IMPLEMENTATION-PLAN.md` §13 (14 → 18), `docs/11-THIRD-PARTY-INTEGRATIONS.md` §5.2 (the presence key row → the hash).
>
> Show me the four ADRs, then the three doc patches as diffs.

**Verify:**

```bash
ls docs/adr/ADR-0{17,18,19,20}*.md
grep -n "14 event types\|all 14 types" docs/01-PRD.md docs/06-IMPLEMENTATION-PLAN.md   # expect: nothing
grep -n "presence:{staffId}" docs/11-THIRD-PARTY-INTEGRATIONS.md                       # expect: nothing
git add docs/ && git commit -m "docs(adr): ADR-020 notification count, ADR-021 bot archive, ADR-022 realtime cache, ADR-023 presence hash; patch PRD/IMPL-PLAN/THIRD-PARTY"
```

### 1.7 — Branch

```bash
git checkout -b sprint-10-chat-notifications
```

**Verify gate:** Sprint 9 green, Playwright fully green with no skips, census complete, bot-persistence state known, adapter status recorded, four ADRs + three doc patches committed. Proceed.

---

## SPRINT 10 — STEP 2: Bot archive attribution (ADR-021) — **before chat touches `messages`**

**Goal:** Make bot conversations attributable while `messages` still has exactly one writer.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 10, STEP 2. Fixing the bot archive before common chat becomes a second writer to `messages`. Read `docs/adr/ADR-021` (follow it exactly), `docs/05-BACKEND-SCHEMA.md` (`messages`, `bot_sessions`), `docs/02-TRD.md` §9.4, `docs/13-NFRS.md` §5.2, and `apps/api/src/services/BotService.ts`.
>
> My STEP 1.4 finding was **[A: nothing in messages / B: both turns, no parent_id / C: bot replies only]**. Here is the current state: **[paste the SQL output]**.
>
> **WHAT TO BUILD**
>
> 1. **Persist both turns, in order** (adapt to the finding above — if the user turn already persists, keep that write and add the link):
>    - **User turn**, written before the model is called: `{ channel: 'bot', sender_id: staffId, sender_type: 'user', content, content_type: 'text' }`. Capture the returned id.
>    - **Bot reply**, written when the terminal turn is finalised: `{ channel: 'bot', sender_id: NULL, sender_type: 'bot', content: <final text>, parent_id: <user turn id> }`.
>    - `sender_id` stays NULL on bot rows — the schema comment is correct and ADR-021 does not change it. Ownership is by join.
>
> 2. **`bot_sessions` — the session envelope.** One row per conversation, not per message:
>    - On session start (the same moment the Redis `bot:session:{staffId}` is created): insert `{ id, staff_id, created_at, last_activity_at }`, and carry that `id` in the Redis session blob.
>    - Per turn: `UPDATE bot_sessions SET last_activity_at = now()`.
>    - It is **not** the ownership source and is **not** re-derived per message.
>
> 3. **Ownership resolution helper** — `getBotConversation(staffId, limit, offset, db)`:
>    ```sql
>    SELECT m.*, COALESCE(m.sender_id, p.sender_id) AS owner_staff_id
>    FROM messages m
>    LEFT JOIN messages p ON p.id = m.parent_id
>    WHERE m.channel = 'bot'
>      AND COALESCE(m.sender_id, p.sender_id) = $1
>    ORDER BY m.created_at DESC
>    ```
>    Wire it as the DB fallback behind `GET /v1/bot/session/current` — Redis first, then this when the 12h TTL has expired. That fallback is the entire point: without it the archive is write-only.
>
> 4. **Existing orphan rows** (finding C only): count them, and leave them. Do **not** guess ownership by timestamp proximity. Add one line to the ADR recording the count and that they are unattributable by design of the old write path.
>
> 5. **Persist-then-emit becomes a SEAM, and the rule sharpens to "emit after COMMIT, not after write."**
>
>    Sprint 9's rule had a test, and it passed for nine sprints by luck: `finalise` happened to
>    `await` a DB write *after* the emit, and that await gave the async assertion time to observe
>    an already-persisted session. Move both durable writes ahead of the emit — which ADR-021
>    correctly requires — and the test fails with no product regression. **An outcome test cannot
>    distinguish ordered from luckily ordered.** It is an unenforced invariant, not a fixed bug,
>    and Sprint 10 adds five more emitters (`chat:message`, `chat:deleted`, `notify:new`,
>    `notify:read`, `presence:changed`) plus every enriched grid payload from ADR-022. Each is a
>    fresh roll of the same dice.
>
>    **Why COMMIT and not WRITE:** `NotificationService.create` runs inside the *caller's*
>    transaction — it inserts through `trx` and emits. The row is written but not durable. Before
>    ADR-022 a rolled-back caller meant a spurious bell; after it, subscribers **patch** their
>    caches from these payloads, so fifty clients are left holding a state that never existed in
>    the database, with no refetch coming to correct them. A patch is only safe if the thing it
>    describes is durable.
>
>    Build `apps/api/src/lib/emit-after-commit.ts` — `AsyncLocalStorage`, matching
>    `lib/bot/actor-context.ts` (same argument ADR-016 made: threading a buffer through every
>    signature means "forgot one" is silent). Every emitter goes through `emitAfterCommit()`;
>    every `db.transaction().execute(fn)` becomes `transactionWithEmits(db, fn)` — the parens
>    balance, so it is a prefix rewrite.
>
>    **The test asserts ordering explicitly**, not by outcome:
>    ```ts
>    expect(persistSpy.mock.invocationCallOrder[0])
>      .toBeLessThan(emitSpy.mock.invocationCallOrder[0]);
>    ```
>    plus: **a throwing transaction emits nothing** (and leaves no row).
>
> 6. **Tests** `apps/api/test/services/BotArchive.test.ts`:
>    - A bot exchange writes exactly two `messages` rows, correctly shaped and linked.
>    - The ownership query returns user A's conversation and **not** user B's — the assertion that was impossible before this change.
>    - A `bot_sessions` row exists with the right `staff_id`; `last_activity_at` advances across turns; a second turn does **not** create a second session row.
>    - `GET /v1/bot/session/current` falls back to the DB when the Redis key is deleted, and returns the same turns in the same order.
>    - Sprint 9's confirmation flow still archives correctly (turn 1 summary, turn 2 outcome — both are turns).
>
> **RULES**
>
> - The user turn is written **before** the model call, not after. A crash mid-stream must still leave an attributable question.
> - Do not backfill `sender_id` on bot rows. Do not add an owner column. Do not add a migration — everything here uses existing columns.
> - `bot_sessions` and `parent_id` must not both encode ownership. If you find yourself querying `bot_sessions` to answer "whose message is this", you have recreated the dual-write problem inside one feature.
>
> Show me the two writes with the linking, then the ownership query, then the DB fallback.

`▶ /ponytail` — the two writes plus the session upsert plus the activity bump will read as four separate Redis/DB round trips around one logical turn. Ask him whether the turn wants a single `recordTurn()` seam.

**Verify:**

```bash
pnpm --filter @skaly/api test services/BotArchive services/BotService
psql "$DATABASE_URL" -c "SELECT channel, sender_type, parent_id IS NOT NULL AS linked, count(*) FROM messages GROUP BY 1,2,3;"
pnpm typecheck
```

---

## SPRINT 10 — STEP 3: Presence (ADR-023)

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 10, STEP 3. Replacing `KEYS presence:*` with a single hash. Read `docs/adr/ADR-023`, `docs/02-TRD.md` §8, `docs/11-THIRD-PARTY-INTEGRATIONS.md` §5.2 (patched in STEP 1.6), and `docs/13-NFRS.md` §1.3 (presence propagation < 2s).
>
> **WHAT TO BUILD** — `apps/api/src/services/PresenceService.ts`:
>
> ```
> key "presence" (one hash) · field = staffId · value = last-seen epoch ms
> ```
> - **`markOnline(staffId)`** → `HSET presence {staffId} {Date.now()}`. Called on socket connect and on each heartbeat.
> - **`markOffline(staffId)`** → `HDEL presence {staffId}`. Called on clean disconnect.
> - **`getOnline()`** → `HGETALL presence` → filter to `now - lastSeen < 60_000` → **`HDEL` the expired fields in the same pass** (the sweep) → return the fresh staffIds.
> - **Heartbeat:** the client emits `presence:ping` every **30s** over the existing socket; the server calls `markOnline`. Half the freshness window, so one dropped beat doesn't flicker someone offline.
> - **Broadcast** `presence:changed` on genuine transitions only — compare against the previous set and emit deltas, not the whole roster on every beat.
> - **Freelancer isolation (ADR-011):** a freelancer's presence roster is filtered to the staff they can already see. Presence must not become a directory of everyone.
>
> **Migration of the old keys** — a one-time cleanup, not a data migration:
> ```bash
> # old per-staff keys expire on their own 60s TTL; this just tidies immediately
> redis-cli --scan --pattern 'presence:*' | xargs -r redis-cli DEL
> ```
> Put this in the deploy notes. **`SCAN`, not `KEYS`** — and it runs once, off the request path.
>
> **Tests** `apps/api/test/services/PresenceService.test.ts`:
> - `markOnline` then `getOnline` includes the staffId.
> - A field older than 60s is excluded **and** removed from the hash (assert both — the filter and the sweep).
> - A heartbeat within the window keeps the user online.
> - `markOffline` removes immediately.
> - `presence:changed` fires on transition, **not** on a heartbeat that changes nothing.
> - **No `KEYS` anywhere:** `grep -rn "\.keys(" apps/api/src` returns nothing on a request path.
>
> **RULES**
>
> - The value is a **timestamp**, never `"1"`. That is what makes expiry work without per-field TTL.
> - No `KEYS`, `SCAN`, or wildcard command on any request path.
> - The sweep happens on read. No separate cron.
>
> Show me the service, then the heartbeat wiring on the socket.

`▶ /ponytail` — `markOnline`, the heartbeat handler, and the transition-diff will have three copies of "read the set, compare, maybe emit". Point him at it.

**Verify:**

```bash
pnpm --filter @skaly/api test services/PresenceService
grep -rn "KEYS \|\.keys(" apps/api/src --include=*.ts | grep -v test   # expect: nothing
redis-cli HGETALL presence
```

---

## SPRINT 10 — STEP 4: `NotificationService` completion (ADR-020)

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 10, STEP 4. Completing notifications. Read `docs/adr/ADR-020`, `docs/02-TRD.md` §10, `docs/05-BACKEND-SCHEMA.md` (`notifications` — the 18-value enum), `docs/07-API-CONTRACT.md` (`/v1/notifications/*`), and the existing `NotificationService` from Sprint 2.
>
> My STEP 1.3 census: **[paste the producer table]**.
>
> **WHAT TO BUILD**
>
> 1. **A type registry** — `packages/shared/src/constants/notifications.ts`: all 18 types as a const map of `{ type → { title, template, linkBuilder, icon, severity } }`, so a new type is one entry and nothing else. Types whose producers land in Sprints 11–13 are present in the registry with a `// producer: Sprint N` comment — the registry mirrors the enum exactly, even where the emitter doesn't exist yet.
> 2. **`notify:new` delivery**: on create, write the row **then** emit to that recipient's room (persist-then-emit, as established Sprint 2). Payload = the full notification, so the bell can prepend without refetching (ADR-022's patch principle applied to notifications).
> 3. **Dedup for repeating types.** `task_overdue` runs on a sweep; without a guard the same task notifies daily forever. Suppress a duplicate `(recipient, type, record_id)` within 24h. Do this in the service, not the producer, so every future repeating type inherits it.
> 4. **Unread count**: `GET /v1/notifications?unread=true&limit=` plus a cheap `count`. Cap the badge display at 99+ in the UI, not the query.
> 5. **Mark read**: `PATCH /v1/notifications/:id/read` and `POST /v1/notifications/read-all`. Both emit `notify:read` so a second open tab updates its badge.
> 6. **Retention (NFR §5.2)**: leave the 12-month `messages` cleanup job to Sprint 12's cron work, but add the query as a tested service method now so the cron is a one-liner later.
>
> **RULES**
>
> - **No new enum value for ordinary chat messages** (reconciliation #2). Only `mention` fires from chat.
> - The registry mirrors the enum. If they can drift, add a test that asserts they can't.
> - Never notify the actor about their own action (the ADR-006 non-actor rule, applied generally).
>
> **Tests:** every registry entry has a template + linkBuilder; **registry keys === enum values** (assert set equality — this is the guard against future drift); dedup suppresses inside 24h and allows after; `notify:new` payload is complete enough to render without a refetch; self-action produces no row.
>
> Show me the registry and the dedup guard.

`▶ /ponytail` — eighteen registry entries is fine and shouldn't be compressed. But the create → dedup → persist → emit path will have grown branches; that's his target.

**Verify:**

```bash
pnpm --filter @skaly/api test services/NotificationService
pnpm typecheck
```

---

## SPRINT 10 — STEP 5: Notification routes + bell UI

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 10, STEP 5. Notification API + bell. Read `docs/07-API-CONTRACT.md` (`/v1/notifications/*`), `docs/03-UIUX.md` (bell + panel), `docs/04-APPFLOW.md` (bell → panel → deep link).
>
> **WHAT TO BUILD**
>
> 1. **Routes** (all authenticated roles; scoped to the caller inside the service — the route does not filter):
>    - `GET /v1/notifications?unread=&limit=&cursor=`
>    - `PATCH /v1/notifications/:id/read`
>    - `POST /v1/notifications/read-all`
> 2. **Zod** in `packages/shared/src/schemas/notifications.ts`, `.strict()`.
> 3. **`NotificationBell`** in the topbar: icon + unread badge (99+ cap). Subscribes to `notify:new` → **prepends from the payload** (no refetch — ADR-022) and increments the badge; subscribes to `notify:read` → syncs across tabs.
> 4. **`NotificationPanel`** — Framer Motion popover, grouped Today / Earlier, each row = icon + title + body + DM Mono relative time. Click → mark read → navigate to `linkBuilder`'s URL → close. `[Mark all read]` in the header. Empty state per UI/UX.
> 5. **Frontend tests:** badge reflects unread count; `notify:new` prepends **without** a refetch (assert the query function was not called again); clicking marks read and navigates; read-all clears the badge; the panel closes on outside click and Escape.
>
> **RULES:** the panel renders from cache, patched by events. A refetch on every notification is the fan-out problem in miniature. Deep links use the registry's `linkBuilder` — no URL construction in the component.
>
> Show me the bell's event subscription and the panel.

`▶ /ponytail` — the Today/Earlier grouping plus per-type icon/severity rendering will sprawl. It should be driven by the registry, not by conditionals in JSX.

**Verify:**

```bash
pnpm --filter @skaly/api test routes/notifications
pnpm --filter @skaly/web test
```

---

## SPRINT 10 — STEP 6: `ChatService`

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 10, STEP 6. Chat backend. Read `docs/04-APPFLOW.md` (chat flow), `docs/07-API-CONTRACT.md` (`/v1/chat/*` incl. `GET /v1/chat/search`), `docs/05-BACKEND-SCHEMA.md` (`messages`, `message_mentions`, `messages.search_vector` from migration 018), `docs/08-AUTH-MATRIX.md` §3 + §6.2 (`chat.access`), `docs/13-NFRS.md` §4.3, and `apps/api/src/lib/queries.ts` (**`softDelete` lives here, not on `BaseService`**).
>
> **WHAT TO BUILD** — `apps/api/src/services/ChatService.ts`:
>
> 1. **`send(input, currentUser, db)`** — one transaction:
>    a. Insert `{ channel: 'common', sender_id, sender_type: 'user', content, content_type: 'text', parent_id? }`.
>    b. **Parse mentions** from `content` (`@Name`) → resolve to staffIds against active staff → insert `message_mentions` rows.
>    c. **Fan out one `mention` notification per mentioned user** (ADR-006), **excluding the author** — a self-mention creates the `message_mentions` row (it's real) but no notification.
>    d. Return the message with its resolved mentions.
> 2. **`list({ channel, cursor, limit }, currentUser, db)`** — **keyset pagination on `created_at` descending**, not OFFSET. At ~15k rows (NFR §2.2) OFFSET is survivable and still wrong; keyset is the same amount of code. Returns `{ messages, nextCursor }`. `softDeletable` applied.
> 3. **`getThread(parentId, …)`** — replies to one message, oldest first.
> 4. **`remove(id, currentUser, db)`** — `softDelete` from `lib/queries.ts`. Author, or admin/manager. Emits `chat:deleted` so other clients tombstone the row rather than refetching.
> 5. **`search(q, channel, currentUser, db)`** — `GET /v1/chat/search` per API-Contract, over `messages.search_vector` with `ts_rank(… websearch_to_tsquery('english', $1))`. **This is a separate endpoint from Sprint 9's `/v1/search`** — do not merge them; `messages` is deliberately not one of global search's four categories.
> 6. **`chat.access` enforcement** — resolved via `PermissionService`, **not** `requireRole`. Auth-Matrix §3 marks `/chat` 🔧 for freelancers: default-denied, admin-grantable. This is the key's first real use, so test both sides of the override.
>
> **RULES**
>
> - Store content **raw**. Sanitising on write destroys the original and pushes the problem to whoever reads the DB directly. Rendering is where escaping happens (STEP 11).
> - Mention parsing must not match inside a URL or a code span.
> - Never notify the author of their own mention.
> - Keyset, not OFFSET.
>
> **Tests:** send creates the message + mention rows + N notifications for N distinct non-author mentions; a self-mention creates the row and **no** notification; keyset pagination returns no duplicates and no gaps across pages; soft-deleted messages vanish from `list` but the thread's replies survive; a freelancer without `chat.access` gets 403 and **with** the override gets 200; chat search ranks and respects `softDeletable`.
>
> Show me `send` (with the mention fan-out) and `list` (keyset).

`▶ /ponytail` — the mention parser + resolver + fan-out is three responsibilities in one method. And check that `list`, `getThread`, and `search` don't each carry their own copy of the row-shaping logic.

**Verify:**

```bash
pnpm --filter @skaly/api test services/ChatService
pnpm typecheck
```

---

## SPRINT 10 — STEP 7: Chat routes + socket wiring

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 10, STEP 7. Chat routes and socket events. Read `docs/07-API-CONTRACT.md`, `docs/02-TRD.md` §8 (**namespaces and rooms — use the existing ones; ADR-005 forbids a new namespace**), `docs/08-AUTH-MATRIX.md` §3.
>
> **WHAT TO BUILD**
>
> 1. **Routes**, each gated on `chat.access` via `PermissionService`:
>    - `GET /v1/chat/messages?channel=&cursor=&limit=`
>    - `POST /v1/chat/messages`
>    - `GET /v1/chat/messages/:id/thread`
>    - `DELETE /v1/chat/messages/:id`
>    - `GET /v1/chat/search?q=&channel=`
> 2. **Zod** `packages/shared/src/schemas/chat.ts` — `.strict()`; content `min(1).max(4000)`.
> 3. **Socket events** on the **existing** namespace (confirm which from TRD §8 before wiring):
>    - `chat:message` — new message, full payload so clients append without refetching.
>    - `chat:deleted` — `{ id }`, clients tombstone.
>    - `chat:typing` — `{ staffId, isTyping }`, **ephemeral, never persisted**, server-side throttled to at most one per user per 2s.
>    - `presence:changed` — from STEP 3.
>    - **Sender exclusion:** use `socket.broadcast.to(room).emit(...)` so the author doesn't receive their own message back (ADR-022 rule b). The author already rendered it optimistically.
> 4. **Route tests:** every role's access matches Auth-Matrix §3 including the freelancer override both ways; cursor pagination; `.strict()` rejects unknown fields; envelopes per §1.1.
>
> **RULES:** no new namespace (ADR-005). Typing is never written to the DB. The route does not filter — the service does.
>
> Show me the routes, then the socket handlers with sender exclusion.

**Verify:**

```bash
pnpm --filter @skaly/api dev    # /docs lists all five chat routes
pnpm --filter @skaly/api test routes/chat
```

---

## SPRINT 10 — STEP 8: Backend tests + coverage census

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 10, STEP 8. Rounding out backend tests. Read `docs/12-TESTING-STRATEGY.md` and `docs/adr/ADR-020`.
>
> **WHAT TO BUILD**
>
> 1. **⭐ Notification coverage test (ADR-020)** — the one that closes the 18-vs-14 question:
>    - Assert `Object.keys(NOTIFICATION_REGISTRY)` **exactly equals** the enum's 18 values (set equality, both directions).
>    - For each of the **12 types with an MVP producer**, trigger the real producer and assert a correctly shaped row lands.
>    - For the **6 deferred**, a single test listing them by name with their owning sprint and `expect(DEFERRED).toHaveLength(6)` — so the deferral is *asserted*, not merely commented. When Sprint 11 adds `report_ready`, that test fails until the list is updated. That is the intended behaviour.
> 2. **Mention fan-out:** 3 distinct mentions → 3 notifications; a repeated mention of the same person in one message → 1; author self-mention → 0.
> 3. **Presence:** the STEP 3 suite, plus a freelancer's roster excluding staff outside their scope.
> 4. **Bot archive:** the STEP 2 suite, plus the cross-user ownership assertion.
> 5. **Concurrency:** two simultaneous sends to the same channel both persist with distinct cursors and no pagination gap.
> 6. Full API suite + typecheck + lint.
>
> **RULES:** every test fails without its fix. The registry↔enum set-equality test is the drift guard — it must fail if someone adds an enum value without a registry entry, **and** if someone adds a registry entry without an enum value.
>
> Show me the coverage test first.

**Verify:**

```bash
pnpm --filter @skaly/api test
pnpm typecheck && pnpm lint
git add -A && git commit -m "Sprint 10 backend: bot archive (ADR-021), presence hash (ADR-023), notifications 18-type coverage (ADR-020), chat service"
```

---

## SPRINT 10 — STEP 9: Grid subscriptions (ADR-022) — retire every `// TODO(Sprint 10)`

**Goal:** Attach every deferred consumer, on the patch-vs-invalidate matrix.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 10, STEP 9. Attaching all deferred grid subscriptions. Read `docs/adr/ADR-022` (follow the matrix exactly), `docs/adr/ADR-012` + `ADR-013` (the triggers whose side effects decide patch-vs-invalidate), `docs/02-TRD.md` §8, and `apps/web/lib/socket.ts`.
>
> First, find every marker:
> ```bash
> grep -rn "TODO(Sprint 10)" apps/web apps/api
> ```
>
> **WHAT TO BUILD**
>
> 1. **Backend — payload enrichment.** Every patchable event must carry the complete new state of one addressable entry **including the new `version`**. Audit each emitter against the matrix; if a payload can't carry what a patch needs, that event becomes invalidate-only — say so rather than patching from a partial payload.
>
> 2. **Frontend — one `useRealtimeSync` hook per module**, driven by a **table**, not a switch:
>
>    | Event | Action | Why |
>    |---|---|---|
>    | `content-calendar:updated` | **patch** `['content-calendar', period]` | payload fully specifies one cell |
>    | `shoot:slot_updated` | **patch** the slot; **invalidate** `['content-dropper', period]` | Trigger 1 recomputes `coming_shoot_date` on the pipeline |
>    | `content-dropper:updated` | **patch** if the payload carries the recomputed derived status; else **invalidate** that row | ADR-013 |
>    | `client:name_updated` | **patch** every cached list holding that client | a string |
>    | `attendance:holiday_added` / `:removed` | **invalidate** `['attendance', period]` | H-01 cascade — one holiday flips every staff column and reverts logs |
>    | `task:created` / `:updated` / `:assigned` | **invalidate** `['tasks', period]` | ordering, membership, fan-out |
>    | `chat:message` / `:deleted` | **patch** the message list | append / tombstone |
>    | `notify:new` / `:read` | **patch** the bell | STEP 5 |
>    | `presence:changed` | **patch** the presence store | STEP 3 |
>
> 3. **Sender exclusion** — belt and braces. The server already uses `socket.broadcast`; the client additionally ignores events whose `actorStaffId` equals the current user. Two guards because the failure (double-applied patch fighting an in-flight optimistic update) is nearly impossible to debug from a bug report.
>
> 4. **Version on patch** — `setQueryData` must write the payload's new `version` into the cached row. Skipping this makes the user's *next* edit 409 spuriously, which will look like a backend bug.
>
> 5. **Every `// TODO(Sprint 10)` marker is deleted**, not commented out.
>
> 6. **Tests:** each event triggers the correct action (assert `setQueryData` vs `invalidateQueries` per row of the matrix — this table *is* the test); a patch updates the cached version; an event whose `actorStaffId` is the current user is ignored; the H-01 event invalidates rather than patching.
>
> **RULES**
>
> - The matrix is the spec. If an event isn't in it, it isn't wired — add it to the ADR first.
> - Never patch a change that touches a trigger, cascade, aggregate, or ordering. A patched cache missing a trigger side effect shows stale derived data, which is worse than the refetch you avoided.
> - `invalidateQueries` takes the v5 object form.
>
> Show me the hook and the event table, then the grep confirming zero remaining markers.

`▶ /ponytail` — the per-module hooks will be near-identical around a different table. That's his call: one generic hook driven by config, or N hooks. Take his answer.

**Verify:**

```bash
grep -rn "TODO(Sprint 10)" apps/web apps/api      # expect: nothing
pnpm --filter @skaly/web test
```

Manual two-browser check: admin in window A edits a calendar cell → window B updates in **< 500ms** (NFR §1.3) **without a network refetch** (DevTools Network shows no new GET). Then add a holiday in A → B **does** refetch attendance. Both behaviours are correct; the difference is the whole ADR.

---

## SPRINT 10 — STEP 10: Chat UI

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 10, STEP 10. The chat page. Read `docs/03-UIUX.md` (chat layout, message rows, typing indicator, presence dots), `docs/04-APPFLOW.md`, `docs/13-NFRS.md` §1.3.
>
> **WHAT TO BUILD** — `apps/web/app/(portal)/chat/page.tsx` + components:
>
> 1. **Reverse infinite scroll** — `useInfiniteQuery`:
>    - **⚠️ TanStack Query v5 requires `initialPageParam`.** Omitting it is a *runtime* error with an unhelpful message. Pair with `getNextPageParam: (last) => last.nextCursor`.
>    - **⚠️ Scroll anchoring.** Chat loads *older* messages when scrolling **up**. Capture `scrollHeight` **before** the prepend and restore `scrollTop += (newHeight - oldHeight)` in a `useLayoutEffect` **after** — otherwise the viewport jumps to the top on every page load. This is the single most common chat bug and no unit test catches it.
>    - IntersectionObserver sentinel at the top triggers `fetchNextPage`.
>    - New messages **pin to bottom only if the user is already near the bottom** (within ~100px). Yanking someone away from history they're reading is the second most common chat bug. Otherwise show a "↓ New messages" pill.
> 2. **Message rows** — avatar + name + DM Mono timestamp, consecutive messages from one author within 5 minutes grouped under one header. Mentions of the current user highlighted (gold tint per UI/UX). Presence dot from the presence store. Soft-deleted → tombstone ("Message deleted"), not removal.
> 3. **Composer** — Enter sends, Shift+Enter newline. `@` opens a mention autocomplete over active staff; selection inserts the display name and tracks the staffId.
> 4. **Typing indicator** — emit `chat:typing` on input, **throttled client-side to one per 2s**, auto-clear after 3s idle. Render "X is typing…" / "X and 2 others are typing…".
> 5. **Threads** — reply opens a side panel via `getThread`; the parent shows a reply count.
> 6. **Frontend tests:** `initialPageParam` present; scroll position **preserved** across a prepend (assert `scrollTop` adjusted); auto-scroll only when near bottom; typing throttled to one emit per 2s; a self-message isn't double-rendered from the echo; a tombstone renders for a deleted message.
>
> **RULES**
>
> - Scroll anchoring is not optional. Build it in the first pass; retrofitting it means re-testing everything.
> - Never `dangerouslySetInnerHTML` on message content.
> - Typing state is ephemeral — never in the query cache, never persisted.
>
> Show me the infinite-scroll hook with the anchoring, then the message row.

`▶ /ponytail` — the message row does grouping, mention highlighting, presence, tombstones, and thread counts. That's five concerns; ask him which are genuinely one.

**Verify:**

```bash
pnpm --filter @skaly/web test
pnpm dev
# Scroll up through 100+ seeded messages — no jump, no flicker.
# Read history while another window sends — you are NOT yanked down; the pill appears.
```

---

## SPRINT 10 — STEP 11: Reconnection UX + DOMPurify pass

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 10, STEP 11. Connection resilience and the XSS pass. Read `docs/09-ERROR-HANDLING.md` §5.4 (the exact contract), `docs/13-NFRS.md` §1.3 (reconnect < 30s) and §4.3.
>
> **WHAT TO BUILD**
>
> 1. **Reconnection banner** per Error-Handling §5.4 — amber, **non-blocking**, top of viewport, "Reconnecting…". Socket.io's built-in backoff (1s → 2s → 4s → 8s, max 30s) already matches the spec; configure, don't hand-roll.
> 2. **On reconnect:** refetch all stale queries, clear the banner, re-emit presence. Missed events are the reason the refetch is unconditional — the socket has no replay.
> 3. **Offline detection** — `navigator.onLine` + socket state. Disable the composer while disconnected with an explanatory tooltip rather than letting sends silently queue into nothing.
> 4. **DOMPurify pass (NFR §4.3):** audit every place message content renders. Content is rendered as **text**; a linkifier produces anchor elements, not HTML strings. Apply DOMPurify only where HTML is genuinely constructed — and if the answer is nowhere, record that in the commit message rather than adding `dangerouslySetInnerHTML` to justify the dependency.
>    ```bash
>    grep -rn "dangerouslySetInnerHTML" apps/web    # expect: nothing, or a justified single case
>    ```
> 5. **Tests:** banner appears on disconnect and clears on reconnect; stale queries refetch once (not per query, per reconnect); the composer disables offline; a message containing `<script>` and `<img onerror=…>` renders as literal text in the DOM.
>
> **RULES:** the banner never blocks interaction — read-only use continues while disconnected. Don't reimplement backoff.
>
> Show me the connection state hook and the banner.

**Verify:**

```bash
pnpm --filter @skaly/web test
# DevTools → Network → Offline: banner appears, composer disables.
# Back online within 30s: banner clears, data refetches, presence returns.
```

---

## SPRINT 10 — STEP 12: Playwright — two-context concurrency

### 12.1 — Setup (manual)

Real-time needs **two browser contexts in one test**. Confirm the Sprint 3–9 `loginAs` helper works per-context:

```ts
const ctxA = await browser.newContext(); const ctxB = await browser.newContext();
const admin = await ctxA.newPage();      const member = await ctxB.newPage();
```

### 12.2 — Prompt

> **WHERE WE ARE**
>
> Sprint 10, STEP 12. E2E for real-time. Read `docs/12-TESTING-STRATEGY.md`. **Two browser contexts per test** — one actor, one observer. Reuse the Sprint 3–9 `loginAs` and `playwright.config.ts`.
>
> **WHAT TO BUILD** — `tests/e2e/chat.spec.ts`, `notifications.spec.ts`, `realtime.spec.ts`:
>
> **chat.spec.ts**
> 1. A sends a message → **B sees it within 2s** without reloading.
> 2. A @-mentions B → B's **bell badge increments**; the panel row deep-links to the message.
> 3. A types → B sees "A is typing…" → it clears within ~3s of A stopping.
> 4. A deletes their message → B sees the tombstone.
> 5. Thread reply → parent shows the count in both contexts.
> 6. **Scroll anchoring:** seed 100 messages, scroll to the top, load an older page → **the anchored message stays in view** (assert its bounding box is stable).
> 7. **Freelancer without `chat.access`** → `/chat` returns 403 and the sidebar entry is absent. Admin grants the override → after the 5-minute perms cache expires (or is invalidated), access is granted.
>
> **notifications.spec.ts**
> 1. Assign a task to B → B's bell increments live; the panel shows it; clicking navigates and marks read.
> 2. `[Mark all read]` clears the badge in **both** of B's open tabs.
>
> **realtime.spec.ts**
> 1. **Patch path:** A edits a calendar cell → B's cell updates **and B issues no new GET** (`page.on('request')` — assert zero matching requests). *This is ADR-022's patch half.*
> 2. **Invalidate path:** A adds a holiday → B's attendance grid **does** refetch and every staff column for that date flips. *The invalidate half.*
> 3. **Sender exclusion:** A's own edit is not double-applied (the cell's value and version are each written once).
> 4. **Reconnect:** kill B's socket (`page.evaluate` disconnect) → banner appears → restore → banner clears and B's data catches up with edits made while it was down.
>
> Run headed once, then headless (chromium + webkit).
>
> **RULES:** independent and re-runnable; clean up messages and notifications in teardown. Assert **timing** where NFR §1.3 gives a number (< 500ms delivery, < 2s presence). Prefer `expect.poll` over fixed sleeps.
>
> Show me the two-context chat spec and the patch-vs-invalidate spec first.

**Verify:**

```bash
pnpm exec playwright test tests/e2e/chat.spec.ts tests/e2e/notifications.spec.ts tests/e2e/realtime.spec.ts
pnpm exec playwright test        # ENTIRE suite green
```

---

## SPRINT 10 — STEP 13: Smoke + NFR measurement + close-out (manual)

### 13.1 — Manual walk-through (two windows side by side)

1. **Chat:** send both ways; group consecutive messages; @mention → bell fires; thread; delete → tombstone.
2. **Scroll:** 100+ messages, scroll up repeatedly — **no jump**. Read history while the other window sends — you stay put, the pill appears.
3. **Typing + presence:** indicator appears/clears; presence dots reflect a closed window within 60s.
4. **Notifications:** every producer available today — assign a task, add a holiday, confirm a shoot, approve a signup, mention someone. Each produces the right row and deep link.
5. **⭐ Patch vs invalidate (ADR-022), with DevTools Network open:** edit a calendar cell → the other window updates with **no new GET**. Add a holiday → it **does** GET. Both correct; the distinction is the ADR.
6. **Version on patch:** after receiving a patched cell update, edit that same cell in the receiving window → it saves **without** a spurious 409. *(This is the check that catches a patch which forgot the version.)*
7. **Bot archive (ADR-021):**
   ```sql
   SELECT m.id, m.sender_type, COALESCE(m.sender_id, p.sender_id) AS owner
   FROM messages m LEFT JOIN messages p ON p.id = m.parent_id
   WHERE m.channel='bot' ORDER BY m.created_at DESC LIMIT 6;
   SELECT staff_id, last_activity_at FROM bot_sessions ORDER BY last_activity_at DESC LIMIT 3;
   ```
   Every row resolves to an owner. Then `DEL bot:session:{yourStaffId}` in Redis and reload `/bot` — **history still loads, from the DB.** That is the whole point of the ADR.
8. **Presence (ADR-023):** `redis-cli HGETALL presence` → one hash, timestamp values. `redis-cli KEYS 'presence:*'` → **empty**.
9. **Freelancer chat:** blocked by default; admin grants `chat.access`; access appears.
10. **Reconnection:** DevTools offline → banner, composer disabled → online → clears, catches up.
11. **NFR measurement (§1.3), numbers not vibes:**
    - WS delivery < 500ms — timestamp on send vs render.
    - Presence propagation < 2s.
    - Reconnect < 30s.
    - Chat page FCP < 1.5s with 100+ messages.

`▶ /ponytail` — full-sprint review before the close-out checklist.

### 13.2 — Close-out checklist

```
PRE-FLIGHT
  [ ] Sprint 9 green; the 4 carried E2E failures verified FIXED (no skips, no .only, no fixme)
  [ ] Notification producer census done — 12 MVP producers, 6 deferred with owning sprints
  [ ] Bot-persistence state determined (A/B/C) and recorded
  [ ] Socket.io Redis adapter status verified and recorded
  [ ] ADR-020/018/019/020 committed
  [ ] PRD §4.9 + IMPL-PLAN §13 patched 14 → 18
  [ ] THIRD-PARTY §5.2 presence key row patched to the hash

BOT ARCHIVE (ADR-021) — landed BEFORE chat writes
  [ ] User bot turn persists to messages with sender_id, BEFORE the model call
  [ ] Bot reply persists with sender_id NULL + parent_id = user turn id
  [ ] Ownership resolves via COALESCE(sender_id, parent.sender_id) (TESTED cross-user)
  [ ] bot_sessions row per conversation; last_activity_at bumped per turn; no duplicate rows
  [ ] GET /v1/bot/session/current falls back to DB when Redis expires (TESTED)
  [ ] No migration added; no sender_id backfill on bot rows
  [ ] Sprint 9's confirmation turns still archive correctly

PRESENCE (ADR-023)
  [ ] Single "presence" hash; value is a TIMESTAMP, not "1"
  [ ] 30s heartbeat; 60s freshness filter; expired fields swept on read (TESTED both)
  [ ] presence:changed fires on transition only, not per heartbeat
  [ ] Freelancer roster scoped (ADR-011)
  [ ] NO KEYS/SCAN on any request path (grep clean)
  [ ] Old presence:* keys cleaned; deploy note added

NOTIFICATIONS (ADR-020)
  [ ] Registry mirrors the enum — set equality asserted BOTH directions (the drift guard)
  [ ] 12 MVP-producer types tested end-to-end
  [ ] 6 deferred types asserted as a named list with owning sprints
  [ ] NO new enum value for ordinary chat messages
  [ ] Dedup: repeated (recipient, type, record) suppressed within 24h (TESTED)
  [ ] notify:new payload complete enough to render without a refetch (TESTED)
  [ ] Never notify the actor of their own action
  [ ] Bell badge (99+ cap), panel grouping, deep links, mark-read cross-tab

CHAT
  [ ] send → message + message_mentions + N notifications for N distinct non-author mentions
  [ ] Self-mention: row created, NO notification (TESTED)
  [ ] Keyset pagination — no duplicates, no gaps (TESTED)
  [ ] Soft delete via lib/queries.ts softDelete; tombstone, replies survive
  [ ] GET /v1/chat/search separate from /v1/search; ranked; softDeletable applied
  [ ] chat.access enforced via PermissionService, not requireRole — BOTH sides tested
  [ ] Content stored RAW; no dangerouslySetInnerHTML anywhere (grep clean)
  [ ] Typing throttled server-side and client-side; never persisted

REAL-TIME (ADR-022)
  [ ] Every // TODO(Sprint 10) marker deleted (grep clean)
  [ ] Event→action table matches the ADR matrix exactly (TESTED per row)
  [ ] ⭐ Patch path issues NO refetch (TESTED in E2E with request interception)
  [ ] ⭐ Invalidate path DOES refetch (H-01 holiday cascade)
  [ ] Patch payloads carry the new version; next edit does not 409 spuriously (TESTED)
  [ ] Sender excluded server-side (socket.broadcast) AND client-side (actorStaffId)
  [ ] No new namespace (ADR-005)

FRONTEND
  [ ] useInfiniteQuery has initialPageParam (v5 requirement)
  [ ] ⚠️ Scroll anchoring — position preserved across prepend (TESTED)
  [ ] Auto-scroll only when near bottom; "↓ New messages" pill otherwise
  [ ] Message grouping, mention highlight, presence dots, tombstones, thread counts
  [ ] Reconnection banner per Error-Handling §5.4 — amber, non-blocking, backoff not hand-rolled
  [ ] Refetch-on-reconnect; composer disabled offline

TESTS + NFRs
  [ ] Full API suite, frontend suite, Playwright (incl. two-context specs) green
  [ ] Every new test fails without its fix
  [ ] WS delivery < 500ms, presence < 2s, reconnect < 30s — MEASURED
  [ ] Chat FCP < 1.5s with 100+ messages
  [ ] pnpm typecheck + pnpm lint clean
  [ ] /ponytail run at each build step — no outstanding flags
```

### 13.3 — Commit

```bash
git add -A
git commit -m "Sprint 10: chat + notifications + presence + all grid real-time subscriptions; bot archive attribution (ADR-021), presence hash (ADR-023), notification count 18 (ADR-020), patch-vs-invalidate cache strategy (ADR-022)"
git push -u origin sprint-10-chat-notifications
```

Open the PR to `main`; CI fully green before merge. Merge, then `git checkout main && git pull`.

### 13.4 — Move to Sprint 11

`MASTER-BUILD-GUIDE-V2-FINAL.md` → PART 9 → **SPRINT 11 — SETTINGS + REPORTS**: the settings panel (Staff, Clients, Permissions, Signup Requests, Holidays, Months, Audit Log), PDF report generation via `@react-pdf/renderer`, and the `report_ready` notification — the first of Sprint 10's six deferred types to get a producer.

---

## DECISIONS TO MAKE BEFORE SPRINT 11

- **⚠️ Client lifecycle is one-way, and Sprint 11 is where that surfaces.** As-built (confirmed after Sprint 9): `ClientService.deactivate` exists, there is **no reactivate endpoint and no `reactivate_client` bot tool**, and no spec defines one — yet Sprint 5's mid-month backfill explicitly contemplated "created **or reactivated**", and `account_reactivated` exists as a notification type for *staff*. Sprint 11 builds Settings → Clients, which is exactly where an admin will expect an "undo" for a misclicked deactivation. Decide now: **(a)** add reactivate (service + route + backfill for the current period, mirroring create), **(b)** leave it one-way and make the Settings UI say so explicitly with a confirmation that names the consequence, or **(c)** soft-hide instead of deactivate. *Recommendation: (a) — the backfill logic already exists from `create`, deactivate is already soft, and a one-way destructive action with no undo in an admin panel is the kind of thing that generates a support request on week one.*

- **PDF generation is the first CPU-bound request on the API server.** NFR §1.2 budgets `POST /v1/reports/generate` at p95 < 10s / p99 < 20s, and `@react-pdf/renderer` renders **synchronously on the event loop** — a 15s render blocks every other request on that single Railway instance, including health checks (`healthcheckTimeout = 30`, Infra §4). Decide the execution model before building: **(a)** inline with a hard timeout and a documented concurrency cap of 1, **(b)** a worker thread, or **(c)** async job + `report_ready` notification + presigned link (which the schema and the notification enum **already anticipate** — `report_ready` exists, and REPORT_EXPIRY_SECONDS is 24h precisely so "notification links survive a full working day"). *Recommendation: (c). The spec has been quietly designed for it since the schema was written.*

- **Audit log export at 50k rows.** Settings → Audit Log needs filter + export (NFR §5.3). At 12 months the table is ~50,000 rows (NFR §2.2). Decide whether export streams (CSV via a cursor) or buffers — a buffered 50k-row JSON response is a memory spike on the same single instance that's now also rendering PDFs. *Recommendation: stream CSV with a cursor; it's less code than pagination and has no memory ceiling.*

- **The 5-minute permissions cache vs. the Settings → Permissions UI.** `perms:{staffId}` has a 5-minute TTL with invalidation on write (Auth-Matrix §6.3). Sprint 11 gives admins a UI to toggle permissions, so they will change one and immediately test it. Confirm the invalidation actually fires on every write path the new UI uses — and note 8.1 STEP 3.4 deliberately deferred the *push* event, so the affected user's open session still won't learn about it until their next request. Decide whether Sprint 11 adds that push now that there's a UI making changes routine.

- **⚠️ The 12-month retention job's delete shape — ruled in ADR-021's addendum, built in Sprint 12.** Sprint 10's `parent_id` link makes deletion order matter, and the test teardowns already produced a working reproduction of the failure. `messages_parent_id_fkey` is `NO ACTION`, which is **not** `RESTRICT`: Postgres checks it at *statement end*, so a single `DELETE … WHERE id IN (…)` removing parent and children **together** already works with no schema change. What fails is two statements, or parent-first. `SET NULL` is rejected (it re-orphans bot replies — the exact bug ADR-021 fixes); `CASCADE` is rejected (`parent_id` is also the chat thread link, so one hard-deleted parent could take replies still inside their own retention window — data loss adopted to solve an ordering problem). Keep `NO ACTION`; make the job **session-scoped and single-statement**: bot rows age out by `bot_sessions.last_activity_at` so a turn-pair is never split across the cutoff, and chat threads — which have no session envelope — exclude any parent whose replies are newer than the cutoff. **Write the job's test from the teardown's fix** before it expires from memory.

- **Still deferred, on schedule:** comment system + `new_comment` producer (Sprint 12), attachment orphan cron + `coming_shoot_date` rollover recompute (Sprint 12), rollover + its four notification types (Sprint 12–13), Socket.io Redis adapter verification if STEP 1.5 found it missing (before any second API instance).

- **⚠️ Pre-launch gate, not a sprint item — the recovery-code redeem path.** Carried since Sprint 8 STEP 8.4: codes are generated and stored, but there is no redeem flow. An admin or manager who loses their authenticator currently has recovery codes they cannot spend, and MFA is mandatory for both roles. The only recovery is another admin resetting MFA (Auth-Matrix §10) — which fails if the *only* admin is locked out. This has now been carried through three sprints; it needs an owner before launch, not another deferral.

---

## TROUBLESHOOTING — SPRINT 10 SPECIFIC

### The chat viewport jumps to the top when older messages load
Scroll anchoring is missing. Capture `scrollHeight` before the prepend and restore `scrollTop += (newHeight - oldHeight)` in a `useLayoutEffect` after. `useEffect` is too late — the browser has already painted.

### `useInfiniteQuery` throws at runtime with an unhelpful message
TanStack Query v5 requires `initialPageParam`. It is a runtime error, not a type error, which is why it survives typecheck.

### Users see their own messages twice
Sender exclusion is missing. Use `socket.broadcast.to(room).emit(...)` server-side **and** ignore events whose `actorStaffId` matches the current user client-side. Both, per ADR-022 rule b.

### After receiving a real-time cell update, the next edit 409s
The patch didn't write the payload's new `version` into the cache. ADR-022 rule a — every patchable payload carries the version, and `setQueryData` must apply it. This presents as a backend bug and is not one.

### One holiday change leaves other staff columns stale
Someone patched instead of invalidating. `attendance:holiday_added/removed` is **invalidate-only** — the H-01 cascade flips every staff column for that date and reverts logs, which no single-cell payload can express.

### Presence shows ghosts who closed their browser
The hash value is `"1"` instead of a timestamp, or the freshness filter is missing. A hash field has no per-field TTL — the timestamp plus the 60s filter *is* the expiry mechanism (ADR-023).

### The notification coverage test can't pass — a type has no emitter
Correct, and expected for the six deferred types. Do **not** invent an emitter. Assert the deferred list by name with owning sprints (STEP 8.1); it will fail when Sprint 11 adds `report_ready`, and updating it then is the intended workflow.

### The bell shows the right count but the panel is empty
The badge is patching from the `notify:new` payload while the panel reads a separate query that was never seeded. Both must read the same cache entry.

### `/bot` history disappears after 12 hours
The DB fallback behind `GET /v1/bot/session/current` isn't wired (STEP 2.3). Redis first, then the `COALESCE` ownership query. Without the fallback, ADR-021 makes the archive attributable but still unreachable.

### A freelancer with `chat.access` granted still gets 403
The `perms:{staffId}` cache (5-min TTL). Confirm invalidation fires on the permission write — and note that 8.1 STEP 3.4 deliberately deferred the *push* to open sessions, so their next request picks it up, not their current page.

### Typing indicators flicker or spam the socket
Throttle in both places: client-side to one emit per 2s, server-side to one broadcast per user per 2s. Auto-clear after 3s of no input.

---

## END OF SPRINT 10 DETAILED GUIDE

*Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1..9-DETAILED.md`. Source-of-truth precedence when documents differ: the numbered spec docs (`01`–`14`) + the schema win, then this guide's reconciliations and the ADRs it executes (005–020), then the Master Build Guide's shorthand. This is the sprint where the portal becomes genuinely concurrent — every prior grid was a single-user surface with an optimistic update, and this one puts fifty people on the same rows. The two unforgiving parts are scroll anchoring (STEP 10) and the patch-vs-invalidate matrix (STEP 9); everything else is additive. Sprint 11 (Settings + Reports) introduces the first CPU-bound request on the API server — read the second decision above before starting, because the execution model has to be chosen before the first line of PDF code.*
