# SPRINT 9 — AI BOT (MUTATION) + SEARCH: DETAILED PROMPT-BY-PROMPT GUIDE

## Scaly Business Portal • Sprint 9 of 13

**Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1..8-DETAILED.md` + `SPRINT-8_1-PATCH-DETAILED.md`**
**Same Goal / Prompt / Verify framework as Sprints 0–8**
**Tooling interfaces verified as of July 2026** — `@anthropic-ai/sdk` (`messages.stream` + tool use), Next.js 15 (App Router), `cmdk` via `shadcn@latest add command`, TanStack Query v5 (object-form `invalidateQueries`), Zustand 5, Framer Motion 11, PostgreSQL 16 (`websearch_to_tsquery`, `ts_rank`, `pg_trgm` `similarity`/ILIKE-on-GIN), socket.io-client v4, Playwright latest, Lucide React.

> **Risk note:** the pre-build audit rates Sprint 9 🟡 High (confirmation protocol + search query strategy). The confirmation state machine (STEPS 3 + 5) is the deep work — it is the first place in this portal where a *probabilistic* system triggers an *irreversible write*. Do not compress those steps.

---

## USING THE `/ponytail` PLUGIN IN THIS SPRINT — PLACEMENT CHANGED

**`/ponytail` has moved.** Sprints 6–8.1 ran him at the **Verify** gate — *after* tests passed. That was the wrong spot: when he collapses fifty lines into one, the tests you just wrote against the fifty-line shape get thrown away with it.

From this sprint he runs **between the build prompt and the test prompt** — on the implementation, before anything is written against its shape. Look for `▶ /ponytail` immediately after a build step's implementation, with a specific target named.

He is **deliberately absent** from steps that are pure manual work, ADR authoring, branch creation, schema greps, or Swagger confirmation. A simplifier standing at a `git checkout -b` is noise, and noise trains you to skip his line.

**Where he earns his keep this sprint:** the confirmation state machine (one function, not a state-chart library), the mutation tool wrappers (eleven files that should be nearly identical), the search service (four queries that will want to become one clever query — let him decide), and the error→copy mapping (a switch that wants to be a table).

---

## WHAT YOU'RE BUILDING IN SPRINT 9

The bot can read. Sprint 9 lets it **write** — behind a confirmation gate that is a server-side state machine, not a convention — and adds global search. By the end of this week:

- **The pre-Sprint-9 decisions are executed and recorded** as **ADR-014** (two-turn confirmation), **ADR-015** (search role scoping), **ADR-016** (bot write attribution).
- **The carried E2E debt is closed**: the 4 pre-existing failures (3 shoot-planner, 1 signup-requests) that surfaced when the Sprint 7 `.env.e2e` shell-expansion bug was fixed. They have now been carried through two sprints; Sprint 9 adds specs on top of them, so they get fixed **first**.
- **`ClientService.create` + `deactivate` exist** — the gap that `add_client` / `deactivate_client` sit on, and that Sprint 5's mid-month backfill hook was already written against.
- **The two-turn confirmation state machine** works: turn 1 presents a **server-rendered** summary and stores a single, expiring, consume-once pending record carrying the **version captured at summary time**; turn 2 executes only on **deterministic** consent — never a model judgement.
- **All 11 mutation tools** work, each a thin wrapper calling its existing mutating service method with the JWT caller, so period-lock (423), optimistic-lock (409), ownership (403), dependency-block (400), and stage-sequence (400) all pass through unchanged — surfaced as friendly bot copy.
- **Bot writes are attributed to the human**: `audit_log.staff_id` = the caller, `changed_by_source = 'bot'`. This enum value has existed since migration 023 and **has never been written** — Sprint 9 is its first use.
- **Global search** works: `GET /v1/search?q=&scope=` over four categories with per-category role parity, correct ranking per index type, and a `scope` that is a no-op where no period column exists.
- **`GET /v1/activity-feed`** exists — role-filtered, humanised, sourced from `audit_log` but on its own read path (never the admin-only audit endpoint).
- **The CMD+K palette** is live on every portal page: `cmdk` via shadcn, 200ms debounce, scope toggle, 4 grouped sections, keyboard nav, role-correct staff navigation.
- **The bot chat panel renders the confirmation card** with inline `[Confirm]` / `[Cancel]` bound to a `confirmationId`.
- **Tests prove it**: the confirmation machine's every branch, **write-parity** (bot mutation == REST mutation, per role), bot attribution, version capture across the two turns, **search parity** per category, and the humanised feed's role filter.

**Estimated time:** 5 working days (Week 10 per `06-IMPLEMENTATION-PLAN.md` §12; owners TL + D3). Day 1 pre-flight (incl. the E2E debt) + `ClientService` + the confirmation machine; day 2 the 11 tools + `BotService` integration; day 3 bot tests + copy; day 4 search + activity feed + their tests; day 5 frontend (confirmation card + palette) + E2E.

**Prerequisites from Sprint 8 + 8.1** (all green — stop and fix if any is not):

- Sprint 8 close-out fully checked; **Sprint 8.1 executed and merged**; CI green on `main`.
- **8.1's consolidation is live**: one `loadOverrides` + one `getEffectivePermissions` in `PermissionService`; `lib/permissions.ts` deleted; the ESLint `no-restricted-imports` guard on `ROLE_DEFAULTS` active and proven to fire.
- `getPermittedBotTools` returns **`{ permitted, denied }`** (8.1 STEP 2) — Sprint 9 depends on this shape.
- `buildSystemPrompt` emits the `TOOL ACCESS` section only when `denied.length > 0` (8.1 STEP 4).
- The bot chassis: `BotService.handleMessage` tool loop (stream → `tool_use` → execute → second stream → terminal message), the 11 query tools each reusing an isolating service method with the JWT `currentUser`, the Redis session (`bot:session:{staffId}`, 50-turn cap, 12h TTL), C-01 (202 + `/ws/notify`), `bot:token` + terminal `bot:message`, the `isMutation` flag on every tool descriptor.
- `apps/web/lib/socket.ts` singleton with the C-05 refresh handshake; the bot chat panel + 11-card registry.
- MFA enrollment works end-to-end (the Sprint-1 `501` is gone).
- All mutating service methods exist and are tested: `TaskService.create/update/assign`, `HolidayService.create/remove`, `ShootPlannerService.update`, `ContentDropperService.updateStage`, `ContentCalendarService.updateCell`.
- `pnpm typecheck`, `pnpm lint`, and the full suite green on `main`.

---

## THE PRE-SPRINT-9 DECISIONS — WHERE THEY LAND

Ruled at the pre-Sprint-9 gate; **inputs** to this sprint. STEP 1 records the three ADRs; the steps below execute them.

| Decision | Ruling | Executed in |
|---|---|---|
| **Two-turn confirmation = server-side state machine** | Single expiring consume-once `pendingConfirmation` inside the Redis session. **Consent is never model-classified** — structured `decision` from the buttons, or a narrow exact-match affirmative allowlist for typed text. → **ADR-014** | STEP 1 (record) + STEP 3 + STEP 5 |
| **↳ Version captured at turn 1** | `expectedVersion` read when the summary is built and stored in the pending record; used at turn 2. Without this the bot silently becomes last-write-wins on `content_pipelines` + `content_calendar` and undoes C-02. | STEP 3 + STEP 4 |
| **↳ Summary is server-rendered** | The user consents to specific values; the model may not paraphrase them. Structured summary → `card: { type: 'confirmation', … }`; the buttons bind to `confirmationId`. | STEP 3 + STEP 10 |
| **↳ Turn 2 makes ZERO model calls** | Execute the stored call, render the outcome (or the friendly error) deterministically. Faster, cheaper, and the confirmation of an approved change must not be probabilistic prose. | STEP 5 |
| **Mutation tools reuse mutating service methods** | 423 / 409 / 403 / 400 pass through unchanged, surfaced as Error-Handling §6 copy. Parity discipline extends to writes. | STEP 4 + STEP 7 |
| **↳ `ClientService.create` / `deactivate` are built, not descoped** | `add_client` / `deactivate_client` have no service beneath them; Sprint 5's backfill hook already assumes a create flow. | STEP 2 |
| **↳ Two new bot copy rows** | `STALE_DATA` and cycle-`VALIDATION_ERROR` have no row in Error-Handling §6; version capture makes the first reachable. | STEP 6 |
| **Search scope = per-category service parity** | Query-time role filtering mirroring each owning service. **team_member tasks are NOT row-filtered** (Auth-Matrix §4: reads all). → **ADR-015** | STEP 1 (record) + STEP 8 |
| **↳ No `search_indexes` table** | Migration 025 creates *indexes*. tasks/comments → `ts_rank` on `search_vector`; clients/staff → trigram ILIKE + `similarity` ordering. | STEP 8 |
| **`update_calendar_cell` routes through `updateCell`** | Same-statement `source='manual'` auto-reset + version bump (ADR-013 case 2). No raw write. | STEP 4 |
| **Bot writes attributed to the human** | `audit_log.staff_id` = JWT caller, `changed_by_source = 'bot'`, never the System Actor. First use of the enum value. → **ADR-016** | STEP 1 (record) + STEP 4 + STEP 7 |
| **Persist-then-emit** | The terminal turn is written to the Redis session **before** the socket emit, so a disconnected client recovers it via `GET /v1/bot/session/current`. Same discipline as `NotificationService` (Sprint 2). | STEP 5 |
| **`activity-feed` is Sprint 9, not deferred** | Impl-Plan §12 scopes it here; Sprint 8's hand-off paragraph omitted it. | STEP 8 + STEP 11 |
| **8.1 denial block re-tuned for 22 tools** | Group denials by capability family, not tool-by-tool — a team_member is now denied ~13 tools. | STEP 6 |

---

## READ FIRST (Open in Antigravity Split View)

`@`-reference these with `@docs/02-TRD.md`.

| Doc | Sections | Why |
|---|---|---|
| `docs/02-TRD.md` | **§9.2 (mutation confirmation protocol)**, §9.1 (the tool loop + system prompt), §9.3 (the 11 mutation tools) | The protocol this sprint implements |
| `docs/04-APPFLOW.md` | **§9 (bot mutation turns, cancel path, permission-denied copy)**, §12 (search flow + result navigation), §3 (activity feed) | Every interaction |
| `docs/07-API-CONTRACT.md` | §Bot (202 + C-01), §Search & Activity Feed, §Staff (`/:id/profile`), §1.1 envelopes, §2 (bot 30/min) | Exact shapes |
| `docs/08-AUTH-MATRIX.md` | **§5 (the 11 mutation rows + the 🔧 defaults)**, §6 (override precedence), §4 (endpoint access per module) | Which role may mutate what |
| `docs/03-UIUX.md` | **§17 (search palette — 600px input, scope pills, 4 groups, max 5 + Show more)**, §12 (bot confirmation turn + inline buttons), §4.3 (chips), §22 (animation) | Every visual rule |
| `docs/05-BACKEND-SCHEMA.md` | `audit_log` (**`changed_by_source` enum + the bot-attribution comment**), §8 (search indexes — what actually exists), `clients`, `content_calendar`/`content_pipelines` `version` | Column truth |
| `docs/09-ERROR-HANDLING.md` | **§6 (bot error communication table)**, §2 (the codes the services throw) | The copy contract |
| `docs/14-PRE-BUILD-AUDIT.md` | **M-05 (search query strategy)**, M-08 (bot tool execution errors) | The two findings this sprint closes |
| `docs/06-IMPLEMENTATION-PLAN.md` | §12 | Sprint 9 checklist |
| `docs/12-TESTING-STRATEGY.md` | §6.2 (the bot-mutation E2E — **extend it**), §7 (CMD+K p95 < 150ms) | The tests you must reproduce |
| `docs/adr/` | **ADR-006, 008, 009, 011, 012, 013**, + **014/015/016** (created STEP 1) | The rulings the tools must not violate |

---

## CONSISTENCY RECONCILIATIONS — LOCK THESE BEFORE YOU PROMPT

The Master Build Guide's Sprint 9 shorthand drifts from the canonical specs in several load-bearing places. The numbered specs + schema + the ADR series win:

1. **There is no `search_indexes` table.** Migration `025_search_indexes.ts` creates **indexes**. What exists: `tasks.search_vector` (GENERATED, GIN — mig 010), `messages.search_vector` (mig 018), `comments.search_vector` (GENERATED, GIN — mig 025), and trigram GIN on `clients.name` + `staff.name` (mig 025). The Master Guide's "the GIN-indexed `search_indexes` table" and an older draft's "migration 022 (FTS prep)" are both wrong (022 is `comments`).
2. **Two of the four search categories cannot use `ts_rank`.** Audit M-05 says "each `ORDER BY ts_rank(search_vector, …)`" — but `clients` and `staff` have **no `search_vector` column**. They rank by `similarity(name, $1)` (pg_trgm). Only `tasks` and `comments` use `ts_rank`.
3. **`messages` is not a `/v1/search` category.** The four are tasks, clients, staff, comments (API-Contract). Chat search is a separate endpoint (`GET /v1/chat/search`) in Sprint 10.
4. **team_member search is NOT row-filtered on tasks.** Auth-Matrix §4: `GET /v1/tasks` → team_member "✅ can read all; edits restricted"; Sprint 4 reconciliation #10 states it explicitly. Filtering search *harder* than the service is as much a parity break as filtering it softer — it just fails safe, so nobody notices. The real isolation surface is **freelancer** (no tasks, no comments beyond their own shoot rows) and **comments** (team_member: own + manager/admin replies on the same record).
5. **`scope` is a no-op for clients and staff.** Neither has a period column. `scope=current` filters tasks and comments only — otherwise "This month" returns zero clients and reads as broken.
6. **Per-category limit: query 20, render 5.** Audit M-05 says `LIMIT 5`; UI/UX §17 says "max 5 per category visible initially, **[Show more]** per category" — with a limit of 5, [Show more] has nothing to reveal. One round trip, both docs satisfied.
7. **The `comments` category will be empty until Sprint 12.** `POST /v1/comments` is Sprint 12 (Impl-Plan §15). Seed rows manually for the test; an empty category is expected, not a defect.
8. **Confirmation is a *server* protocol.** The Master Guide's older draft has the frontend "re-send with a `confirmation_token`" and the backend returning a `confirmation_required: true` `tool_result` shape. Superseded by **ADR-014**: the pending state lives server-side in the Redis session; the client sends `{ decision, confirmationId }`; the server never trusts a client-supplied tool call.
9. **The error code is `DEPENDENCY_UNRESOLVED` (400)**, not `DEPENDENCY_NOT_DONE`/422 (ADR-009, Error-Handling §2/§3). Same correction as Sprint 4 — it recurs because the Master Guide still carries the wrong pair.
10. **`tasks` and `shoot_schedules` are unversioned** (ADR-008, schema) — `update_task_status`, `set_deadline`, `assign_task`, `update_shoot_slot` send **no** version. Only `update_pipeline_stage` and `update_calendar_cell` capture one at turn 1.
11. **Entity resolution is the model's job via query tools.** No fuzzy-id resolver. The system prompt instructs: *to act on a record, first look it up with a query tool to obtain its id.* A hallucinated id fails the turn-1 existence read → friendly "I couldn't find that record" → **no pending state created**.
12. **Frontend path `apps/web/app/(portal)/`** (no `src/`), matching Sprints 3–8. The palette mounts in the `(portal)` **layout**, not per-page (FR-SEARCH-01: from *any* portal page).
13. **`?highlight=<id>` does not exist yet.** APPFLOW §12 specifies "row highlighted gold 2s" on task navigation. Sprint 4 never built it. Sprint 9 adds it to the tasks grid (small — a `useSearchParams` read + a 2s class).
14. **Activity feed is `audit_log`-sourced but never the audit endpoint.** PRD FR-SET-07 / APPFLOW §3 forbid reusing `/v1/audit-log` (admin-only, audit-purpose). They do not forbid the table. A separate role-filtered read path with a humanising renderer is correct; a second event table would be dual-write drift.

---

## AUDIT + ADR ITEMS THIS SPRINT MUST HANDLE

| ID | What | Where |
|---|---|---|
| **ADR-014 (new)** | Two-turn confirmation state machine — deterministic consent, turn-1 version capture, consume-once, 5-min expiry, server-rendered summary, zero model calls on turn 2. | STEP 1 + 3 + 5 |
| **ADR-015 (new)** | Search role scoping = per-category service parity; correct ranking per index type; `scope` no-op for clients/staff. | STEP 1 + 8 |
| **ADR-016 (new)** | Bot writes attributed to the human — `changed_by_source='bot'`, `staff_id` = JWT caller. First use of the enum value. | STEP 1 + 4 + 7 |
| **M-05** | Search query strategy — 4 parallel queries, ranked, role-scoped, combined in the service. | STEP 8 |
| **M-08** | Bot tool execution errors get helpful copy (not "something went wrong"), including the two missing rows. | STEP 6 |
| **TRD §9.2** | Every mutation presents a summary and executes only on explicit affirmative. **Tested per-branch.** | STEP 3 + 5 + 7 |
| **Write-parity (extends Sprint 8)** | Bot mutation == REST mutation for the same user: 403 / 423 / 409 / 400 identical. | STEP 7 |
| **Carried E2E debt** | 4 pre-existing failures from Sprints 1/5 fixed before new specs land. | STEP 1 |

If you skip the test for any of these, Sprint 9 is not done. They reappear in CI when you push.

---

## STEP-BY-STEP STRUCTURE

| # | Type | What |
|---|---|---|
| 1 | Manual | Pre-flight — Sprint 8+8.1 green, **fix the 4 carried E2E failures**, confirm the ClientService gap, re-verify model strings, record ADR-014/015/016, branch |
| 2 | Prompt | `ClientService.create` + `deactivate` (+ wire Sprint 5's backfill hook) |
| 3 | Prompt | **The confirmation state machine** (ADR-014) — schema, pending record, consent gate, summary renderer |
| 4 | Prompt | The 11 mutation tools (reuse mutating services, `isMutation: true`, version capture, bot attribution) |
| 5 | Prompt | `BotService` integration — turn-1 interceptor, turn-2 executor, persist-then-emit |
| 6 | Prompt | Bot copy — two new Error-Handling §6 rows + the 8.1 denial-block re-tune for 22 tools |
| 7 | Prompt | Bot backend tests (confirmation branches, write-parity, attribution, version capture) + suite |
| 8 | Prompt | `SearchService` (ADR-015) + `ActivityFeedService` |
| 9 | Prompt | Search + activity routes + Zod + registration + backend tests |
| 10 | Prompt | Frontend — confirmation card + `[Confirm]`/`[Cancel]` in the bot panel |
| 11 | Prompt | Frontend — CMD+K palette (`cmdk`), scope toggle, result navigation, `?highlight=`, activity feed |
| 12 | Manual + Prompt | Playwright — mutation two-turn (confirm + cancel), palette, role isolation |
| 13 | Manual | End-to-end smoke + commit + close-out |

---

## SPRINT 9 — STEP 1: Pre-flight (manual)

**Goal:** Solid ground — which this sprint means *actually green*, not "green except the four we know about."

### 1.1 — Confirm Sprint 8 + 8.1

```bash
git checkout main && git pull
docker compose up -d && docker compose ps          # both healthy
pnpm install
pnpm --filter @skaly/api db:status                 # 0 pending
pnpm typecheck && pnpm lint && pnpm --filter @skaly/api test
```

Confirm 8.1 actually landed:

```bash
ls apps/api/src/lib/permissions.ts 2>/dev/null && echo "8.1 NOT COMPLETE — stale resolver still present" || echo "8.1 retired ✓"
grep -rn "ROLE_DEFAULTS" apps/api/src | grep -v PermissionService   # expect: no hits
grep -rn "denied" apps/api/src/services/BotService.ts | head        # expect: the { permitted, denied } shape in use
```

### 1.2 — ⚠️ Fix the 4 carried E2E failures (do this BEFORE any new code)

Three shoot-planner, one signup-requests, from Sprints 1/5 — surfaced when the Sprint 7 `.env.e2e` shell-expansion bug was fixed. They have now been carried through two sprints. Sprint 9 adds new specs on top of this suite; adding green specs to a red suite means nobody trusts the red, and by Sprint 13 nobody reads it.

```bash
pnpm exec playwright test --reporter=list          # capture the 4 failures verbatim
```

> **WHERE WE ARE**
>
> Sprint 9, STEP 1.2. Clearing carried debt before new work. The Playwright suite has 4 pre-existing failures from Sprints 1 and 5 — 3 in the shoot-planner spec, 1 in signup-requests. They were masked until Sprint 7 fixed a shell-expansion bug in `.env.e2e` loading, so these specs had never actually run. Here is the failure output: **[paste the 4 failures verbatim]**.
>
> **WHAT TO DO**
>
> For each failure, determine whether it is **(a)** a stale spec written against a shape that has since changed legitimately, or **(b)** a genuine product defect the spec correctly caught. Tell me which, per failure, before fixing anything.
>
> - **(a) stale spec** → update the spec to the as-built contract, and say what changed and in which sprint.
> - **(b) real defect** → fix the product code, keep the spec as-is, and call it out — a spec that has been failing since Sprint 1 or 5 may indicate a shipped bug.
>
> Then re-run the full suite headed once, then headless (chromium + webkit).
>
> **RULES**
>
> - Do not delete, skip, or `.fixme()` a failing spec to get green. If a spec is genuinely obsolete, say so and I'll rule on it.
> - Do not weaken an assertion to make it pass.
>
> Show me your (a)/(b) classification per failure first, then the fixes.

`▶ /ponytail` — before you fix them: four specs failing for two sprints often share one root cause (a helper, a fixture, a login path). Have him look for the single fix rather than four.

**Verify gate:** `pnpm exec playwright test` fully green. **This is a hard gate.** If a failure is a genuine defect that needs its own sprint, say so and we descope it explicitly — but it does not stay silently red.

### 1.3 — Confirm the `ClientService` gap (this scopes STEP 2)

```bash
grep -rn "ClientService" apps/api/src/services | head
grep -rn "POST.*'/clients'\|post('/clients'\|createClient" apps/api/src/routes apps/api/src/services || echo "NO CLIENT CREATE — STEP 2 is scoped work, as expected"
grep -rn "backfillClientSlots" apps/api/src   # Sprint 5's hook — note its call site (or its absence)
```

Sprint 5 STEP 3 wired mid-month backfill into "the Sprint 1 `POST /v1/clients` / reactivate flow." Sprint 1's guide never specifies client creation; Sprint 2 built only `GET /v1/clients`. Expect the create path to be missing and the backfill hook to be either unwired or attached to something improvised. Note exactly what you find — STEP 2's prompt needs it.

### 1.4 — Re-verify the model strings (30 seconds, and they move)

```bash
curl -s https://api.anthropic.com/v1/models \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" | jq '.data[].id'
```

`ANTHROPIC_MODEL_PROD` and `ANTHROPIC_MODEL_DEV` must both appear. If either has moved since Sprint 8, update **both** the env and the spec doc — same rule as Sprint 8 STEP 1.2. A wrong model string is an HTTP 400 the moment a mutation is confirmed, which is the worst possible moment.

### 1.5 — Record ADR-014, ADR-015, ADR-016 (Prompt)

> **WHERE WE ARE**
>
> Sprint 9, STEP 1.5. Recording the three pre-Sprint-9 rulings before any code references them. Read `docs/adr/ADR-013` for the house format, `docs/02-TRD.md` §9.2, `docs/08-AUTH-MATRIX.md` §4–§5, and `docs/05-BACKEND-SCHEMA.md` (`audit_log` — the `changed_by_source` comment).
>
> **WHAT TO BUILD** — three files in `docs/adr/`:
>
> **`ADR-014-bot-mutation-confirmation.md`**
> ```
> # ADR-014 — Two-turn mutation confirmation as a server-side state machine
> Status: Accepted • Pre-Sprint 9 (build impact: Sprint 9)
> Cross-refs: TRD §9.2, APPFLOW §9, Audit C-02, ADR-013
>
> Context: Sprint 9 is the first time a probabilistic system (the model) triggers an
>   irreversible write. TRD §9.2 mandates a two-turn protocol. "Turn 2 affirmative executes"
>   is underspecified in two safety-critical ways: who decides what counts as affirmative,
>   and what the stored call carries.
>
> Decision:
>   1. CONSENT IS NEVER MODEL-CLASSIFIED. The [Confirm]/[Cancel] buttons send a structured
>      { decision, confirmationId }. Typed text is matched against a narrow EXACT-MATCH
>      affirmative allowlist after normalisation. Anything else is not consent.
>      Consequence, and it is the desired one: "yes, but make it Friday" is NOT consent —
>      it clears the pending state and is re-planned as a fresh turn.
>   2. VERSION CAPTURED AT TURN 1. For versioned targets (content_pipelines,
>      content_calendar) the expectedVersion is read when the summary is built and stored.
>      Without this the bot read-then-writes and becomes last-write-wins, silently undoing
>      C-02 for every bot-mediated edit. An interleaving human edit must produce an honest 409.
>   3. ONE PENDING RECORD, consume-once, 5-minute expiry, stored inside the existing
>      bot:session:{staffId} blob (one key, one TTL, atomic with the turn append).
>      A new mutation intent replaces it. Consumed before execution, so a double-click
>      cannot double-fire.
>   4. THE SUMMARY IS SERVER-RENDERED from the validated input plus a current-state read.
>      The user consents to specific values; the model may not paraphrase them.
>   5. TURN 2 MAKES ZERO MODEL CALLS. Execute, then render the outcome (or the friendly
>      error) deterministically. The confirmation of an approved change must not be
>      probabilistic prose, and it saves a full round trip.
>   6. RE-VALIDATE AT TURN 2: re-resolve the permission and re-assert the period lock
>      before executing. Both may have changed between the summary and the "yes".
>
> Rule: the pending confirmation is server state. The client may reference it by id; it may
>   never supply the tool, the arguments, or the version.
> ```
>
> **`ADR-015-search-role-scoping.md`**
> ```
> # ADR-015 — Search role scoping and ranking
> Status: Accepted • Pre-Sprint 9 (build impact: Sprint 9, Sprint 11)
> Cross-refs: Audit M-05, Auth-Matrix §4, ADR-011, 05-BACKEND-SCHEMA §8
>
> Decision:
>   1. QUERY-TIME ROLE FILTERING mirroring each owning service. Never a visibility predicate
>      baked into index rows — that is a second permission implementation, the exact class of
>      bug Sprint 8.1 deleted.
>   2. PARITY MEANS EXACTLY THE SERVICE'S SCOPE — not stricter. team_member tasks are NOT
>      row-filtered: Auth-Matrix §4 grants team_member read on all tasks. Filtering search
>      harder than the service is a parity break that fails safe, so it goes unnoticed.
>      Real isolation surface: freelancer (no tasks; comments only on their own shoot rows)
>      and comments (team_member: own + manager/admin replies on the same record).
>   3. THERE IS NO search_indexes TABLE. Migration 025 creates indexes.
>      tasks + comments  -> ts_rank(search_vector, websearch_to_tsquery($1))
>      clients + staff   -> name ILIKE '%q%' (accelerated by gin_trgm_ops)
>                           ORDER BY similarity(name, $1) DESC
>      Two of four categories have no search_vector column; ranking them with ts_rank does
>      not compile.
>   4. scope=current filters tasks and comments only. clients and staff have no period column;
>      applying the filter there returns zero rows and reads as a broken search.
>   5. LIMIT 20 per category; the palette renders 5 with [Show more]. Audit M-05's LIMIT 5
>      leaves UI/UX §17's [Show more] nothing to reveal.
>
> Rule: search returns exactly what that user could already read, ranked, per category.
>   A search-parity test asserts row-set equality against the owning service.
> ```
>
> **`ADR-016-bot-write-attribution.md`**
> ```
> # ADR-016 — Bot-mediated writes are attributed to the human
> Status: Accepted • Pre-Sprint 9 (build impact: Sprint 9+)
> Cross-refs: 05-BACKEND-SCHEMA §6 (audit_log), Audit C-04, ADR-014
>
> Context: audit_log.changed_by_source has carried three values ('user','system','bot') since
>   migration 023. 'bot' has NEVER been written — Sprint 8's tools are read-only and every
>   automated write so far used 'system' + the System Actor UUID. Sprint 9 is its first use.
>
> Decision: a bot-mediated write sets audit_log.staff_id = the JWT-authenticated caller
>   (the human on whose behalf the bot acted) and changed_by_source = 'bot'.
>   NEVER the System Actor — that is reserved for genuinely unattended writes (rollover,
>   trigger recomputes).
>
> Rule: the audit log must answer "did a person do this, or did they ask the bot to?"
>   That is the entire reason the enum has three values rather than two.
> ```
>
> Show me all three files.

**Verify:**

```bash
ls docs/adr/ADR-01{4,5,6}*.md
git add docs/adr/ && git commit -m "docs(adr): record ADR-014 confirmation machine, ADR-015 search scoping, ADR-016 bot write attribution"
```

### 1.6 — Branch

```bash
git checkout -b sprint-9-bot-mutation-search
```

**Verify gate:** Sprint 8 + 8.1 green, **Playwright fully green**, ClientService gap documented, model strings verified, three ADRs committed, on `sprint-9-bot-mutation-search`. Proceed.

---

## SPRINT 9 — STEP 2: `ClientService.create` + `deactivate`

**Goal:** Close the gap two mutation tools sit on, and finish wiring Sprint 5's backfill hook to a call site that actually exists.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 9, STEP 2. Building the client create/deactivate path that `add_client` and `deactivate_client` (STEP 4) depend on. My STEP 1.3 audit found: **[paste what you found — whether `POST /v1/clients` exists, and where `backfillClientSlots` is called from, if anywhere]**.
>
> Read `docs/05-BACKEND-SCHEMA.md` (`clients` — `shoot_slots_per_month` has **no DEFAULT**, `pieces_per_visit`, `is_internal`, `active`, `deleted_at`), `docs/09-ERROR-HANDLING.md` §2 (`CLIENT_SHOOT_SLOTS_REQUIRED`), `docs/08-AUTH-MATRIX.md` §3 (`/settings/clients` — admin ✅, manager ✅), and `apps/api/src/services/period-rows.ts` (the Sprint 3/5/7 generators).
>
> **WHAT TO BUILD** — extend `apps/api/src/services/ClientService.ts`:
>
> 1. **`create(input, currentUser, db)`** — **admin + manager** (Auth-Matrix §3: `/settings/clients` is ✅ for both). `input = { name, shootSlotsPerMonth, piecesPerVisit?, isInternal?, whatsappNumber? }`. One transaction:
>    a. `shootSlotsPerMonth` is **required** — absent → `400 CLIENT_SHOOT_SLOTS_REQUIRED` (the column has no DEFAULT by design; this is the canonical guard). Validate `1..20` to match `adjustSlotCount`'s range.
>    b. Insert the `clients` row (`active: true`).
>    c. **If active and NOT internal**, call all three current-period backfills inside the same transaction — `ShootPlannerService.backfillClientSlots` (Sprint 5), `generatePipelineRowForClient` + `generateCalendarCellsForClient` (Sprint 7 STEP 4) — for `getCurrentPeriod().period`. This is the call site Sprint 5's hook was written for.
>    d. `AuditService.log({ entity: 'clients', action: 'INSERT', … })`.
>    e. Return the full client.
>
> 2. **`deactivate(id, currentUser, db)`** — **admin only** (mirrors staff deactivation; Auth-Matrix §5 gives `deactivate_client` to admin only). One transaction:
>    a. Load the client (404 if missing or already soft-deleted).
>    b. `softDelete('clients', id, currentUser.staffId, trx)` from `apps/api/src/lib/queries.ts` — sets `deleted_at`; also set `active = false`. **(Corrected: it is not on `BaseService`. `lib/queries.ts` owns both `softDelete` and the `softDeletable` SELECT filter.)**
>    c. **Do not touch historical rows.** Past `shoot_schedules` / `content_pipelines` / `content_calendar` / `tasks` stay exactly as they are — the client disappears from *future* generation and from `softDeletable` reads, and history remains intact and auditable. Add a comment saying so.
>    d. `AuditService.log({ entity: 'clients', action: 'DELETE', … })`.
>    e. Return `{ deactivated: true }`.
>
> 3. **Routes** in the existing clients route file (do **not** create a second one — Sprint 5 added `PATCH /:id/shoot-slots`, Sprint 6 added `PATCH /:id`):
>    - `POST /v1/clients` — `requireRole('admin','manager')`; body `ClientCreateSchema`; 201 full client.
>    - `DELETE /v1/clients/:id` — `requireRole('admin')`; → `{ deactivated: true }`.
>
> 4. **Zod** in `packages/shared/src/schemas/clients.ts`: `ClientCreateSchema` (`{ name: string.min(1).max(255), shootSlotsPerMonth: int().min(1).max(20), piecesPerVisit: int().min(1).default(1), isInternal: boolean().default(false), whatsappNumber: string().optional() }`). Keep it `.strict()`.
>
> 5. **Tests** `apps/api/test/services/ClientService.test.ts`:
>    - create without `shootSlotsPerMonth` → `400 CLIENT_SHOOT_SLOTS_REQUIRED`.
>    - create (active, non-internal) generates shoot slots **and** a pipeline row **and** calendar cells for the current period — the same assertion Sprint 7 STEP 4 made, now reached through the real create path.
>    - create with `isInternal: true` generates **none** of the three.
>    - deactivate soft-deletes, sets `active=false`, and leaves existing shoot/pipeline/calendar rows untouched.
>    - `GET /v1/clients` excludes a deactivated client; team_member `POST` → 403; manager `DELETE` → 403.
>
> **RULES**
>
> - One clients route file. One `ClientService`. If Sprint 5/6 left client logic scattered, consolidate it here rather than adding a third location.
> - The three backfills run inside the create transaction — a client that exists without its period rows is invisible to Trigger 2 (that is exactly Sprint 7's "missing cell → no-op" path).
> - `is_internal` clients never get operational rows.
>
> Show me `create` (with the three backfills) and `deactivate`, then the routes.

`▶ /ponytail` — the three backfill calls plus their guards will read as a block of ceremony. Ask him whether it wants to be one `backfillClientPeriodRows(clientId, period, trx)` used by both create and Sprint 7's mid-month path.

**Verify:**

```bash
pnpm --filter @skaly/api test services/ClientService
pnpm --filter @skaly/api test services/period-rows    # Sprint 7's backfill tests still green
pnpm typecheck
```

---

## SPRINT 9 — STEP 3: The confirmation state machine (ADR-014)

**Goal:** The safety-critical core. Build it standalone and fully tested **before** any mutation tool can reach it.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 9, STEP 3. Building the two-turn confirmation state machine. Read `docs/adr/ADR-014` (the ruling — follow it exactly), `docs/02-TRD.md` §9.2, `docs/04-APPFLOW.md` §9 (the turn-1 / turn-2 / cancel flows), and `apps/api/src/services/BotService.ts` (the Sprint 8 session handling).
>
> **HARD CONSTRAINTS (ADR-014) — each of these is the difference between a gate and a suggestion:**
> - **Consent is never model-classified.** No LLM call decides whether the user said yes.
> - **The pending record carries `expectedVersion`** for versioned targets, captured at turn 1.
> - **One pending record**, consume-once, 5-minute expiry, inside the existing session blob.
> - **The summary is server-rendered** from validated input + a current-state read.
>
> **WHAT TO BUILD**
>
> 1. **Extend the request schema** — `packages/shared/src/schemas/bot.ts`:
>    ```ts
>    export const BotMessageSchema = z.object({
>      content: z.string().min(1).max(2000),
>      confirmationId: z.string().uuid().optional(),
>      decision: z.enum(['confirm', 'cancel']).optional(),
>    }).strict();
>    ```
>    When `decision` is present, `content` is the display string archived to the transcript (e.g. "Yes, go ahead") and `decision` is what the gate reads. Never infer the gate from `content` when `decision` is present.
>
> 2. **`apps/api/src/lib/bot/confirmation.ts`** — the machine, as plain functions (no state-chart library):
>
>    ```ts
>    export interface PendingConfirmation {
>      confirmationId: string;      // uuid
>      toolName: string;
>      input: Record<string, unknown>;   // Zod-validated at turn 1
>      expectedVersion?: number;         // versioned targets only
>      summary: ConfirmationSummary;     // structured, server-rendered
>      expiresAt: string;                // ISO — turn 1 + 5 minutes
>    }
>
>    export interface ConfirmationSummary {
>      action: string;        // "Mark task as Done"
>      entity: string;        // "Task"
>      target: string;        // "Edit the Naaz Furniture reel"
>      period?: string;
>      changes: Array<{ field: string; from: string | null; to: string }>;
>    }
>    ```
>
>    - **`isAffirmative(raw: string): boolean`** — normalise (`trim`, `toLowerCase`, strip trailing `.!` ), then **exact match** against:
>      `['yes','y','yeah','yep','confirm','confirmed','go ahead','do it','proceed','ok','okay']`
>      Exact match only. `"yes, but make it Friday"` must return `false` — that is intended behaviour, not a limitation: it clears the pending state and gets re-planned as a fresh turn.
>    - **`isExpired(pending, now): boolean`** — compare against `expiresAt`.
>    - **`resolveTurn2(session, body)`** → a discriminated union:
>      `{ kind: 'execute', pending }` · `{ kind: 'cancelled' }` · `{ kind: 'expired' }` · `{ kind: 'stale_id' }` · `{ kind: 'none' }` (no pending, or non-affirmative → treat as a fresh turn).
>      Precedence: if `decision` is present it wins outright and `confirmationId` **must** match the pending record (mismatch → `stale_id`). Otherwise, a pending record + `isAffirmative(content)` → `execute`. Otherwise → `none`.
>
> 3. **Session helpers** in `BotService` (or alongside the existing session code — do not open a second Redis key):
>    - `setPending(staffId, pending)` — writes `pendingConfirmation` into the session JSON, refreshes the 12h TTL.
>    - `consumePending(staffId)` — reads **and clears** it atomically, returning the record. Clearing before execution is what makes a double-click safe.
>    - `clearPending(staffId)` — used by cancel, non-affirmative, expiry, and replacement.
>
> 4. **`buildSummary(toolName, input, currentState)`** — a **table**, not a switch-with-eleven-arms: a per-tool descriptor mapping `{ label, entityName, fields }` so each tool contributes ~4 lines. `from` comes from the current-state read; `to` from the validated input. Dates render as `dd MMM yyyy` (date-fns, IST). Nulls render as "—".
>
> 5. **Tests** `apps/api/test/lib/confirmation.test.ts`:
>    - `isAffirmative`: every allowlist entry true (with/without trailing punctuation, mixed case); `"yes, but make it Friday"`, `"no"`, `"maybe"`, `"sure why not"`, `""` all **false**.
>    - `resolveTurn2`: structured confirm → `execute`; structured cancel → `cancelled`; mismatched `confirmationId` → `stale_id`; expired pending + affirmative → `expired`; no pending + "yes" → `none`; pending + unrelated message → `none`.
>    - `consumePending` returns the record and leaves the session with `pendingConfirmation: null`; a second call returns null.
>    - `setPending` twice → only the second survives (single-pending rule).
>
> **RULES**
>
> - This file contains **no** Anthropic calls and **no** service calls. It is pure state logic and must be unit-testable with no I/O beyond the session store.
> - `expiresAt` is checked on read, not by a Redis TTL — the pending state must expire faster (5 min) than the session it lives in (12 h).
> - Never trust `input`, `toolName`, or `expectedVersion` from the client. The client may send only `confirmationId` + `decision`.
>
> Show me `confirmation.ts` in full, then the tests.

`▶ /ponytail` — this is his highest-value target in the sprint. Point him at `resolveTurn2` and `buildSummary`. The first will want to be a nest of ifs (it should be a flat precedence chain); the second will want to be a switch (it should be a table).

**Verify:**

```bash
pnpm --filter @skaly/api test lib/confirmation
pnpm typecheck
```

---

## SPRINT 9 — STEP 4: The 11 mutation tools

**Goal:** Eleven thin wrappers. If any of them contains business logic, it is wrong.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 9, STEP 4. Building the 11 mutation tools. Read `docs/02-TRD.md` §9.3 (the list), `docs/08-AUTH-MATRIX.md` §5 (per-role defaults — note the 🔧 rows), `docs/adr/ADR-014` (version capture), `docs/adr/ADR-016` (attribution), and the Sprint 8 query-tool descriptor shape in `apps/api/src/lib/bot/tools/queries/`.
>
> **HARD CONSTRAINTS:**
> - Each tool **calls the existing mutating service method** with the JWT-authenticated `currentUser`. No raw queries. No re-implemented validation. Every 403 / 423 / 409 / 400 the REST layer produces must pass through unchanged.
> - **No staffId in any tool's input schema** (impersonation prevention — same rule as Sprint 8).
> - `isMutation: true` on all eleven.
> - **Attribution (ADR-016):** these writes audit as `staff_id` = caller, `changed_by_source = 'bot'`. Confirm `AuditService.log` accepts `actorSource` and thread `'bot'` through the tool → service call path. This is the first time the `'bot'` enum value is ever written.
>
> **WHAT TO BUILD** — `apps/api/src/lib/bot/tools/mutations/`, one file each, same descriptor shape as the query tools plus two new members:
>
> ```ts
> {
>   name, description, inputSchema, isMutation: true,
>   // NEW: read current state for the summary + capture the version
>   readCurrent(input, currentUser, db): Promise<{ state: object; version?: number }>,
>   handler(input, currentUser, db, expectedVersion?): Promise<{ result: object; link: string }>,
> }
> ```
>
> | Tool | Service method | Version captured? | Notes |
> |---|---|---|---|
> | `update_task_status` | `TaskService.update(id, { status }, user)` | no (ADR-008) | dependency block + ownership pass through |
> | `create_task` | `TaskService.create` | no | admin/manager; fans out `task_assigned` per assignee (ADR-006) |
> | `assign_task` | `TaskService.assign` | no | notifies only newly-added, non-actor assignees |
> | `set_deadline` | `TaskService.update(id, { deadline }, user)` | no | |
> | `update_pipeline_stage` | `ContentDropperService.updateStage(id, stage, user, expectedVersion)` | **yes** | sequence violation → 400 |
> | `update_shoot_slot` | `ShootPlannerService.update` | no (last-write-wins) | transition validation passes through |
> | `update_calendar_cell` | `ContentCalendarService.updateCell(id, patch, user, expectedVersion)` | **yes** | auto-reset to `source='manual'` + version bump (ADR-013 case 2) |
> | `add_holiday` | `HolidayService.create` | no | flips working→holiday + broadcasts |
> | `remove_holiday` | `HolidayService.remove` | no | **inherits the H-01 cascade** — reverts attendance rows in the same transaction |
> | `add_client` | `ClientService.create` (STEP 2) | no | requires `shootSlotsPerMonth` |
> | `deactivate_client` | `ClientService.deactivate` (STEP 2) | no | admin only |
>
> - **`readCurrent`** loads the target for the summary and returns its `version` where the table has one. A missing target throws `RESOURCE_NOT_FOUND` **here**, at turn 1 — so a hallucinated id fails before any pending state is created.
> - **`link`** is the deep link for the outcome message, following APPFLOW §12's convention: `/tasks?period={p}&highlight={id}`, `/content-calendar?period={p}`, `/shoot-planner?period={p}`, `/content-dropper?period={p}`, `/settings/clients`.
> - Input schemas carry **only** the fields the service needs. `update_task_status` takes `{ taskId, status }` — not an assignee, not a period, not a staffId.
>
> **RULES**
>
> - Eleven files that look nearly identical is the **correct** outcome. Resist per-tool cleverness.
> - No tool may catch a service error and reshape it — errors propagate to STEP 6's single mapping layer.
> - `remove_holiday` must not shortcut `HolidayService.remove`; the attendance revert is the whole point of H-01.
>
> Show me the descriptor type, then `update_task_status` and `update_calendar_cell` (the two shapes — unversioned and versioned), then the remaining nine.

`▶ /ponytail` — eleven near-identical files is exactly the shape he exists to compress. Ask whether the descriptor + a small per-tool config table replaces most of them. Take his answer even if it collapses the folder to two files.

**Verify:**

```bash
pnpm --filter @skaly/api test lib/bot/tools    # smoke: each tool's readCurrent + handler shape
pnpm typecheck
```

---

## SPRINT 9 — STEP 5: `BotService` integration — turn 1 interceptor, turn 2 executor

**Goal:** Wire the machine into the Sprint 8 loop.

> ### ⚠️ SUPERSEDED IN PART BY ADR-018 — "without changing that loop's shape" was wrong
>
> This step originally said to preserve the Sprint 8 loop shape, and §B.7 below still
> refers to "the existing **second stream**". That instruction assumed the two-phase
> loop was sound. **It was not.** It could only service one round of tools, while
> §D's "look the id up first" instruction *guarantees* the mutation lands in round 2 —
> so mutations were unreachable, and the unserviced `tool_use` was persisted with no
> `tool_result`, which 400s the API on the user's next message and poisons the session
> for its whole 12h TTL.
>
> **Read `docs/decisions/ADR-018-bot-tool-loop.md` before implementing this step.** The
> loop is a bounded multi-round `while`-loop (cap 4) that graceful-finalises on the cap,
> and `stripDanglingToolUse` runs on both the persist and the read path, in both
> directions. Everything else in this step stands verbatim: **the turn-1 interceptor
> below is unchanged and lives inside the new loop** — only the control flow around it
> changed. Turn 2 still makes zero model calls and never enters the loop.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 9, STEP 5. Wiring the confirmation machine into `BotService.handleMessage`. Read `docs/adr/ADR-014`, `apps/api/src/lib/bot/confirmation.ts` (STEP 3), `docs/04-APPFLOW.md` §9, and the existing `handleMessage` tool loop.
>
> **WHAT TO BUILD**
>
> **A. Turn-2 check runs FIRST, before anything else.** At the top of `handleMessage`, call `resolveTurn2(session, body)`:
>
> - **`execute`** → `consumePending` → **re-resolve the tool's permission** and **re-assert the period lock** (both may have changed since the summary) → call `tool.handler(input, currentUser, db, expectedVersion)` → render the outcome → **return. No model call at all on this path.**
>   - Success copy is server-rendered: `"Done — {summary.action}: {summary.target}."` plus the deep link, delivered as a terminal `bot:message` with `card: { type: 'mutation_result', summary, link }`.
>   - Failure → STEP 6's mapping layer produces the friendly copy; still zero model calls.
> - **`cancelled`** → `clearPending` → terminal `bot:message` with APPFLOW §9's copy: `"Okay, no changes made."` No model call.
> - **`expired`** → `clearPending` → `"That confirmation timed out — want me to set it up again?"`
> - **`stale_id`** → `"I've already handled that one. What would you like to do?"`
> - **`none`** → `clearPending` (a pending record does not survive an unrelated message) → fall through to the normal Sprint 8 flow.
>
> **B. Turn-1 interceptor, inside the existing tool loop.** Where Sprint 8 executes a `tool_use` block, branch on `isMutation`:
>
> 1. Validate the input with the tool's Zod schema. Invalid → normal tool error path, **no pending state**.
> 2. Assert the tool is in `permitted` (defence in depth — it was already filtered).
> 3. `readCurrent(input, currentUser, db)` → the current state **and the version**. `RESOURCE_NOT_FOUND` here → friendly "I couldn't find that record", **no pending state**.
> 4. `buildSummary(...)` → the structured summary.
> 5. `setPending(staffId, { confirmationId: randomUUID(), toolName, input, expectedVersion, summary, expiresAt: now + 5min })`.
> 6. **Feed back a synthetic `tool_result`** for that `tool_use_id` — **this is mandatory**: the Anthropic API rejects any request where a `tool_use` block has no matching `tool_result` in the following turn.
>    ```
>    AWAITING_USER_CONFIRMATION. A summary has been presented to the user for approval.
>    Do not call this tool again. Ask the user to confirm, briefly.
>    ```
> 7. Let the existing **second stream** run — the model produces the conversational confirmation question. This is why the loop shape is unchanged.
> 8. The terminal `bot:message` carries `card: { type: 'confirmation', confirmationId, toolName, summary }`.
>
> **C. Persist-then-emit.** Append the terminal turn to the Redis session **before** emitting it over the socket — the same DB-write-then-emit discipline `NotificationService` established in Sprint 2. A client that was disconnected recovers the turn via `GET /v1/bot/session/current`. Apply this to every terminal `bot:message`, not just confirmations.
>
> **D. System prompt addition** (extend the Sprint 8 `buildSystemPrompt`): one line, after the anti-hallucination directive —
> ```
> To act on a record, first look it up with a query tool to obtain its id. Never guess an id.
> ```
>
> **RULES**
>
> - Turn 2 never calls Anthropic. Not for the success message, not for the error message.
> - The turn-1 interceptor must not execute the tool. If you find yourself calling `handler` before consent, stop.
> - The synthetic `tool_result` is not optional — omitting it produces a 400 on the very next message, which will look like an unrelated bug.
> - Query tools are untouched by all of this (`isMutation: false` → the Sprint 8 path).
>
> Show me the turn-2 branch at the top of `handleMessage`, then the turn-1 interceptor inside the loop.

`▶ /ponytail` — the turn-2 branch is a five-way switch that will sprawl. And check that turn 1 and turn 2 do not each have their own copy of the "render a bot:message and persist it" logic; that wants to be one function.

**Verify:**

```bash
pnpm --filter @skaly/api test services/BotService    # smoke with mocked Anthropic
pnpm typecheck
```

---

## SPRINT 9 — STEP 6: Bot copy — the two missing rows + the denial re-tune

**Goal:** Every error a mutation can produce has deterministic friendly copy, and the 8.1 denial block survives the tool registry doubling.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 9, STEP 6. Bot copy. Read `docs/09-ERROR-HANDLING.md` §6 (the table), `docs/14-PRE-BUILD-AUDIT.md` M-08, and `apps/api/src/services/BotService.ts` (the 8.1 `TOOL ACCESS` prompt section).
>
> **WHAT TO BUILD**
>
> 1. **A single error→copy mapping table** (not a switch scattered across call sites) — `apps/api/src/lib/bot/error-copy.ts`. Populate it from Error-Handling §6, and **add the two rows that are missing**:
>
>    | Code | Copy |
>    |---|---|
>    | `PERIOD_LOCKED` | "I can't update that record — {Month} is locked. Ask an admin to unlock it if a correction is needed." |
>    | `PERMISSION_DENIED` / `BOT_TOOL_DENIED` | "I don't have permission to {action} on your behalf. Ask an admin to update your bot access settings." |
>    | `DEPENDENCY_UNRESOLVED` | "I can't mark that task as Done — it depends on '{dependency name}' which isn't finished yet." |
>    | `STAGE_SEQUENCE_VIOLATION` | "I can't mark that stage as complete — the previous stage hasn't been done yet." |
>    | **`STALE_DATA`** *(new)* | "That record changed while I was waiting for your confirmation — {name} updated it. Want me to take another look and try again?" |
>    | **`VALIDATION_ERROR` (cycle)** *(new)* | "I can't set that dependency — it would create a loop between those tasks." |
>    | `RESOURCE_NOT_FOUND` | "I couldn't find that record. Could you tell me which one you mean?" |
>    | `ANTHROPIC_ERROR` | "I'm having trouble connecting right now. Please try again in a moment." |
>    | *unmapped* | "Something went wrong. Please try again or make the change directly in the portal." |
>
>    `STALE_DATA` is newly reachable because ADR-014 captures the version at turn 1 — that is the intended behaviour, and the copy must offer recovery rather than dead-ending. **No code, no version number, no role name** appears in any string.
>
> 2. **Re-tune the 8.1 `TOOL ACCESS` denial block for 22 tools.** 8.1 budgeted ~120 tokens for ~10 denied query tools; a team_member is now denied roughly 13 of 22. Listing them one by one bloats the prompt and makes the model pattern-match too eagerly (8.1's own troubleshooting predicts exactly this).
>
>    **Group denials by capability family.** Add a `family` field to each tool descriptor and render one phrase per family that has any denied member:
>    - `tasks.write` → "creating, assigning, or scheduling tasks"
>    - `holidays.write` → "adding or removing holidays"
>    - `pipeline.write` → "editing the content pipeline"
>    - `shoots.write` → "editing the shoot schedule"
>    - `calendar.write` → "editing the content calendar"
>    - `clients.write` → "adding or deactivating clients"
>    - `pipeline.read` → "viewing the content pipeline"
>    - `clients.read` → "viewing client summaries"
>    - `audit.read` → "viewing the audit log"
>
>    A team_member's 13 denied tools collapse to ~6 phrases. Keep 8.1's verbatim refusal sentence, the never-state-the-role constraint, and the out-of-scope paragraph **exactly as they are** — only the enumeration changes.
>
> 3. **Tests** (extend `BotService.test.ts`):
>    - Every code in the table maps to its copy; an unmapped code falls to the generic line.
>    - No copy string contains a role name, an error code, or the word "version".
>    - `buildSystemPrompt` for a team_member emits **family phrases**, not raw tool names, and stays under the token budget (assert the section's character length).
>    - An admin (nothing denied) still gets **no** `TOOL ACCESS` section (8.1's rule, unchanged).
>
> **RULES**
>
> - One table, one lookup. If a second `switch (error.code)` appears anywhere in the bot path, it is a bug.
> - Do not paraphrase the canonical sentences — they are verbatim from Error-Handling §6 / APPFLOW §9.
>
> Show me `error-copy.ts` and the re-tuned denial section.

`▶ /ponytail` — the mapping table and the family renderer. Both will want to be inline string concatenation; both should be data.

**Verify:**

```bash
pnpm --filter @skaly/api test services/BotService
pnpm typecheck
```

---

## SPRINT 9 — STEP 7: Bot backend tests + full suite

**Goal:** Every branch of the machine, plus the write-parity and attribution guards.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 9, STEP 7. The full bot test suite. Read `docs/12-TESTING-STRATEGY.md`, `docs/adr/ADR-014`, `docs/adr/ADR-016`. Real local Postgres, `NODE_ENV=test`. Mock the Anthropic client with canned `tool_use` responses — never hit the live API in unit tests.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/test/services/BotConfirmation.test.ts` — the machine, end to end:**
>    - **Turn 1 creates pending and writes nothing.** Mocked stream returns an `update_task_status` `tool_use` → assert a `pendingConfirmation` exists with the right `toolName`/`input`, the terminal `bot:message` carries a `confirmation` card, **and the task's status in the DB is unchanged.**
>    - **Turn 2 structured confirm executes** → the task is updated; `pendingConfirmation` is null; **zero Anthropic calls** on that request (assert the mock was not called).
>    - **Turn 2 typed "yes" executes.**
>    - **`"yes, but make it Friday"` does NOT execute** → pending cleared, the message re-planned as a fresh turn. *(The headline safety test.)*
>    - **Cancel** → nothing written, `"Okay, no changes made."`
>    - **Expiry** → advance the clock past 5 minutes → affirmative → not executed, timeout copy, pending cleared.
>    - **Double confirm** → the second request finds no pending → "already handled", and the write happened **exactly once**.
>    - **Replacement** → two mutation intents in a row → only the second pending survives.
>    - **Unrelated message clears pending.**
>    - **`confirmationId` mismatch** → `stale_id`, nothing executed.
>    - **Re-validation at turn 2:** revoke the tool permission between turn 1 and turn 2 → confirm → **denied**, nothing written. Lock the period between turns → confirm → 423 copy, nothing written.
>    - **Hallucinated id:** a `tool_use` with a non-existent taskId → friendly not-found, **no pending created**.
>
> 2. **Version capture (ADR-014 §2) — `update_calendar_cell`:**
>    - Turn 1 on a cell at `version: 3` → pending carries `expectedVersion: 3`.
>    - A human PATCHes the same cell (now `version: 4`) → turn 2 confirm → **409 `STALE_DATA`**, surfaced as the friendly copy, cell **not** overwritten. *(Without turn-1 capture this test passes silently and wrongly.)*
>    - No interleaving edit → confirm succeeds, `version` → 4, `source` → `'manual'` (ADR-013 case 2 + the auto-reset).
>
> 3. **⭐ Write-parity (extends Sprint 8's read parity):** for each of the 11 tools, the bot path and the REST path produce the **same** outcome for the same user:
>    - team_member `update_task_status` on an **unassigned** task → **403** both ways.
>    - team_member `update_task_status` on their own assigned task → succeeds both ways.
>    - team_member `set_deadline` (a non-status field on their own task) → **403** both ways.
>    - Any tool on a **locked** period → **423** both ways.
>    - `update_task_status` → Done with an unresolved dependency → **400 `DEPENDENCY_UNRESOLVED`** with the same `details.dependencyTask`.
>    - `update_pipeline_stage` out of order → **400 `STAGE_SEQUENCE_VIOLATION`**.
>    - `remove_holiday` → the holiday soft-removes **and** the attendance rows revert to `working` (H-01 cascade inherited).
>    - `create_task` with 3 assignees → exactly **3** `task_assigned` rows (ADR-006 inherited).
>
> 4. **Attribution (ADR-016):** after any bot mutation, the `audit_log` row has `staff_id` = the **human caller** and `changed_by_source = 'bot'` — **not** the System Actor, **not** `'user'`. Assert on at least three different tools. *(First-ever use of this enum value.)*
>
> 4b. **The loop and the id contract (ADR-018 / ADR-019)** — these are the regression locks for the two blockers that only surfaced when the real UI was driven:
>    - **Multi-round tool use:** a message needing lookup-then-act drives **≥2** tool rounds and terminates on `end_turn` with **no dangling `tool_use` persisted**.
>    - **Session recovery:** seed a Redis session with a dangling `tool_use` *and* an orphan `tool_result` (a simulated pre-fix poisoned session) → the next message succeeds and neither block reaches the API. *(This is the test that would have caught the loop bug.)*
>    - **Cap:** a mock that calls a tool every round hits the 4-round cap and finalises with the streamed text + friendly copy — **no throw**, no extra closing stream.
>    - **Interceptor-in-loop:** a mutation `tool_use` inside the loop yields the synthetic `AWAITING_USER_CONFIRMATION` result, the next round emits the confirmation question, pending is set, nothing executed.
>    - **ID contract (ADR-019):** for each of the 11 mutation tools, assert it is either a create or has a named `{ idField, queryTool }` pair, and that the paired query tool's serialised output contains the id — driven across `list_tasks`/`list_overdue_tasks` → task id, `get_content_pipeline` → pipeline id, `get_shoot_schedule` → slot id, `get_content_calendar` → cell id, `get_holiday_list` → holiday id, `get_client_summary` → client id.
>
> 5. **Route tests** (`apps/api/test/routes/bot.test.ts` additions): `POST /v1/bot/message` with `{ decision, confirmationId }` still returns **202** (C-01 unchanged); a `decision` without a `confirmationId` → `400 VALIDATION_ERROR`; the schema is `.strict()` so an unknown field is rejected.
>
> 6. Run the **whole** API suite + typecheck + lint.
>
> **RULES**
>
> - Every test must fail without its fix. The `"yes, but make it Friday"` test and the version-capture test are the two that justify the sprint's design; if either passes on a naive implementation, it isn't asserting the right thing.
> - Assert **absence** of writes, not just presence — "turn 1 wrote nothing" is the core claim.
>
> Show me the `"yes, but…"` test and the version-capture test first, then run the suite.

**Verify:**

```bash
pnpm --filter @skaly/api test        # full API suite green
pnpm typecheck && pnpm lint
git add -A && git commit -m "Sprint 9 bot: mutation tools + two-turn confirmation machine (ADR-014) + bot attribution (ADR-016) + ClientService"
```

---

## SPRINT 9 — STEP 8: `SearchService` + `ActivityFeedService` (ADR-015)

**Goal:** Four ranked, role-scoped queries — and the home-page feed that Sprint 8's hand-off nearly lost.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 9, STEP 8. Building search + the activity feed. Read `docs/adr/ADR-015` (follow it exactly), `docs/14-PRE-BUILD-AUDIT.md` M-05, `docs/07-API-CONTRACT.md` (Search & Activity Feed), `docs/05-BACKEND-SCHEMA.md` §8 (**what indexes actually exist**), `docs/08-AUTH-MATRIX.md` §4, and `docs/04-APPFLOW.md` §3 + §12.
>
> **HARD CONSTRAINTS (ADR-015):**
> - **There is no `search_indexes` table.** Migration 025 creates indexes.
> - **tasks + comments** → `ts_rank(search_vector, websearch_to_tsquery('english', $1))`. **clients + staff** have **no `search_vector`** → `name ILIKE '%' || $1 || '%'` (accelerated by `gin_trgm_ops`) `ORDER BY similarity(name, $1) DESC`.
> - **Parity, not stricter.** team_member tasks are **not** row-filtered.
> - **`scope` is a no-op for clients and staff.**
> - `LIMIT 20` per category.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/src/services/SearchService.ts`** — `search(q, scope, currentUser, db)`, four queries run in parallel (`Promise.all`), each with its own role predicate:
>
>    | Category | Filter | Role scope | Rank |
>    |---|---|---|---|
>    | tasks | `search_vector @@ websearch_to_tsquery(…)`, `softDeletable` | admin/manager/team_member → **all**; freelancer → **skip the query entirely** | `ts_rank` |
>    | comments | `search_vector @@ …` | admin/manager → all; team_member → own + manager/admin comments on the same `record_id`; freelancer → own only | `ts_rank` |
>    | clients | `name ILIKE`, `softDeletable`, active only | mirror `ClientService.list` exactly | `similarity(name, $1)` |
>    | staff | `name ILIKE`, `softDeletable`, active only | all roles, **limited fields** (`GET /v1/staff` shape: id, name, role, avatarUrl) | `similarity(name, $1)` |
>
>    - `scope = 'current'` → add `period = getCurrentPeriod().period` to **tasks and comments only**.
>    - Return `{ tasks: [], clients: [], staff: [], comments: [] }` per API-Contract, each item carrying what the palette renders: tasks → `{ id, description, period, status, clientName }`; comments → `{ id, content, module, recordContext, period }`; clients → `{ id, name }`; staff → `{ id, name, role, avatarUrl }`.
>    - **Empty query guard:** `q` shorter than 2 characters returns four empty arrays without touching the DB.
>    - `websearch_to_tsquery` over `plainto_tsquery` (M-05's default): it never throws on user input, and it supports quoted phrases and `-exclusion` — which is what a search box gets typed into.
>
> 2. **`apps/api/src/services/ActivityFeedService.ts`** — `getFeed(period, limit, currentUser, db)`:
>    - Source: **`audit_log`**, on its own read path. PRD FR-SET-07 / APPFLOW §3 forbid reusing the admin-only `/v1/audit-log` **endpoint**; they do not forbid the table, and a second event table would be dual-write drift.
>    - Role filter: admin/manager → all rows; team_member → rows where `staff_id = self`; freelancer → rows where `staff_id = self`.
>    - Exclude `changed_by_source = 'system'` rows below a whitelist (rollover/month events are interesting; a trigger recompute is not).
>    - **Humanise via a bounded template table**, keyed `(table_name, action)` → a renderer producing `{ actor, text, link, at }`. Example: `('tasks','UPDATE')` with `new_value.status` → *"{actor} marked '{description}' as {status}"*. **Unmapped pairs are skipped, not rendered raw** — that keeps the table from rotting into a hundred-arm switch.
>    - `limit` default 10, max 50. Newest first.
>
> 3. **Tests:**
>    - `SearchService`: a team_member's tasks result equals `TaskService.getTasks` for that user (**parity**); a freelancer gets **no** tasks; a team_member sees another user's comment only when it is an admin/manager reply on a record they commented on; `scope=current` does not empty the clients/staff arrays; `q = 'a'` returns empties with no query; ranking puts an exact name match above a partial one.
>    - `ActivityFeedService`: a team_member sees only their own events; an admin sees all; an unmapped `(table, action)` pair is skipped; the limit caps at 50.
>
> **RULES**
>
> - Four independent queries. Do not union them into one clever statement — different tables, different ranking functions, different role predicates.
> - Never `SELECT *` on `staff`. The limited-field shape is a security boundary.
> - The feed's template table is a whitelist. Unmapped means skipped.
>
> Show me the four search queries (with their role predicates), then the feed's template table.

`▶ /ponytail` — four queries with near-identical shape around different predicates, plus a template table. Ask him where the repetition genuinely is and where it only looks like it (the two ranking strategies are *not* the same thing and should not be merged).

**Verify:**

```bash
pnpm --filter @skaly/api test services/SearchService services/ActivityFeedService
pnpm typecheck
```

---

## SPRINT 9 — STEP 9: Search + activity routes + registration + tests

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 9, STEP 9. Routes for search + activity feed. Read `docs/07-API-CONTRACT.md` (Search & Activity Feed) and `docs/08-AUTH-MATRIX.md` §4.
>
> **WHAT TO BUILD**
>
> 1. **Zod** `packages/shared/src/schemas/search.ts`:
>    - `SearchQuerySchema`: `{ q: z.string().min(1).max(100), scope: z.enum(['current','all_time']).default('current') }`
>    - `ActivityFeedQuerySchema`: `{ period: z.string().regex(/^\d{4}-\d{2}$/).optional(), limit: z.coerce.number().int().min(1).max(50).default(10) }`
>
> 2. **Routes** (register per TRD §5.1, after the bot routes):
>    - `GET /v1/search?q=&scope=` — **all authenticated roles** (the service scopes per category). → `SearchService.search`.
>    - `GET /v1/activity-feed?period=&limit=` — **all authenticated roles** (role-filtered inside). → `ActivityFeedService.getFeed`.
>
> 3. Confirm rate-limit headers (M-06). Search inherits the global 150/min IP limit — no dedicated bucket (it is a read, and the 200ms client debounce is the real throttle).
>
> 4. **Route tests:** every role gets 200 on both; a freelancer's `/v1/search` response has an **empty `tasks` array**; a team_member's `/v1/activity-feed` contains only their own events; `q` absent → 400; `limit=999` → 400; envelopes per §1.1.
>
> **RULES:** the route does not filter — the service does (same division as shoot-planner's freelancer isolation). Envelopes per API-Contract §1.1.
>
> Show me the routes, then confirm Swagger lists both.

**Verify:**

```bash
pnpm --filter @skaly/api dev   # /docs lists /v1/search + /v1/activity-feed
pnpm --filter @skaly/api test  # full API suite green
pnpm typecheck && pnpm lint
git add -A && git commit -m "Sprint 9: search + activity feed (ADR-015, M-05)"
```

---

## SPRINT 9 — STEP 10: Frontend — the confirmation card

**Goal:** The inline `[Confirm]` / `[Cancel]` turn, bound to a `confirmationId`.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 9, STEP 10. The confirmation UI in the bot panel. Read `docs/04-APPFLOW.md` §9 (turn 1 / turn 2 / cancel), `docs/03-UIUX.md` §12 (bot confirmation turn + inline buttons) and §4.3 (chips), and the Sprint 8 card registry in `apps/web/components/modules/bot/cards/`.
>
> **WHAT TO BUILD**
>
> 1. **`ConfirmationCard`** — a new entry in the Sprint 8 card registry for `type: 'confirmation'`:
>    - Renders the **server-supplied** summary: action headline, entity + target, and a `from → to` list per changed field (DM Mono for values, muted for `from`, `--text-primary` for `to`). Period shown when present.
>    - Inline **`[Confirm]`** (gold CTA) and **`[Cancel]`** (ghost) buttons.
>    - **Never re-derive the summary client-side.** Render exactly what arrived — the user is consenting to the server's description of the change.
>
> 2. **Button actions:**
>    - Confirm → `POST /v1/bot/message { content: 'Yes, go ahead', confirmationId, decision: 'confirm' }`
>    - Cancel → `POST /v1/bot/message { content: 'Cancel', confirmationId, decision: 'cancel' }`
>    - Both **disable immediately on click** and stay disabled — the server consumes the pending record once, so a second click is a no-op, but the UI shouldn't invite it.
>    - Once a confirmation card has been acted on (or a newer message has arrived), render its buttons disabled with the resolved state ("Confirmed" / "Cancelled").
>
> 3. **`MutationResultCard`** — `type: 'mutation_result'`: a green check, the outcome line, and a gold **deep link** to the affected record (`link` from the payload). Clicking navigates within the portal.
>
> 4. **Typed confirmation still works.** A user may ignore the buttons and type "yes" — that goes through the normal input path with no `decision` field, and the server's allowlist handles it. Do **not** intercept typed text client-side.
>
> 5. **Frontend tests:** the confirmation card renders every `changes` row; Confirm posts the structured body with the right `confirmationId`; both buttons disable on click; an unknown card type still falls back to text (Sprint 8's rule); the result card renders the deep link.
>
> **RULES**
>
> - The card is display + dispatch only. No client-side validation of the change, no re-computation of `from`/`to`.
> - Buttons bind to `confirmationId` — never to a tool name or arguments. The client must not be able to name what executes.
>
> Show me `ConfirmationCard`, then the registry wiring.

`▶ /ponytail` — the disabled/resolved button states will sprawl into a small state machine in the component. Ask whether it derives from the message list instead of local state.

**Verify:**

```bash
pnpm --filter @skaly/web test
```

Manual: ask the bot to change a task status → the confirmation card renders with `from → to` → `[Cancel]` → "Okay, no changes made." Repeat → `[Confirm]` → result card + working deep link.

---

## SPRINT 9 — STEP 11: Frontend — CMD+K palette + activity feed

**Goal:** Search available from every portal page, plus the home feed.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 9, STEP 11. The search palette and the activity feed. Read `docs/03-UIUX.md` §17 (palette — 600px input, scope pills, 4 groups, max 5 + [Show more]) and §5 (home activity feed), `docs/04-APPFLOW.md` §12 (navigation per result type) and §3, and `docs/13-NFRS.md` §1.4 (CMD+K input lag < 16ms).
>
> **WHAT TO BUILD**
>
> 1. **Install the palette primitive:**
>    ```bash
>    cd apps/web && npx shadcn@latest add command
>    ```
>    (shadcn's `command` wraps `cmdk`; it will pull the dependency.)
>
> 2. **`apps/web/components/shared/SearchPalette.tsx`**, mounted in the **`(portal)` layout** so it is available from every page (FR-SEARCH-01) — not per-page.
>    - **⚠️ Set `shouldFilter={false}` on the `<Command>` root.** `cmdk` fuzzy-filters its children client-side by default, which would silently drop server results that don't match its own heuristic. This is the single most common bug when wiring cmdk to a server search.
>    - Global hotkey: a `keydown` listener for `(e.metaKey || e.ctrlKey) && e.key === 'k'` → `e.preventDefault()` → toggle open. Register once in the layout, clean up on unmount.
>    - `CommandDialog` → `CommandInput` (placeholder "Search tasks, clients, staff…") → scope pills **[This month] [All time]** below the input → `CommandList` with four `CommandGroup`s.
>    - **200ms debounce** (FR-SEARCH-02) on the input before the query fires. `useQuery({ queryKey: ['search', debouncedQ, scope], enabled: debouncedQ.length >= 2 })`.
>    - Render **5 items per group** with a **[Show more]** row revealing the rest of the 20 already in hand — **no second request**.
>    - Empty states: pre-typing → recent/hint text; no results → `CommandEmpty` "No matches."
>    - Keyboard: ↑↓ / Enter / Esc come free from cmdk. Escape closes.
>
> 3. **Result navigation** (APPFLOW §12 / Impl-Plan §12), each closing the palette first:
>    - **Task** → `/tasks?period={period}&highlight={id}`
>    - **Client** → `/content-dropper?period={currentPeriod}`
>    - **Staff**, admin/manager → `/settings/staff/{id}`; team_member/freelancer → open the **public profile modal** (`GET /v1/staff/:id/profile`, built Sprint 2) — no navigation
>    - **Comment** → the module page for `comment.module` + `// TODO(Sprint 12): open the comment box for recordId` (the comment UI is Sprint 12)
>
> 4. **`?highlight=` support in the tasks grid** (APPFLOW §12: "row highlighted gold 2s") — this does not exist yet. In `apps/web/app/(portal)/tasks/page.tsx`: read `highlight` via `useSearchParams`, scroll that row into view once data resolves, apply a gold flash class for 2s, then strip the param with `router.replace` so a refresh doesn't re-flash.
>
> 5. **Activity feed on `/home`** (UI/UX §5 — right column, 30%): `useQuery(['activity-feed', period])` → `GET /v1/activity-feed?period=&limit=10` → last 10 rendered as actor + text + **DM Mono timestamp**, each linking to its `link`. Empty state: "Nothing yet this month."
>
> 6. **Frontend tests:** the hotkey opens the dialog and `preventDefault` fires; the query does not fire below 2 characters; the debounce issues **one** request per burst; `shouldFilter={false}` is set (assert server results render even when they don't match cmdk's heuristic); the scope toggle re-keys the query; a staff result routes by role; [Show more] reveals items **without** a new request.
>
> **RULES**
>
> - `shouldFilter={false}`. Everything else about the palette is negotiable; this is not.
> - The palette lives in the layout. Mounting it per-page breaks FR-SEARCH-01 and duplicates the hotkey listener.
> - Input lag < 16ms (NFR §1.4) — the debounce must not sit between the keystroke and the rendered character.
>
> Show me the palette component (hotkey + debounce + `shouldFilter`), then the navigation switch.

`▶ /ponytail` — the four `CommandGroup` blocks will be copy-paste with a different label and mapper. And the navigation switch wants to be a per-type config, not a chain of ifs.

**Verify:**

```bash
pnpm --filter @skaly/web test
pnpm dev
# CMD+K from /attendance, /tasks, /bot — opens everywhere. Type 3+ chars → 4 groups populate.
# Toggle [All time] → results re-query. Enter on a task → navigates + the row flashes gold for 2s.
# As a team_member: staff result opens the modal, not /settings/staff.
```

---

## SPRINT 9 — STEP 12: Playwright — mutation two-turn, palette, isolation

### 12.1 — Test logins (manual)

Reuse the Sprint 3–8 `.env.test` admin + team_member + freelancer. Ensure the team_member is an **assignee** of at least one task (for the own-assigned success path) and **not** an assignee of another (for the 403 path).

### 12.2 — Prompt

> **WHERE WE ARE**
>
> Sprint 9, STEP 12. E2E. Read `docs/12-TESTING-STRATEGY.md` §6 — note §6.2 already contains a bot-mutation test that asserts only the *first* half ("task NOT created yet"). **Extend it to the full two-turn cycle** rather than writing a parallel spec. Reuse the Sprint 3–8 `loginAs` + `playwright.config.ts`.
>
> **WHAT TO BUILD** — extend `tests/e2e/bot.spec.ts` and add `tests/e2e/search.spec.ts`:
>
> **bot.spec.ts**
> 1. **Two-turn confirm (manager):** `/bot` → "Create a task for {teamMember} to edit the Naaz reel, due Friday" → assert the confirmation card renders with the summary → navigate to `/tasks` → **the task does not exist** (this is Testing-Strategy §6.2's existing assertion) → back to `/bot` → `[Confirm]` → result card + deep link → `/tasks` → **the task now exists** with the right assignee.
> 2. **Cancel path:** same opener → `[Cancel]` → "Okay, no changes made." → the task does not exist.
> 3. **Typed affirmative:** same opener → type "yes" → executes.
> 4. **Typed non-affirmative:** same opener → type "yes, but make it Monday" → assert **no task was created** and the bot re-plans (a new confirmation card appears, or it asks a clarifying question). *(The safety test — assert absence of the write.)*
> 5. **Denial (team_member):** as the team_member, "create a task for Sohail" → assert the friendly refusal, **no confirmation card**, and that the reply names no role: `expect(text).not.toMatch(/\b(admin|manager|team.member|freelancer)\s+(role|permission|access|level)/i)` (the 8.1 assertion, carried forward).
> 6. **Locked period:** lock the prior month → ask the bot to change something in it → confirm → the 423 friendly copy, nothing written.
>
> **search.spec.ts**
> 1. **Palette (admin):** CMD+K from `/attendance` → type a known client name → the Clients group shows it → Enter → navigates to `/content-dropper`.
> 2. **Scope toggle:** search a task from the prior period → [This month] shows nothing → [All time] shows it with its period label.
> 3. **Task navigation + highlight:** Enter on a task result → lands on `/tasks?period=…&highlight=…` → the row carries the gold flash class.
> 4. **Role isolation (freelancer):** CMD+K → search a term that matches a task → the **Tasks group is empty**; a direct `page.request.get('/v1/search?q=…')` with the freelancer token returns `data.tasks` as `[]`.
> 5. **Staff navigation by role:** admin → `/settings/staff/{id}`; team_member → the public profile modal opens and the URL does **not** change.
>
> 6. Run headed once, then headless (chromium + webkit).
>
> **RULES:** independent, re-runnable; delete created tasks and clear the bot session in teardown. Do not assert exact model prose — assert cards, DB effects, and absence of writes.
>
> Show me the two-turn spec and the non-affirmative spec first, then run them.

**Verify:**

```bash
pnpm exec playwright test tests/e2e/bot.spec.ts tests/e2e/search.spec.ts   # green, chromium + webkit
pnpm exec playwright test                                                  # ENTIRE suite green (incl. STEP 1.2's fixes)
```

---

## SPRINT 9 — STEP 13: End-to-end smoke + commit + close-out (manual)

### 13.1 — Full manual walk-through

```bash
docker compose up -d && pnpm dev
```

1. **Mutation happy path (admin):** ask the bot to mark a task Done → summary card with `from → to` → `[Confirm]` → result card + deep link → the task is Done. `SELECT staff_id, changed_by_source FROM audit_log WHERE table_name='tasks' ORDER BY created_at DESC LIMIT 1;` → **your** staffId, `changed_by_source = 'bot'`. *(First ever `'bot'` row.)*
2. **Cancel:** same opener → `[Cancel]` → nothing written.
3. **The safety case:** ask again → type **"yes, but make it Friday"** → assert **nothing was written** and the bot re-plans.
4. **Expiry:** trigger a summary, wait 5+ minutes, type "yes" → timeout copy, nothing written.
5. **Double-click:** trigger a summary → click `[Confirm]` twice rapidly → **one** write. `SELECT count(*) FROM audit_log WHERE record_id='<id>' AND created_at > now() - interval '1 minute';` → 1.
6. **Version capture:** ask the bot to change a calendar cell → while the summary sits unconfirmed, edit that cell in another tab → `[Confirm]` → the friendly `STALE_DATA` copy, cell not overwritten. *(This is the C-02 guard working.)*
7. **Write-parity by hand:** as a **team_member**, ask the bot to change the status of a task they're **not** assigned to → refusal; on their **own** assigned task → succeeds. Ask to change a **description** on their own task → refusal. All three match REST exactly.
8. **Locked period:** lock the prior month → any bot mutation targeting it → the 423 copy.
9. **H-01 inheritance:** ask the bot to remove a holiday → confirm → `SELECT day_type, count(*) FROM attendance_logs WHERE period='<p>' AND date='<d>' GROUP BY day_type;` → back to `working`.
10. **Client tools:** `add_client` (with slots) → confirm → the client exists **and** has shoot slots + a pipeline row + calendar cells for the current period. `deactivate_client` as manager → refusal (admin only); as admin → confirm → gone from grids, history intact.
11. **Search:** CMD+K from three different pages. Scope toggle. Task → highlight flash. Staff as team_member → modal. Freelancer → empty Tasks group.
12. **Activity feed:** `/home` right column shows the last 10 events; as a team_member, only their own.
13. **Anthropic down:** bad `ANTHROPIC_API_KEY` → turn 1 gives the friendly connection copy. **Then** re-key and confirm a *pending* confirmation from before still executes on turn 2 — because turn 2 makes no model call. *(Proves ADR-014 §5.)*

`▶ /ponytail` — full-sprint review before the close-out checklist.

### 13.2 — Close-out checklist

Do not start Sprint 10 until **every** box is checked.

**Status as of the STEP 13 run.** A box is ticked only where a green test proves it —
API suite 490/490, web suite 102/102, typecheck + lint clean, and the whole Playwright
suite green on **both** engines (chromium 65/0/2, webkit 63/0/4). Everything still
unticked needs the 13.1 manual walk-through (expiry, double-click, the manual
version-capture race, H-01 through the bot, the client tools, and the Anthropic-down
case), which is a human at a keyboard by design.

**A webkit-only E2E failure that turned out to be Sprint 7 grid debt.** The tasks
dependency-block spec failed on webkit and passed on chromium, which reads as engine
flakiness. It was not: `shakeIds` and `saveStates` were in the `edit` memo's deps, so a
refused status change rebuilt the column definitions — twice, 400ms apart, as the shake
set and cleared — and TanStack Table remounted every cell. `StatusCell` keeps its `open`
flag in the cell, so a user retrying inside that window had the dropdown close under
their finger. Chromium's clicks simply beat the timer. This is the same defect Sprint 7
fixed for `activeColumnId`, left half-done; both now live in `useTaskSaveStore`,
subscribed to per cell (2/2 fail → 3/3 pass, then the full suite green).

**A flaky assertion that turned out to be a real prompt defect.** Sprint 8.1's E2E
denial test asserts the live model uses the instructed "ask an admin" sentence, and it
was failing about half the time — the model improvising "I don't have access to
attendance records through the portal tools available to me" instead. That is not the
model ignoring an instruction, it is the model obeying a *different* one: the base
prompt's "if you have no tool for it, say so plainly" is more general and comes first,
so it wins. Naming the exception where that instruction is given (rather than adding
emphasis to the TOOL ACCESS block further down) fixed it: 4/4 since, where it was ~50%
before. The assertion was not weakened.

```
CARRIED DEBT + PRE-SPRINT DECISIONS
  [ ] The 4 pre-existing Playwright failures FIXED (classified (a)/(b), no skips, no weakened assertions)
  [ ] ENTIRE Playwright suite green
  [ ] Model strings re-verified against GET /v1/models
  [ ] ADR-014 / ADR-015 / ADR-016 committed (+ ADR-017 onboarding atomicity, ADR-018 tool
      loop, ADR-019 id contract — the last two written mid-sprint from the codebase)

CLIENT SERVICE (the gap)
  [x] ClientService.create — admin+manager; shootSlotsPerMonth required (CLIENT_SHOOT_SLOTS_REQUIRED)
  [x] create runs all three current-period backfills in the same transaction (slots + pipeline + calendar)
  [x] internal clients get none of the three (TESTED)
  [x] ClientService.deactivate — admin only; soft delete; history untouched (TESTED)
  [x] POST /v1/clients + DELETE /v1/clients/:id registered; one clients route file

CONFIRMATION MACHINE (ADR-014)
  [x] BotMessageSchema extended with { confirmationId?, decision? }, .strict()
  [x] Consent NEVER model-classified — structured decision, or exact-match allowlist
  [x] "yes, but make it Friday" does NOT execute (TESTED — unit AND E2E, both engines)
  [x] expectedVersion captured at TURN 1 for content_pipelines + content_calendar (TESTED)
  [x] Interleaved human edit → 409 STALE_DATA with friendly copy, no overwrite (TESTED)
  [x] One pending record; consume-once (double confirm → ONE write, TESTED)
  [x] 5-minute expiry checked on read (TESTED)
  [x] Unrelated message clears pending; new intent replaces pending (TESTED)
  [x] confirmationId mismatch → stale_id, nothing executed (TESTED)
  [x] Summary SERVER-rendered from validated input + current-state read
  [x] Turn 2 makes ZERO Anthropic calls (TESTED — assert the mock was not called)
  [x] Re-validate permission + period lock at turn 2 (TESTED both; the lock also E2E)
  [x] Hallucinated id → not-found, NO pending created (TESTED)
  [x] Synthetic tool_result returned for the turn-1 tool_use (no API 400 on the next message)
  [x] Persist-then-emit: terminal turn written to the session before the socket emit

THE TOOL LOOP (ADR-018) + THE ID CONTRACT (ADR-019)
  [ ] Bot loop is a bounded multi-round loop, cap 4 (ADR-018)
  [ ] stripDangling runs on the READ path as well as persist, BOTH directions; poisoned
      sessions self-heal (TESTED)
  [ ] Cap-hit + mid-stream failure finalise gracefully with partial text + friendly copy,
      never throw, never restart the stream (TESTED)
  [ ] Turn-1 interceptor retained INSIDE the loop; turn 2 makes zero model calls and skips
      the loop entirely (TESTED)
  [ ] Every query tool serialises record ids (ADR-019); id-contract test green for all 11
      mutation tools
  [ ] The hand-built query tools audited for id omission (list_tasks, list_overdue_tasks,
      get_content_pipeline, get_content_calendar, get_shoot_schedule, get_holiday_list,
      get_client_summary)

MUTATION TOOLS
  [x] 11 tools, each calling its existing mutating service method with the JWT currentUser
  [x] No staffId in any tool input schema; isMutation: true on all 11
  [x] ⭐ Write-parity green: 403 / 423 / 409 / 400 identical to REST, per role, per tool
  [x] remove_holiday inherits the H-01 attendance revert (TESTED)
  [x] create_task fans out N notifications for N assignees (ADR-006 inherited, TESTED)
  [x] update_calendar_cell routes through updateCell → source='manual' + version bump (ADR-013 case 2)
  [x] ⭐ Attribution (ADR-016): audit rows carry staff_id = human, changed_by_source = 'bot' (TESTED, 3+ tools)

BOT COPY
  [x] Single error→copy table; no second switch on error.code anywhere in the bot path
  [x] STALE_DATA + cycle-VALIDATION_ERROR rows added (newly reachable)
  [x] No copy string contains a code, a version number, or a role name (TESTED)
  [x] 8.1 denial block re-tuned to capability FAMILIES; verbatim sentence + constraints unchanged
  [x] Admin (nothing denied) still gets NO TOOL ACCESS section

SEARCH + ACTIVITY (ADR-015)
  [x] 4 parallel queries; no search_indexes table referenced anywhere
  [x] tasks + comments → ts_rank(websearch_to_tsquery); clients + staff → ILIKE + similarity
  [x] team_member tasks NOT row-filtered (parity, TESTED); freelancer tasks empty (TESTED — unit AND E2E)
  [x] comments visibility: own + manager/admin replies on the same record (TESTED)
  [x] scope is a no-op for clients + staff (TESTED)
  [x] LIMIT 20 per category; palette renders 5 + [Show more] with NO second request (TESTED)
  [x] q < 2 chars → empties, no DB hit (TESTED both sides)
  [x] Activity feed: audit_log-sourced, role-filtered, whitelist templates, unmapped skipped (TESTED)
  [x] GET /v1/search + /v1/activity-feed in Swagger; rate-limit headers (M-06)

FRONTEND
  [x] ConfirmationCard renders the server summary verbatim; buttons bind to confirmationId only
  [x] Buttons disable on click; resolved state rendered afterwards
  [x] MutationResultCard with a working deep link (E2E follows it to the row)
  [x] Typed "yes" still works (no client-side interception) — E2E, both engines
  [x] Palette mounted in the (portal) layout; CMD+K works from every page
  [x] ⚠️ shouldFilter={false} on the Command root (TESTED — the query matches no result text)
  [x] 200ms debounce → one request per burst (TESTED); input lag < 16ms (debounce is off the render path)
  [x] Scope pills re-key the query; 4 groups; [Show more]
  [x] Result navigation per role (staff → page vs modal); ?highlight= gold flash then param stripped
  [x] Activity feed on /home, role-filtered, DM Mono timestamps

TESTS
  [x] Confirmation, mutation-tool, write-parity, attribution, search, feed suites green (489/489)
  [x] Frontend tests green (102/102)
  [x] Playwright: two-turn confirm + cancel + typed-yes + "yes but" + denial + palette + isolation
  [x] Every new test fails without its fix
  [x] pnpm typecheck + pnpm lint clean
  [x] /ponytail run at each build step (between implementation and tests) — no outstanding review flags

REMAINING — the 13.1 manual walk-through (a human at a keyboard, by design)
  [ ] Expiry: leave a summary 5+ minutes, then type "yes" → timeout copy, nothing written
  [ ] Double-click [Confirm] rapidly → exactly ONE audit row
  [ ] Version capture by hand: edit the calendar cell in another tab mid-summary → STALE_DATA copy
  [ ] H-01 through the bot: remove_holiday → attendance rows back to 'working'
  [ ] Client tools through the bot: add_client generates the three period row-sets; manager DELETE refused
  [ ] Activity feed as a team_member: only their own events
  [ ] Anthropic down: bad key → friendly copy on turn 1; re-key → a PENDING confirmation still
      executes on turn 2 (proves ADR-014 §5 — turn 2 makes no model call)
  [x] ENTIRE Playwright suite green on BOTH engines, in one run each:
        chromium — 65 passed, 0 failed, 2 skipped
        webkit   — 63 passed, 0 failed, 4 skipped
      67 tests either side. chromium's 2 skips are the NFR perf tests (E2E_PERF-gated);
      webkit skips those plus the 2 login cases marked browserName !== 'chromium'
      BY DESIGN, because they mutate shared staff state and must run once.
      Getting here needed a real fix — see the Sprint 7 grid debt note below.
```

### 13.3 — Final commit

```bash
git add -A
git commit -m "Sprint 9: AI Bot mutation tools behind the two-turn confirmation machine (ADR-014), bot write attribution (ADR-016), CMD+K search + activity feed (ADR-015), ClientService create/deactivate; carried E2E debt cleared"
git push -u origin sprint-9-bot-mutation-search
```

Open the PR to `main`; CI must be fully green before merge. Merge, then `git checkout main && git pull`.

### 13.4 — Move to Sprint 10

Open `MASTER-BUILD-GUIDE-V2-FINAL.md` → PART 9 → **SPRINT 10 — CHAT + NOTIFICATIONS**.

Sprint 10 attaches the **remaining** socket consumers to the `lib/socket.ts` client Sprint 8 built: all grid live-update subscriptions (every `// TODO(Sprint 10)` marker left in Sprints 3–7), the bell/notification UI + `notify:new`, and common chat (infinite scroll, threads, @mentions, typing indicators, presence). It is additive by design — ADR-010's amendment made sure of that.

**Read the first two decisions below before starting — both are canonical-document conflicts, not preferences.**

---

## DECISIONS TO MAKE BEFORE SPRINT 10

- **⚠️ Notification types: 18 or 14?** The schema's `notifications_type_check` enum has **18** values and TRD §10.1 lists the same 18. But PRD FR-NOTIF-02 says "All **14** event types" and Impl-Plan §13's Sprint 10 checklist says "all **14** types tested". Two canonical docs against two. **Source-of-truth precedence says the schema wins → 18**, and the PRD/Impl-Plan numbers are stale. Lock this before Sprint 10 writes a coverage test against the wrong number, and patch PRD §4.9 + Impl-Plan §13 in the same commit.

- **⚠️ Bot conversation ownership is unrecoverable from the archive.** TRD §9.4 claims a "persistent archive: `messages` table, `channel='bot'`" — but `messages.sender_id` is **NULL for bot rows** by canonical design (the schema comment says so), and there is no `recipient_id`, no owner column, and no session reference. Every bot reply to every user is `channel='bot', sender_id=NULL` — indistinguishable. Once the 12-hour Redis TTL expires you cannot reconstruct whose conversation it was, which makes NFR §5.2's 12-month retention meaningless. Meanwhile **`bot_sessions` (migration 020 — `id`, `staff_id`, `created_at`, `last_activity_at`, plus a DELETE grant in §11) is never written by any sprint** — it is the missing ownership link, sitting unused. *Recommendation: set `messages.parent_id` on each bot reply to the user's message id (zero migration — `parent_id` already exists and FKs `messages(id)`, and a bot reply genuinely is a reply), which gives ownership by join and turn-pairing for free; and write the `bot_sessions` row so the table stops being dead weight.* Decide before Sprint 10, because Sprint 10 starts sharing `messages` with common chat and the fix gets harder once there are two writers.

- **Grid subscription fan-out vs. refetch storms.** Sprint 10 attaches `attendance:holiday_added/removed`, `shoot:slot_updated`, `content-dropper:updated`, `content-calendar:updated`, `client:name_updated`, and `chat:*` to `org:all`. With 50 users on the calendar, one cell edit broadcasts to 50 clients, each invalidating `['content-calendar', period]` → 50 refetches for one change. Decide the mitigation now: patch the cache from the event payload where the payload is sufficient (it carries `clientId`, `period`, `date`), and reserve `invalidateQueries` for events whose payload can't reconstruct the change. Otherwise Sprint 13's k6 run finds it.

- **Presence at 50 users.** `GET /chat` load does `KEYS presence:*` (TRD §8). `KEYS` is O(N) and blocks Redis. At 50 keys it is harmless; it is still the wrong primitive and Upstash bills per command. Decide whether to switch to a single `presence` hash (`HSET` + `HGETALL`) or keep `KEYS` with a note. Cheap either way — decide before it is load-bearing.

- **Still deferred, on schedule:** comment system (Sprint 12), attachment orphan cron + `coming_shoot_date` rollover recompute (Sprint 12), recovery-code redeem path (carried from Sprint 8 STEP 8.4), permission-changed push event (8.1 STEP 3.4).

---

## TROUBLESHOOTING — SPRINT 9 SPECIFIC

### The next message after a confirmation summary returns HTTP 400 from Anthropic
The turn-1 interceptor didn't return a synthetic `tool_result` for the `tool_use` block it intercepted. Every `tool_use` **must** have a matching `tool_result` in the following turn. Add the `AWAITING_USER_CONFIRMATION` result (STEP 5, B.6). This failure looks unrelated to confirmations, which is why it wastes an afternoon.

**Or the loop persisted a dangling block** (ADR-018) — the same 400, from the other direction. Symptom: the session 400s on *every* message from then on, surfacing as "I'm having trouble connecting" until a new conversation is started. Check that the loop answers every `tool_use` on every round, and that `stripDanglingToolUse` runs on the **read** path in **both** directions — an orphan `tool_result` is rejected just as hard as a dangling `tool_use`, and without the read-path pass an already-poisoned session stays broken for its whole 12h TTL.

### The bot executes on "yes, but change the date"
`isAffirmative` is doing substring or fuzzy matching. It must be **exact match after normalisation**. That phrase returning `false` is the design, not a gap — it clears the pending state and gets re-planned.

### A mutation applied even though the user cancelled
`consumePending` is being called after `handler` instead of before, or the cancel branch falls through to the normal flow. Consume first, then execute; cancel returns immediately.

### Double-clicking [Confirm] wrote twice
`consumePending` isn't atomic with the read, or the buttons don't disable. Clear the pending record **before** calling the service. The UI disable is convenience; the server consume-once is the guarantee.

### `update_calendar_cell` never returns STALE_DATA even with a concurrent edit
The version is being read at turn 2 instead of captured at turn 1 — so the bot always writes with a fresh version and can never conflict. That is exactly the silent C-02 regression ADR-014 §2 exists to prevent. The pending record must carry `expectedVersion` from the summary read.

### `audit_log` shows `changed_by_source='user'` for bot writes
`actorSource` isn't being threaded from the tool through the service to `AuditService.log`. ADR-016: `staff_id` = the human, `changed_by_source = 'bot'`. Not `'system'` either — that's for unattended writes only.

### The bot refuses things it should answer, after Sprint 9
The denial list grew from ~10 to ~13 tools and the enumeration is now over-broad — 8.1's troubleshooting predicted this. Group by capability **family** (STEP 6.2) rather than listing tools, and confirm `permitted + denied` equals exactly the 22-tool registry.

### CMD+K shows fewer results than the API returned
`shouldFilter={false}` is missing on the `<Command>` root. cmdk is re-filtering server results with its own fuzzy heuristic and dropping the ones it doesn't like. This is the single most common cmdk-with-server-search bug.

### Search returns nothing for a two-letter query
Correct — the `q.length >= 2` guard short-circuits. If you want single-character search, note that `similarity()` will fall below the default `pg_trgm.similarity_threshold` (0.3) for most single characters, so ILIKE would match but the ranking would be meaningless.

### `ts_rank` fails on clients or staff
Those tables have **no `search_vector` column** (ADR-015 §3). They rank by `similarity(name, $1)` with an ILIKE filter accelerated by `gin_trgm_ops`. Only `tasks` and `comments` have tsvector columns.

### "This month" returns zero clients
The `scope` filter is being applied to clients/staff, which have no period column. `scope` filters tasks and comments only (ADR-015 §4).

### The comments category is always empty
Expected until Sprint 12 — `POST /v1/comments` doesn't exist yet. Seed rows directly for the test.

### The activity feed renders raw JSON or a wall of trigger noise
The template table isn't a whitelist. Unmapped `(table_name, action)` pairs are **skipped**, not rendered; and `changed_by_source='system'` rows are excluded except for the whitelisted month/rollover events.

### The task row doesn't flash gold after a search result
`?highlight=` handling wasn't added (it never existed — Sprint 4 didn't build it). Read it with `useSearchParams` **after** the query resolves, flash for 2s, then `router.replace` to strip the param so a refresh doesn't re-flash.

---

## END OF SPRINT 9 DETAILED GUIDE

*Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9, `SPRINT-1..8-DETAILED.md`, and `SPRINT-8_1-PATCH-DETAILED.md`. Source-of-truth precedence when documents differ: the numbered spec docs (`01`–`14`) + the schema win, then this guide's reconciliations and the ADRs it executes (006–016), then the Master Build Guide's shorthand. This is the sprint where a probabilistic system first triggers an irreversible write — the confirmation machine is the boundary, and it is server-side, deterministic, and consume-once by design. Sprint 10 (Chat + Notifications) attaches the remaining socket consumers to the client Sprint 8 built; read the first two decisions above before starting, as both are canonical-document conflicts rather than preferences.*
