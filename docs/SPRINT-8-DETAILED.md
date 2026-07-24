# SPRINT 8 — AI BOT (QUERY TOOLS): DETAILED PROMPT-BY-PROMPT GUIDE

## Scaly Business Portal • Sprint 8 of 13

**Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1..7-DETAILED.md`**
**Same Goal / Prompt / Verify framework as Sprints 0–7**
**Tooling interfaces verified as of January 2026** — `@anthropic-ai/sdk` (`messages.stream` + tool use), Next.js 15 (App Router), socket.io-client v4, TanStack Query v5, Zustand 5, shadcn/ui on Tailwind 4, Supabase JS v2 (`auth.mfa.*`), Playwright latest, Lucide React.

> **Scope note:** this is the heaviest sprint in the plan — it lands the bot **and** three things deferred to it: `resolvePermission` (since Sprint 3), the frontend socket client (pulled forward from Sprint 10 per the pre-Sprint-8 decision), and MFA enrollment (the Sprint-1 `501` gap, now a launch blocker). Hence 10 steps. Budget accordingly; the bot tool loop (STEP 3) and the virtualization-free-but-stateful streaming UI (STEP 7) are the deep work.

---

## USING THE `/ponytail` PLUGIN IN THIS SPRINT

This guide invokes **`/ponytail`** at each step's **Verify gate** — after the build passes its checks, before you proceed or commit — as a per-step review/checkpoint pass. Look for the `▶ /ponytail` line inside each **Verify** block.

> **Placement is still an assumption** (same as Sprints 6–7). If `/ponytail` does something else in your setup, tell me its function and I'll re-place it precisely.

---

## WHAT YOU'RE BUILDING IN SPRINT 8

Every grid module and both cross-module triggers are done. Sprint 8 adds the AI Management Bot's read side — and closes three deferred threads. By the end of this week:

- **The pre-Sprint-8 decisions are executed and recorded** (ADR-010 amended): the **minimal socket client** (`/ws/notify` connection + C-05 handshake + `bot:token`/`bot:message` subscriptions) is built; `resolvePermission` lands with **DB read-through** precedence; tools **reuse isolating service methods**; the model strings are **verified against the live API** first.
- **`BotService`** orchestrates the full loop: load Redis session → build the system prompt (IST date + period + role + anti-hallucination) → filter the 11 query tools by `resolvePermission` → stream from Anthropic → dispatch tool calls to **existing service methods with the JWT-authenticated caller** → second streamed call for the answer → archive to `messages`.
- **The 11 query tools** work, each a thin wrapper that calls its isolating service method (so team_member/freelancer scoping and ADR-011 come for free) and shapes a card payload.
- **`resolvePermission`** is real: `perms:{staffId}` (Redis, 5-min TTL) → **DB `user_permissions` read-through on miss** → `ROLE_DEFAULTS` safe floor; the admin override endpoint busts the cache.
- **The C-01 contract** holds: `POST /v1/bot/message` returns **202** with only `{ messageId, sessionId }`; the reply streams over Socket.io — **`bot:token`** deltas + a terminal **`bot:message`** with content + card. `GET`/`DELETE /v1/bot/session/current` per API-Contract §11.
- **The frontend socket client** exists (minimal): the `/ws/notify` connection, the C-05 refresh handshake, and the `bot:token`/`bot:message` subscriptions feeding the bot chat panel — **token-by-token streaming render + an 11-card registry**.
- **MFA enrollment works end-to-end** (parallel track): `/mfa-setup` drives Supabase's client-side `auth.mfa.enroll` + `challengeAndVerify`; the backend flips `staff.mfa_enrolled=true`. **Admin/manager first-login is no longer blocked** — the Sprint-1 `501 MFA_ENROLL_UNAVAILABLE` is resolved.
- **Tests** prove it: C-01 (202, no content in the HTTP body), session shape, the permission filter, **the bot-vs-REST parity test** (a team_member's `list_tasks` returns exactly what their REST `GET /v1/tasks` returns; a freelancer's `get_shoot_schedule` is own-slots-only — the guard that the bot doesn't bypass ADR-011), the resolver's precedence states, and MFA enrollment.

**Estimated time:** 5 working days (Week 9 per `06-IMPLEMENTATION-PLAN.md` §11; owners TL + D3). Day 1 pre-flight (incl. the model-verify gate) + `resolvePermission`; day 2 `BotService` + tools; day 3 routes + backend tests; day 4 socket client + bot UI; day 5 MFA track + E2E. The MFA track is front-end auth work independent of the bot — it can run in parallel if you have a second pair of hands.

**Prerequisites from Sprint 7** (all green — stop and fix if any is not):

- Sprint 7 close-out fully checked; PR merged; CI green. Both cross-module triggers live.
- **The Sprint 0 bot streaming scaffold exists**: `apps/api/src/lib/bot/stream-handler.ts` (with mocked tests).
- **The Sprint 0 server-side `socketTokenWatcher` (C-05) is applied to `/ws/notify`** — the client handshake needs its counterpart.
- `ROLE_DEFAULTS` exists (Sprint 3); the `user_permissions` table exists (schema).
- The chassis: `(portal)` layout + RBAC sidebar, `MonthContext`, `lib/api.ts`, `handleMutationError`, `AuditService`, `NotificationService`, the isolating service methods (`TaskService.getTasks`, `AttendanceService.getGrid`, `ShootPlannerService.getGrid`, `ContentDropperService.getGrid`, `ContentCalendarService.getGrid`, `HolidayService.list`, `ClientService`), `EventBus` + `events/listeners.ts`, the Redis client.
- `ANTHROPIC_API_KEY` in `apps/api/.env`; `ANTHROPIC_MODEL_PROD` / `ANTHROPIC_MODEL_DEV` env vars.
- Supabase project has TOTP/MFA enabled (THIRD-PARTY §2.1).
- `pnpm typecheck`, `pnpm lint`, and the full suite green on `main`.

---

## THE PRE-SPRINT-8 DECISIONS — WHERE THEY LAND

Ruled at the pre-Sprint-8 gate; **inputs** to this sprint.

| Decision | Ruling | Executed in |
|---|---|---|
| **C-01 vs ADR-010** | Pull a **minimal** socket client into Sprint 8 (connection + C-05 + `bot:token`/`bot:message`); grid subs + bell UI stay Sprint 10. Amend ADR-010. | STEP 1 (amend) + STEP 6 |
| **Streaming event shape** | **`bot:token { sessionId, delta }`** for the stream + terminal **`bot:message { sessionId, content, card?, toolsUsed? }`** on completion — two events, unambiguous render. | STEP 3 + STEP 6 |
| **`resolvePermission`** | Redis `perms:{staffId}` → **DB read-through on miss** → `ROLE_DEFAULTS` floor. Override beats default; default is the safe floor; never the reverse. Cache-bust on admin write. | STEP 2 |
| **Tool scoping** | Tools **reuse the isolating service methods** with the **JWT-authenticated `currentUser`** (never a tool-arg staffId). 🔐 scoping + ADR-011 live in the service. Parity test guards it. | STEP 3 + STEP 5 |
| **Model + streaming** | `claude-sonnet-4-6` prod / `claude-haiku-4-5-20251001` dev, `max_tokens: 1024`, `stream: true`, TTFT < 2s. **Verify strings against the live API first.** | STEP 1 (verify) + STEP 3 |
| **MFA (reclassified: blocking, not deferred)** | Client-side Supabase `auth.mfa.enroll`/`challengeAndVerify`; backend flips `mfa_enrolled`. Built as a **parallel track** with its own close-out. | STEP 8 |

---

## READ FIRST (Open in Antigravity Split View)

`@`-reference these with `@docs/02-TRD.md`.

| Doc | Sections | Why |
|---|---|---|
| `docs/02-TRD.md` | §9 (AI Bot Architecture — the request pipeline, system prompt, the tool loop) | The exact orchestration to build |
| `docs/04-APPFLOW.md` | §9 (AI Bot flow — session load, send, streaming, permission-denied copy, new conversation) | Every interaction |
| `docs/07-API-CONTRACT.md` | §Bot (POST 202 + the C-01 clarification, GET/DELETE session shapes), §6 (socket events), §2 (bot rate limit 30/min) | Exact shapes + the event registry |
| `docs/08-AUTH-MATRIX.md` | §5 (the 22-tool matrix — the 11 query tools + per-role gates), §6 (the override system — keys, precedence, Redis cache) | Which role gets which tool; the resolver spec |
| `docs/11-THIRD-PARTY-INTEGRATIONS.md` | §3 (Anthropic — model selection, call pattern, cost control, retry), §5 (Redis `bot:session` key), §2.3 (MFA client SDK) | Anthropic + Redis + the MFA path |
| `docs/09-ERROR-HANDLING.md` | §6 (bot error communication — never expose codes), the bot codes (`BOT_TOOL_DENIED`, `ANTHROPIC_ERROR`) | Friendly bot errors |
| `docs/13-NFRS.md` | §1.2–§1.3 (bot TTFT < 2s / full < 8s; the streaming clarification) | The latency bar |
| `docs/06-IMPLEMENTATION-PLAN.md` | §11 | Sprint 8 checklist |
| `docs/12-TESTING-STRATEGY.md` | bot integration + permission-filter tests | The tests you must reproduce |
| `docs/adr/` | **ADR-002, ADR-005, ADR-010 (amend), ADR-011** | MFA, bot namespace, socket scope, freelancer isolation |

---

## CONSISTENCY RECONCILIATIONS — LOCK THESE BEFORE YOU PROMPT

The Master Build Guide's Sprint 8 shorthand drifts from the canonical specs in several load-bearing places. The numbered specs + schema + the ADRs win:

1. **Bot streams over `/ws/notify`, NOT a `/bot` namespace.** TRD §8 + API-Contract §6 define exactly three namespaces (`/ws/chat`, `/ws/presence`, `/ws/notify`); ADR-005 locked bot streaming to `/ws/notify`. The Master Guide's `/bot` namespace does not exist — the `bot:token`/`bot:message` events ride `/ws/notify`, room `user:{staffId}`.
2. **Permission keys are `bot.tool.{tool_name}`** (Auth-Matrix §6.2), e.g. `bot.tool.get_attendance`. The Master Guide's `bot:can_query_attendance` / `getEffectivePermissions` naming is wrong — use `resolvePermission(staffId, 'bot.tool.get_attendance')`. (A batch helper that resolves all 11 `bot.tool.*` keys for filtering is fine, built on the single resolver.)
3. **Two socket events, not one overloaded event** (pre-Sprint-8 ruling): **`bot:token { sessionId, delta }`** for streaming deltas + a **terminal `bot:message { sessionId, content, card?, toolsUsed? }`** on completion. API-Contract §6 lists `bot:message` as the terminal `{ content, card?, toolsUsed? }`; **add `bot:token`** to the registry (an addition, not a conflict). Overloading one event for deltas and the final card produces flickering half-rendered cards.
4. **Tools reuse the isolating service methods with the JWT caller** (TRD §9.1 line 378: "Execute service method — same validation as direct REST API call"). Pass `currentUser` from the request context into every tool; **never expose a staffId in the tool's input schema** (a model could be prompted into impersonation). The 🔐 (own-data) scoping and the ADR-011 freelancer predicate live in the service, not the tool.
5. **`resolvePermission` precedence (pre-Sprint-8 ruling):** override (Redis → **DB read-through** on cache miss) beats role default; `ROLE_DEFAULTS` is the **safe floor**, never the reverse. "Not in cache" ≠ "not overridden" — read through to the DB. Redis-down → DB → `ROLE_DEFAULTS`. Never fail-open.
6. **Verify model strings against the live API first** (Master Guide VERIFY FIRST + pre-Sprint-8 ruling). The spec's `claude-sonnet-4-6` / `claude-haiku-4-5-20251001` **must** appear in `GET /v1/models`. **Model strings evolve** — if either is absent (e.g. Sonnet has moved to a newer version), update **both** the env and the spec doc to the current registry string (current Sonnet-tier for prod, Haiku-tier for dev); do **not** guess or silently swap one to match the other.
7. **Frontend path `apps/web/app/(portal)/bot/`** (no `src/`), matching Sprints 3–7.
8. **"H-01" here = the bot session shape** (`{ sessionId, messages, turnCount, lastActivityAt }`, API-Contract §Bot), a **different** finding than the pre-build-audit §H-01 (the holiday cascade). Cross-doc ID collision (like M-04). Cite the API-Contract shape, not the bare ID.
9. **Query tools are read-only → no confirmation gate this sprint.** But build the tool descriptor with an **`isMutation` flag** (all query tools `false`) so Sprint 9's two-turn confirmation interceptor (TRD §9.2) slots in without unpicking the loop.
10. **Bot errors never expose codes/stack traces** (Error-Handling §6). Map internal errors to friendly copy — `BOT_TOOL_DENIED`/`PERMISSION_DENIED` → "I don't have permission to [action] on your behalf. Ask an admin to update your bot access settings." (never state the required role); `ANTHROPIC_ERROR` → "I'm having trouble connecting right now. Please try again."
11. **MFA enrollment is client-side via the Supabase SDK** (THIRD-PARTY §2.3) — the browser session calls `auth.mfa.enroll`/`challengeAndVerify`; the backend flips the flag. This resolves the Sprint-1 `501 MFA_ENROLL_UNAVAILABLE` (the admin service client can't enroll).
12. **The socket client is minimal** (ADR-010 amendment): `/ws/notify` connection + C-05 + `bot:token`/`bot:message` only. Grid subscriptions and the bell/chat UI stay Sprint 10 — the `// TODO(Sprint 10)` markers in the modules remain valid.
13. **Per-tool role gates matter** (Auth-Matrix §5): e.g. team_member gets `get_content_calendar` (✅) but **not** `get_content_pipeline` (❌); `get_audit_log` is **admin-only**; `get_client_summary` is admin/manager. Encode these exactly in `ROLE_DEFAULTS` (they already are from Sprint 3) and let the filter apply them.
14. **Archive to `messages` with `channel='bot'`** (TRD §9.1). The `messages` table is shared with common chat (Sprint 10).

---

## AUDIT + ADR ITEMS THIS SPRINT MUST HANDLE

| ID | What | Where |
|---|---|---|
| **Model verify** | `GET /v1/models` confirms the strings before any model call; stop + fix on mismatch. | STEP 1 |
| **C-01** | `POST /v1/bot/message` → 202 `{ messageId, sessionId }`, **no `content`/`card` in the body**; reply over `/ws/notify`. | STEP 4 |
| **Bot session shape** ("H-01") | `GET /v1/bot/session/current` → `{ sessionId, messages, turnCount, lastActivityAt }`; `DELETE` → `{ cleared: true }`. | STEP 4 |
| **`resolvePermission`** (deferred from Sprint 3) | Redis → DB read-through → `ROLE_DEFAULTS` floor; cache-bust on override. | STEP 2 |
| **Tool scoping / ADR-011** | Tools reuse isolating services with the JWT caller; **bot-vs-REST parity test**. | STEP 3 + STEP 5 |
| **MFA enrollment** (ADR-002 — launch blocker) | Client-side enroll/verify; backend flips `mfa_enrolled`. | STEP 8 |

If you skip the test for any of these, Sprint 8 is not done.

---

## STEP-BY-STEP STRUCTURE

| # | Type | What |
|---|---|---|
| 1 | Manual | Pre-flight — Sprint 7 green, **VERIFY MODEL STRINGS**, confirm scaffold + C-05, amend ADR-010, branch |
| 2 | Prompt | `resolvePermission` (Redis → DB read-through → floor) + admin override endpoint (cache-bust) |
| 3 | Prompt | `BotService` + 11 query tools (reuse services, JWT caller) + system prompt + Redis session + tool loop |
| 4 | Prompt | Bot routes (202 / GET / DELETE) + C-01 + archival to `messages` |
| 5 | Prompt | Backend tests (C-01, session, filter, **parity**, resolver states) |
| 6 | Prompt | Frontend socket client (minimal: `/ws/notify` + C-05 + `bot:token`/`bot:message`) |
| 7 | Prompt | Frontend bot chat UI + 11-card registry + streaming render |
| 8 | Prompt | **MFA enrollment parallel track** (client-side enroll/verify + backend flip) |
| 9 | Manual + Prompt | Playwright + bot E2E + TTFT perf |
| 10 | Manual | End-to-end smoke + commit + close-out |

---

## SPRINT 8 — STEP 1: Pre-flight (manual) — including the model-verify gate

**Goal:** Solid ground, and the single hard gate that stops the sprint if the model strings are wrong.

### 1.1 — Confirm Sprint 7 is green

```bash
git checkout main && git pull
docker compose up -d && docker compose ps          # both healthy
pnpm install
pnpm --filter @skaly/api db:status                 # 0 pending
pnpm typecheck && pnpm --filter @skaly/api test    # green before branching
```

### 1.2 — ⚠️ VERIFY MODEL STRINGS (hard gate — do this before any model-calling code)

```bash
curl -s https://api.anthropic.com/v1/models \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" | jq '.data[].id'
```

The output **must** include the strings your env uses:
- `claude-sonnet-4-6` (prod) and `claude-haiku-4-5-20251001` (dev), **or** whatever `ANTHROPIC_MODEL_PROD` / `ANTHROPIC_MODEL_DEV` are set to.

- **Both present** → proceed.
- **Either missing** → **STOP.** Model strings evolve; the spec's may be stale. Pick the current **Sonnet-tier** string for prod and **Haiku-tier** for dev from the `jq` output, update **both** `apps/api/.env` (`ANTHROPIC_MODEL_PROD`/`ANTHROPIC_MODEL_DEV`) **and** the spec doc / INFRA §6, and note the change. Do **not** guess a string or silently swap one to match the other — a wrong model is an HTTP 400 at runtime.

### 1.3 — Confirm the scaffolds this sprint builds on

```bash
ls apps/api/src/lib/bot/stream-handler.ts || echo "MISSING — Sprint 0 STEP 9 scaffold absent; build the streaming handler shell first"
grep -rn "socketTokenWatcher" apps/api/src/sockets || echo "MISSING — C-05 server watcher not applied; the client handshake needs it"
docker compose exec postgres psql -U skaly -d skaly_dev -c "\dt" | grep -i user_permissions   # the override table exists
docker compose exec postgres psql -U skaly -d skaly_dev -c "\dt" | grep -iE "^\s*public\s*\|\s*messages" # the messages table exists
```

### 1.4 — Amend ADR-010 (Prompt)

> **WHERE WE ARE**
>
> Sprint 8, STEP 1.4. Recording the pre-Sprint-8 socket-scope decision. Read `docs/adr/ADR-010` and `docs/07-API-CONTRACT.md` §Bot (the C-01 clarification).
>
> **WHAT TO DO** — append a dated amendment to `docs/adr/ADR-010`:
>
> ```
> ## Amendment (pre-Sprint 8) — socket client scope revised
> C-01 delivers the bot's entire response (streaming tokens, tool results, cards) exclusively
> via Socket.io to user:{staffId}. Deferring the frontend socket client to Sprint 10 would
> leave Sprint 8's bot unable to receive a single token. Revised split:
>   Sprint 8 builds (minimal): the /ws/notify client connection (lib/socket.ts singleton);
>     the C-05 client handshake (auth:refresh_required → refresh → auth:refresh) — required
>     because a 1-hour JWT expires mid-session and would drop the bot socket; the bot:token +
>     bot:message subscriptions feeding the bot chat UI.
>   Sprint 10 still builds (unchanged): all grid live-update subscriptions (the // TODO(Sprint 10)
>     markers remain valid); the bell/notification UI + notify:new subscription; common chat.
> Streaming shape: bot:token { sessionId, delta } for deltas + terminal bot:message
>     { sessionId, content, card?, toolsUsed? } on completion.
> Rationale unchanged: the client is still built once, with C-05. Moving it earlier only makes
> Sprint 8's bot end-to-end testable; Sprint 10 becomes "attach remaining consumers" (additive).
> ```
>
> Show me the amended ADR-010.

**Verify:**

```bash
git add docs/adr/ADR-010-*.md && git commit -m "docs(adr): amend ADR-010 — minimal socket client into Sprint 8"
```
`▶ /ponytail` — checkpoint the model-verify result + ADR before building.

### 1.5 — Branch

```bash
git checkout -b sprint-8-bot-query
```

**Verify gate:** Sprint 7 green, **model strings verified**, scaffolds present, ADR-010 amended, on `sprint-8-bot-query`. Proceed.

---

## SPRINT 8 — STEP 2: `resolvePermission` + admin override endpoint

**Goal:** The permission resolver deferred since Sprint 3 — built against its first consumer (bot tool gating), with the read-through precedence that keeps a cache miss from under-granting.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 8, STEP 2. Building `resolvePermission`. Read `docs/08-AUTH-MATRIX.md` §6 (precedence rule, key naming §6.2, Redis cache §6.3) and `packages/shared/src/constants/permissions.ts` (`ROLE_DEFAULTS`).
>
> **HARD CONSTRAINTS (pre-Sprint-8 ruling):**
> - Precedence: **explicit override (Redis → DB read-through) beats role default; `ROLE_DEFAULTS` is the safe floor**, never the reverse.
> - **A cache miss is NOT "not overridden"** — read through to the DB `user_permissions` table. Only if the DB also has no row → `ROLE_DEFAULTS[key][role]`.
> - **Redis unreachable** → fall to DB → `ROLE_DEFAULTS`. Never fail-open.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/src/services/PermissionService.ts`:**
>    - `resolvePermission(staffId, role, permissionKey, db): Promise<boolean>`:
>      1. Try Redis `perms:{staffId}` (JSON array of `{ permissionKey, value }`). If the array is present **and** contains this `permissionKey` → return its `value`.
>      2. If the key isn't in the cached array **or** Redis is unreachable → `SELECT value FROM user_permissions WHERE staff_id = ? AND permission_key = ?`. If a row exists → return it (and, if Redis was reachable, refresh the cache).
>      3. No override anywhere → return `ROLE_DEFAULTS[permissionKey]?.[role] ?? false` (unknown key → `false`, the safe floor).
>      - Wrap Redis calls in try/catch; a Redis error logs and falls to DB (never throws through).
>    - `getPermittedBotTools(staffId, role, db): Promise<string[]>` — resolves `bot.tool.{name}` for each of the 11 query tools and returns the permitted subset (batch helper built on `resolvePermission`; one Redis read + a single DB query for the missing keys, not 11 round-trips).
>    - `loadCache(staffId, db)` / cache-refresh: build the full override array from `user_permissions` and `SET perms:{staffId}` with a **5-minute TTL** (Auth-Matrix §6.3).
>
> 2. **Admin override endpoint** — `PUT /v1/staff/:id/permissions/:key` (**admin only**, Auth-Matrix §4): body `{ value: boolean }` → upsert `user_permissions` → `AuditService.log` → **`DEL perms:{staffId}`** (cache-bust; next resolve re-reads). Return the updated permission.
>
> 3. **Tests** `apps/api/test/services/PermissionService.test.ts`:
>    - No override → returns `ROLE_DEFAULTS` (e.g. team_member `bot.tool.get_attendance` → `true` per the matrix? — check §5; team_member `get_attendance` is 🔐 → `true`; `get_content_pipeline` → `false`).
>    - Override `true` on a default-`false` key (e.g. team_member `bot.tool.update_task_status`) → `true`; override `false` on a default-`true` key → `false`.
>    - **Cache miss reads through to DB:** seed a `user_permissions` row, ensure `perms:{staffId}` is absent → `resolvePermission` returns the DB value (not the role default).
>    - **Redis-down fallback:** stub the Redis client to throw → resolver returns the DB/role-default value without throwing.
>    - **Cache-bust:** set an override via the endpoint → `perms:{staffId}` is deleted → next resolve reflects the new value.
>    - `getPermittedBotTools` for a freelancer returns only `get_shoot_schedule` (per §5).
>
> **RULES**
>
> - `ROLE_DEFAULTS` is the floor, applied last, and grants nothing a role shouldn't have.
> - The override endpoint always busts the cache — a stale grant must not outlive the 5-min TTL, and an explicit change takes effect immediately.
> - **Verify before moving on.** Build the resolver + tests before wiring it into the bot.
>
> Show me `resolvePermission` (with the three precedence branches) and the override endpoint.

**Verify:**

```bash
pnpm --filter @skaly/api test services/PermissionService
pnpm typecheck
```
`▶ /ponytail` — the resolver gates all bot access; review carefully.

---

## SPRINT 8 — STEP 3: `BotService` + 11 query tools + tool loop

**Goal:** The orchestration and the 11 tools — each reusing its isolating service method with the authenticated caller.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 8, STEP 3. `resolvePermission` ready. Building `BotService` + the 11 query tools. Read `docs/02-TRD.md` §9 (the request pipeline + the tool loop — especially "Execute service method, same validation as direct REST"), `docs/04-APPFLOW.md` §9, `docs/08-AUTH-MATRIX.md` §5 (the 11 query tools + per-role gates), `docs/11-THIRD-PARTY-INTEGRATIONS.md` §3, `docs/09-ERROR-HANDLING.md` §6, and the Sprint 0 `apps/api/src/lib/bot/stream-handler.ts`.
>
> **HARD CONSTRAINTS:**
> - **Tools reuse the isolating service methods with the JWT-authenticated `currentUser`** — `list_tasks` → `TaskService.getTasks(filters, currentUser, db)`, etc. **Never** expose a staffId in a tool's input schema (impersonation prevention). The 🔐 scoping + ADR-011 live in the service.
> - **Stream** with `bot:token` deltas + a terminal `bot:message` (ADR-010 amendment).
> - **Bot errors never expose codes** (Error-Handling §6).
>
> **WHAT TO BUILD**
>
> 1. **The 11 query tool definitions** — `apps/api/src/lib/bot/tools/queries/`, one file each, each exporting `{ name, description, inputSchema (Zod → JSON schema for Anthropic), isMutation: false, handler(input, currentUser, db) }`:
>    - `get_project_status`, `list_tasks`, `list_overdue_tasks`, `get_user_workload`, `get_attendance`, `get_shoot_schedule`, `get_content_pipeline`, `get_content_calendar`, `get_audit_log`, `get_holiday_list`, `get_client_summary`.
>    - Each `handler` calls the corresponding **existing service method** with `currentUser`, then shapes a **card payload** (a small typed object the frontend renders — e.g. `list_tasks` → `{ type: 'task_list', tasks: [...] }`). Do **not** issue raw DB queries.
>    - `get_audit_log` → `AuditService` query (admin-only — the filter already excludes it for others, but the handler asserts too). `get_shoot_schedule` for a freelancer → `ShootPlannerService.getGrid` applies the ADR-011 predicate automatically.
>    - Input schemas carry only *query* params (period, date range, status filter, clientId) — never a staffId.
>
> 2. **`apps/api/src/services/BotService.ts`** — `handleMessage({ sessionId, staffId, role, userText, db })`:
>    a. Load/init the Redis session `bot:session:{staffId}` (`{ sessionId, messages, turnCount, lastActivityAt }`; 50-turn cap, drop oldest; 12-hr TTL).
>    b. **System prompt** (TRD §9.1): current IST date + period code, the caller's role + name, the anti-hallucination directive *"Only use provided tools. If data is unavailable, say so."*, and a line that the bot only sees data this caller is authorized for.
>    c. **Filter tools:** `getPermittedBotTools(staffId, role, db)` → include only those tool definitions.
>    d. **Stream call:** `client.messages.stream({ model: <env>, max_tokens: 1024, system, tools, messages })`. On each text delta → emit `bot:token { sessionId, delta }` to `io.of('/ws/notify').to('user:'+staffId)`. Await `stream.finalMessage()`.
>    e. **If `stop_reason === 'tool_use'`:** for each `tool_use` block — assert the tool is in the permitted set (defence in depth; if not → skip + a `BOT_TOOL_DENIED` friendly turn), validate the Zod input, run `handler(input, currentUser, db)`, collect a `tool_result` block (and keep the card payload). Then a **second** `messages.stream` with `[...messages, { role:'assistant', content: finalMessage.content }, { role:'user', content: toolResults }]` → stream those deltas too. On completion, emit the **terminal `bot:message { sessionId, content, card, toolsUsed }`** (card from the tool that ran; multiple tools → an array or the last, your call — document it).
>    f. **Retry** Anthropic 429/529 per THIRD-PARTY §3.4 (exponential backoff, 3 tries) → on exhaustion emit a terminal `bot:message` with the `ANTHROPIC_ERROR` friendly copy.
>    g. Append the new turns to the Redis session; **archive** the user message + final bot message to `messages` (`channel='bot'`).
>
> 3. **Tool errors → friendly copy** (Error-Handling §6): a `PERMISSION_DENIED`/`BOT_TOOL_DENIED` becomes "I don't have permission to [action] on your behalf. Ask an admin to update your bot access settings." (never the required role). Any unhandled tool error → "Something went wrong. Please try again or make the change directly in the portal."
>
> **RULES**
>
> - `currentUser` is always the JWT caller passed from the request — never a value the model supplied.
> - Query tools are read-only; carry the `isMutation: false` flag so Sprint 9's confirmation gate slots in without a rewrite.
> - Never leak an error code or stack trace to the user.
> - **Verify before moving on.** STEP 5 writes the suite — smoke one tool (`list_tasks`) end-to-end with a mocked stream now.
>
> Start with the tool definition shape + `list_tasks` (calling `TaskService.getTasks`), then `BotService.handleMessage` (the two-call tool loop with `bot:token`/`bot:message`).

**Verify:**

```bash
pnpm --filter @skaly/api test services/BotService   # smoke with mocked Anthropic
pnpm typecheck
```
`▶ /ponytail` — review the tool loop + service reuse before routes.

---

## SPRINT 8 — STEP 4: Bot routes + C-01 + archival

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 8, STEP 4. `BotService` exists. Now the routes. Read `docs/07-API-CONTRACT.md` §Bot (the 202 + C-01 clarification + GET/DELETE shapes) and §2 (bot rate limit 30/min).
>
> **WHAT TO BUILD**
>
> 1. **Zod schema** `packages/shared/src/schemas/bot.ts`: `BotMessageSchema` (`{ content: string.min(1).max(2000) }`).
>
> 2. **Routes `apps/api/src/routes/bot/`** (register per TRD §5.1):
>    - `POST /v1/bot/message` — **all roles** (tool permissions applied per-user inside); body `BotMessageSchema`; rate limit **30/min** keyed by staffId. **Audit C-01:** write the user message row → return **HTTP 202** with `{ data: { messageId, sessionId } }` **immediately**, then invoke `BotService.handleMessage` **asynchronously** (fire-and-forget after the response is sent — the reply streams over the socket). The 202 body **never** contains `content` or `card`.
>    - `GET /v1/bot/session/current` — authenticated; returns `{ data: { sessionId, messages, turnCount, lastActivityAt } }` (or the null-session shape). Loads from Redis `bot:session:{staffId}`.
>    - `DELETE /v1/bot/session/current` — authenticated; `DEL bot:session:{staffId}` → `{ data: { cleared: true } }`.
>
> 3. Confirm rate-limit headers (M-06). Confirm the async invocation doesn't block the 202 (the handler runs after `reply.send`).
>
> **RULES**
>
> - C-01 is absolute: the HTTP response is an acknowledgement only. The bot's tokens/cards go exclusively over `/ws/notify`.
> - Envelopes per API-Contract §1.1.
>
> Show me the POST route (202 + async invoke), then confirm Swagger lists all three.

**Verify:**

```bash
pnpm --filter @skaly/api dev   # /docs lists /v1/bot/*
pnpm typecheck
```
`▶ /ponytail`

---

## SPRINT 8 — STEP 5: Backend test round-out + full suite

**Goal:** C-01, the session shape, the permission filter, and — the guard that matters most — the **bot-vs-REST parity test** that proves ADR-011 isn't bypassed.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 8, STEP 5. Now the full backend suite. Read `docs/12-TESTING-STRATEGY.md` (bot tests) and the pre-Sprint-8 tool-scoping ruling. Mock the Anthropic client (return canned `tool_use` responses) — don't hit the real API in unit tests.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/test/routes/bot.test.ts`:**
>    - **C-01:** `POST /v1/bot/message` → **202**, body is exactly `{ data: { messageId, sessionId } }` and contains **no** `content`/`card` (assert the keys are absent).
>    - **Session shape ("H-01"):** `GET /v1/bot/session/current` → the exact `{ sessionId, messages, turnCount, lastActivityAt }` shape; empty-session variant returns the null shape.
>    - **DELETE:** clears the Redis key → `{ cleared: true }`; a subsequent GET returns the empty shape.
>    - Rate-limit headers present; over-limit → 429.
>
> 2. **`apps/api/test/services/BotService.test.ts` (mocked Anthropic):**
>    - **Tool fires:** a mocked stream returns a `list_tasks` `tool_use` → assert `TaskService.getTasks` was called **with the JWT `currentUser`** (not a tool-arg staffId) and the card payload is shaped correctly.
>    - **Permission filter:** a team_member with `bot.tool.get_attendance` resolved `false` (override) → the attendance tool is **absent** from the tool list sent to Anthropic; if the model somehow requests it, the handler refuses with the friendly copy.
>    - **⭐ Bot-vs-REST parity (the ADR-011 guard):** for a team_member, the `list_tasks` tool result row-set **equals** what `GET /v1/tasks` returns for that same user; for a freelancer, `get_shoot_schedule` returns **only their own slots** (identical to the REST shoot-planner for that freelancer). Assert equality of the row sets. *(This fails if any tool issued its own unscoped query.)*
>    - **Anthropic error:** stub a 529 through all retries → the terminal `bot:message` carries the friendly `ANTHROPIC_ERROR` copy, no code leaked.
>    - **Streaming events:** deltas emit as `bot:token`; completion emits one terminal `bot:message` with `content` (+ `card` when a tool ran). Spy on the socket emit.
>    - **Session cap:** a 51st turn drops the oldest; TTL refreshed on each message; both user + bot messages archived to `messages` (`channel='bot'`).
>
> 3. Run the **whole** API suite + typecheck + lint.
>
> **RULES:** the parity test is mandatory — it's the guard that the bot doesn't undo per-role isolation. Assert `currentUser` provenance (JWT, not tool arg).
>
> Show me the C-01 test and the parity test first, then run the suite.

**Verify:**

```bash
pnpm --filter @skaly/api test        # full suite green — incl. C-01 + parity
pnpm typecheck && pnpm lint
```
`▶ /ponytail` — full backend review before committing the backend half.

```bash
git add -A && git commit -m "Sprint 8 backend: resolvePermission + BotService + 11 query tools + routes (C-01) + tests"
```

---

## SPRINT 8 — STEP 6: Frontend socket client (minimal) + C-05

**Goal:** The pulled-forward socket client — connection, refresh handshake, and the two bot subscriptions. **Minimal scope only** (ADR-010 amendment).

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 8, STEP 6. Backend done. Now the frontend socket client — **minimal**. Read `docs/02-TRD.md` §8 (client reconnection + the C-05 refresh handshake), `docs/07-API-CONTRACT.md` §6 (`bot:token` we added + `bot:message`), and `docs/adr/ADR-010` (the amendment — build ONLY the connection + C-05 + bot subscriptions; grid subs + bell UI are Sprint 10).
>
> **WHAT TO BUILD** — `apps/web/lib/socket.ts` (the singleton the whole app will share):
>
> 1. A lazily-created `socket.io-client` connection to `NEXT_PUBLIC_WS_URL + '/ws/notify'` with `auth: { token }` (from the Sprint 1 session store), reconnection per TRD §8 (`reconnectionDelay: 1000`, `reconnectionDelayMax: 30000`, `reconnectionAttempts: Infinity`).
> 2. **C-05 client handshake:** `on('auth:refresh_required')` → refresh the token via the api client (`POST /v1/auth/refresh`) → `socket.auth = { token: newToken }; socket.disconnect().connect()` (or `emit('auth:refresh', { token })` per the server watcher's contract — match whatever the Sprint 0 `socketTokenWatcher` expects). **This is non-negotiable** — a 1-hour JWT expires mid-conversation and drops the bot socket without it.
> 3. **`useNotifySocket(event, handler)`** — subscribe/unsubscribe on mount/unmount, sharing the singleton (never opens a second connection).
> 4. **Scope guard:** build **only** the connection + C-05 + the ability to subscribe. Do **not** add grid-update subscriptions or the bell UI — those are Sprint 10. Leave a comment: `// Sprint 10 attaches grid subscriptions + bell UI here; this file is the shared client.`
>
> **RULES**
>
> - One connection per tab; the hook shares the singleton.
> - The C-05 handshake must match the server-side `socketTokenWatcher` contract exactly — confirm the event names against `apps/api/src/sockets`.
> - **Verify before moving on.** Boot the app, connect, confirm the socket authenticates and survives a forced token refresh.
>
> Show me `lib/socket.ts` (connection + C-05 handshake + the hook).

**Verify (manual):**

```bash
pnpm dev
# Browser console on any authenticated page: the /ws/notify socket connects (Network → WS → 101).
# Force a refresh (or wait for auth:refresh_required) → the socket reconnects with a fresh token, no drop.
pnpm --filter @skaly/web test
```
`▶ /ponytail` — the socket client is shared infra; review before the bot UI.

---

## SPRINT 8 — STEP 7: Frontend bot chat UI + 11-card registry + streaming

**Goal:** The chat interface with token-by-token streaming and a card per tool type.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 8, STEP 7. Socket client ready. Now the bot UI. Read `docs/04-APPFLOW.md` §9 (send flow, streaming, permission-denied copy, new conversation), `docs/03-UIUX.md` (bot chat + card styling), and the tool → card mapping from STEP 3. Reuse `lib/socket.ts` + `useNotifySocket`, the api client.
>
> **WHAT TO BUILD** — `apps/web/app/(portal)/bot/page.tsx` + `apps/web/components/modules/bot/` (no `src/`):
>
> 1. **On mount:** `GET /v1/bot/session/current` → restore the conversation (or empty state).
> 2. **Send:** input → `POST /v1/bot/message { content }` → expect **202** → show a **"Thinking…"** indicator (animated dots) until the first `bot:token`.
> 3. **Streaming render:** `useNotifySocket('bot:token', ({ sessionId, delta }) => append delta to the in-flight assistant message)` — token-by-token. `useNotifySocket('bot:message', ({ content, card, toolsUsed }) => finalize the message: set final content, attach the card via the registry, clear the Thinking indicator)`. (Match on `sessionId` so a stale stream can't cross-contaminate.)
> 4. **Card registry** — `apps/web/components/modules/bot/cards/`: one component per tool card type (11): task list, overdue list, workload, attendance summary, shoot schedule, pipeline, calendar, audit log, holiday list, client summary, project status. A `<BotCard type=… payload=… />` dispatcher renders the right one; an unknown type falls back to plain text.
> 5. **Permission-denied / errors:** the terminal `bot:message` may carry the friendly refusal or error copy — render it as a normal assistant message (no code, no stack).
> 6. **New conversation:** `[New conversation]` icon → "Clear your conversation history?" dialog → `DELETE /v1/bot/session/current` → clear the panel → empty state.
> 7. **Real-time scope (ADR-010):** this page uses the socket only for `bot:token`/`bot:message`. No grid subscriptions.
> 8. **Frontend tests:** a mocked `bot:token` sequence renders incrementally; the terminal `bot:message` finalizes + attaches the correct card; `sessionId` mismatch is ignored; New conversation clears; the Thinking indicator shows until the first token.
>
> **RULES**
>
> - The HTTP 202 carries no content — everything visible comes from the socket (C-01).
> - Streaming appends deltas; the terminal message finalizes. Never buffer the whole reply before showing it (NFR §1.3 — TTFT is the metric).
> - Build the streaming text path first; show me tokens rendering before the card registry.

**Verify (manual):** open `/bot` → ask "How many tasks are overdue this week?" → "Thinking…" → tokens stream in → an overdue-tasks card renders. As a team_member with attendance querying overridden off, ask an attendance question → the friendly "Ask your admin" refusal. New conversation → panel clears.

```bash
pnpm --filter @skaly/web test
```
`▶ /ponytail` — review the streaming + cards before the MFA track.

---

## SPRINT 8 — STEP 8: MFA enrollment (parallel track)

**Goal:** Resolve the Sprint-1 `501 MFA_ENROLL_UNAVAILABLE` — admin/manager first-login MFA must work end-to-end, or the launch (Sprint 13) is blocked. **This track is independent of the bot** and can run in parallel.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 8, STEP 8. Parallel track: fixing MFA enrollment. Read `docs/11-THIRD-PARTY-INTEGRATIONS.md` §2.3 (the client-side `auth.mfa.enroll` / `challengeAndVerify`), `docs/08-AUTH-MATRIX.md` §10 (MFA enforcement) and §2 (the middleware redirect), and `docs/adr/ADR-002`. The Sprint-1 blocker: the `@supabase/auth-js` **admin** client can't enroll factors — enrollment must run in the **user's browser session** via the Supabase client SDK.
>
> **WHAT TO BUILD**
>
> 1. **`/mfa-setup` page** (exists as a stub from Sprint 1) — drive the client-side Supabase SDK with the **authenticated user session**:
>    - `const { data } = await supabase.auth.mfa.enroll({ factorType: 'totp' })` → render `data.totp.qr_code` as the QR image + `data.totp.secret` for manual entry.
>    - User enters the 6-digit TOTP → `await supabase.auth.mfa.challengeAndVerify({ factorId: data.id, code })`.
>    - On success → `POST /v1/auth/mfa/confirm` (below) → then `router.push('/home')` (or the return URL).
>    - Handle the `MFA_LOCKED` case (3 failed attempts → 15-min lockout, code from Supabase) with the friendly copy.
>
> 2. **Backend `POST /v1/auth/mfa/confirm`** — authenticated; verifies the caller genuinely has an enrolled factor (optionally via the admin `listFactors(userId)` to confirm a verified TOTP factor exists — trust-but-verify), then `UPDATE staff SET mfa_enrolled = true WHERE supabase_uid = <caller>` + `AuditService.log`. Returns `{ data: { mfaEnrolled: true } }`. Replace the old `AuthService.enrollMfa` `501` throw — the actual enrollment now happens client-side; this endpoint only records the flag.
>
> 3. **Login-time TOTP challenge** — for admin/manager with `mfa_enrolled = true`, after password auth the login flow must present the TOTP verification screen (Auth-Matrix §10). This also uses the **client-side** `supabase.auth.mfa.challengeAndVerify` against the user session (the same SDK path), then proceeds to `/home`. Wire the `/login` flow's second factor to it. (If Sprint 1 already stubbed this screen, connect it; if not, build it.)
>
> 4. **Recovery codes:** the `mfa_recovery_codes` table (migration 029) exists from Sprint 1 as storage-only. If time permits, wire the **redeem** path (a recovery code as an alternative to a TOTP code at login); if not, leave a `// TODO` and a close-out note — the primary blocker is *enrollment*, which this step fixes.
>
> 5. **Tests:**
>    - `POST /v1/auth/mfa/confirm` flips `staff.mfa_enrolled` for the caller (mock the Supabase `listFactors` if you verify server-side).
>    - The middleware redirect (Sprint 1) sends an admin with `mfa_enrolled=false` to `/mfa-setup` and, once confirmed, lets them into the portal.
>    - `AuthService.enrollMfa` no longer throws `501` (or is removed in favour of the client path).
>
> **RULES**
>
> - Enrollment + verification run **client-side** against the user's Supabase session — never through the admin service client (that's why Sprint 1 hit `501`).
> - The backend records `mfa_enrolled`; it doesn't perform the TOTP enrollment.
> - **Verify before moving on.** Enroll a real admin end-to-end against the real Supabase project.
>
> Show me the `/mfa-setup` enroll/verify flow and the `POST /v1/auth/mfa/confirm` endpoint.

**Verify (manual — against real Supabase):** log in as an admin with `mfa_enrolled=false` → redirected to `/mfa-setup` → QR renders → scan in an authenticator → enter the code → verified → `staff.mfa_enrolled` is now `true` → landed in the portal. Log out and back in → the TOTP challenge appears after the password and accepts the code.

```bash
pnpm --filter @skaly/api test auth/   # incl. the mfa/confirm test
```
`▶ /ponytail` — MFA is a launch gate; review the enroll + login-challenge paths.

---

## SPRINT 8 — STEP 9: Playwright + bot E2E + TTFT perf

### 9.1 — Bot + MFA E2E (Prompt)

> **WHERE WE ARE**
>
> Sprint 8, STEP 9. Now E2E. Read `docs/12-TESTING-STRATEGY.md` §6. Reuse the Sprint 3–7 `loginAs` + `playwright.config.ts`.
>
> **WHAT TO BUILD** — `tests/e2e/bot.spec.ts` and `tests/e2e/mfa.spec.ts` (add `data-testid`s as needed):
> 1. **Bot query (admin):** `/bot` → send "How many tasks are overdue this week?" → assert the POST returns 202 → tokens stream (the message grows) → an overdue-tasks card renders. (Mock the model at the network layer if you don't want live-API cost in CI, OR run against a dev-Haiku key and assert *a* card renders rather than exact content.)
> 2. **Permission refusal (team_member):** override `bot.tool.get_attendance=false` for the test team_member (via the admin endpoint in `beforeAll`) → ask an attendance question → assert the friendly "Ask your admin" refusal, no card.
> 3. **New conversation:** send a message → `[New conversation]` → confirm → the panel clears and a subsequent `GET /v1/bot/session/current` is empty.
> 4. **MFA enrollment (admin, real Supabase):** an admin with `mfa_enrolled=false` → `/mfa-setup` → the QR + secret render; (drive the code with a TOTP generator seeded from the secret) → verify → landed in the portal; `mfa_enrolled` now true. *(If real-Supabase TOTP in CI is impractical, cover this with the backend `mfa/confirm` test + a manual sign-off checklist item instead — note which.)*
> 5. Run headed once, then headless (chromium + webkit).
>
> **RULES:** independent, re-runnable; reset the permission override + session in teardown.
>
> Show me the specs, then run them.

### 9.2 — TTFT performance (manual)

The bot's metric is **time-to-first-token**, not total time (NFR §1.3).

```bash
# With a dev-Haiku key, send a message and time the first bot:token relative to the POST.
# In the browser: Performance/Network → measure POST 202 → first WS frame carrying a bot:token delta.
```

- **Target: TTFT < 2s** (NFR §1.2/§1.3); full streaming completion < 8s for a ~1024-token reply.
- If TTFT is slow: confirm `stream: true` (not a buffered `messages.create`), the tool loop isn't blocking the first call, and the 202 is returned before `handleMessage` runs (not after).

**Verify:**

```bash
pnpm exec playwright test tests/e2e/bot.spec.ts tests/e2e/mfa.spec.ts   # green, chromium + webkit
```
`▶ /ponytail` — final review before close-out. TTFT is a real gate; measure it.

---

## SPRINT 8 — STEP 10: End-to-end smoke + commit + close-out (manual)

### 10.1 — Full manual walk-through

```bash
docker compose up -d && pnpm dev
```

1. **Bot query (admin):** ask overdue tasks → Thinking → streaming tokens → overdue card. Ask attendance, shoots, holidays, client summary → each returns the right card. `SELECT channel, role FROM messages WHERE channel='bot' ORDER BY created_at DESC LIMIT 4;` — user + bot rows archived.
2. **Tool isolation (the guard, by hand):** as a **team_member**, ask "show me all tasks" → the bot returns **only their** tasks (matching `GET /v1/tasks` for them). As a **freelancer**, ask about the shoot schedule → **only their** slots. As a **team_member**, ask for the audit log → refusal (not permitted).
3. **Permission override:** as admin, `PUT /v1/staff/:teamMemberId/permissions/bot.tool.update_task_status { value: true }` → confirm `perms:{id}` is busted → (this tool is a mutation, Sprint 9, but the resolver now returns true for it). Set `bot.tool.get_attendance=false` for a team_member → they can no longer get an attendance answer.
4. **Session:** `GET /v1/bot/session/current` restores history on reload; `[New conversation]` → DELETE → Redis key gone → empty.
5. **Socket resilience (C-05):** leave the bot open past a token refresh window → the socket survives (reconnects with a fresh token), the next message still streams.
6. **MFA (launch gate):** a fresh admin → `/mfa-setup` → enroll → `mfa_enrolled=true` → portal access; re-login → TOTP challenge. This must work.
7. **Anthropic down:** temporarily set a bad `ANTHROPIC_API_KEY` → the bot replies with the friendly "trouble connecting" copy, no code leaked; the portal is otherwise fully operational.
8. **Audit:** `SELECT staff_id, changed_by_source, table_name, action FROM audit_log WHERE table_name IN ('user_permissions','staff') ORDER BY created_at DESC LIMIT 10;` — override + mfa_enrolled writes present, `staff_id` never NULL.

`▶ /ponytail` — full-sprint review before the close-out checklist.

### 10.2 — Close-out checklist

Do not start Sprint 9 until **every** box is checked:

```
PRE-SPRINT DECISIONS EXECUTED
  [ ] Model strings VERIFIED against GET /v1/models (env + spec updated if they'd moved)
  [ ] ADR-010 amended (minimal socket client into Sprint 8; bot:token + bot:message shape)

PERMISSIONS
  [ ] resolvePermission: Redis → DB read-through on miss → ROLE_DEFAULTS floor; never fail-open (TESTED)
  [ ] cache miss ≠ not-overridden (DB read-through TESTED); Redis-down fallback TESTED
  [ ] admin override endpoint busts perms:{staffId} on write (TESTED)
  [ ] getPermittedBotTools returns the correct per-role subset (freelancer → get_shoot_schedule only)

BOT — backend
  [ ] 11 query tools, each reusing its isolating service method with the JWT currentUser (no staffId in tool schema)
  [ ] BotService tool loop: stream → tool_use → execute → second stream → terminal message
  [ ] System prompt: IST date + period + role + anti-hallucination
  [ ] Tool filter by resolvePermission; unpermitted tool → friendly refusal
  [ ] C-01: POST /v1/bot/message → 202 { messageId, sessionId }, NO content/card in body (TESTED)
  [ ] GET/DELETE /v1/bot/session/current per API-Contract §Bot (TESTED)
  [ ] Redis session: 50-turn cap, 12hr TTL refreshed; archive user+bot to messages (channel='bot')
  [ ] Anthropic 429/529 retry → friendly ANTHROPIC_ERROR on exhaustion; no code leaked
  [ ] ⭐ Bot-vs-REST parity test green: team_member list_tasks == REST; freelancer get_shoot_schedule own-only (ADR-011 NOT bypassed)
  [ ] isMutation flag on tools (query = false) for Sprint 9's confirmation gate

BOT — frontend + socket
  [ ] lib/socket.ts: /ws/notify connection + C-05 handshake (survives token refresh) — MINIMAL scope
  [ ] No grid subscriptions / bell UI (Sprint 10); // TODO(Sprint 10) comment present
  [ ] bot:token streaming render (token-by-token) + terminal bot:message finalize; sessionId-matched
  [ ] 11-card registry; unknown type → text fallback
  [ ] Thinking indicator until first token; New conversation → DELETE → clear
  [ ] Friendly refusal/error rendered as normal messages (no codes)

MFA (launch gate — ADR-002)
  [ ] /mfa-setup: client-side auth.mfa.enroll + challengeAndVerify; QR + secret render
  [ ] POST /v1/auth/mfa/confirm flips staff.mfa_enrolled; enrollMfa 501 removed (TESTED)
  [ ] Admin/manager first-login enrollment works end-to-end against real Supabase (MANUAL sign-off)
  [ ] Login-time TOTP challenge for enrolled admin/manager works
  [ ] Recovery-code redeem wired OR explicitly noted as a carried TODO

TESTS + PERF
  [ ] Bot route + service + permission suites green; parity test green
  [ ] Frontend tests green (streaming, card finalize, sessionId guard, new-conversation)
  [ ] Playwright: bot query + refusal + new-conversation (+ MFA or its manual sign-off)
  [ ] TTFT < 2s measured (dev key); full completion < 8s
  [ ] pnpm typecheck + pnpm lint clean
  [ ] /ponytail run at each Verify gate — no outstanding review flags
```

### 10.3 — Final commit

```bash
git add -A
git commit -m "Sprint 8: AI Bot query tools (C-01 streaming, service-reuse isolation) + resolvePermission + minimal socket client + MFA enrollment"
git push -u origin sprint-8-bot-query
```

Open the PR to `main`; CI must be fully green before merge. Merge, then `git checkout main && git pull`.
`▶ /ponytail` — post-merge checkpoint.

### 10.4 — Move to Sprint 9

Open `MASTER-BUILD-GUIDE-V2-FINAL.md` → PART 9 → **SPRINT 9 — AI BOT (MUTATION) + SEARCH**.

Sprint 9 adds the **11 mutation tools** (create_task, update_task_status, assign_task, add_holiday, update_pipeline_stage, update_shoot_slot, update_calendar_cell, add_client, etc.) behind the **two-turn confirmation protocol** (TRD §9.2 — the `isMutation` flag you set this sprint is the hook), plus **global search** (CMD+K, the GIN-indexed `search_indexes` table, audit M-05). Every mutation tool reuses the same isolating service methods — and the same parity discipline — as the query tools.

If any close-out box is unchecked, **stop**. Sprint 9's mutations reuse this sprint's tool loop, resolver, and socket client.

---

## DECISIONS TO MAKE BEFORE SPRINT 9

- **Two-turn confirmation is a server-side state machine, not a client convention (lock it):** TRD §9.2 requires every mutation tool to present a summary (turn 1, no tool call) and execute only on an explicit affirmative (turn 2). Decide the mechanism now: the bot session must carry a **pending-confirmation state** (`{ toolName, input, summary }`) so turn 2's "yes" maps to the exact tool + args from turn 1 — don't re-parse intent on turn 2 (the user might type "yes" to a stale summary). Recommend: store the pending tool call in the Redis session; turn 2 affirmative → execute the stored call; anything non-affirmative → clear it and ask for clarification. The `isMutation` flag from Sprint 8 gates entry into this machine.
- **Mutation tools reuse mutating service methods with period-lock + optimistic-lock intact:** `update_task_status` → `TaskService.update` (dependency block, ownership), `update_calendar_cell` → `ContentCalendarService.updateCell` (version, auto-reset), `update_shoot_slot` → `ShootPlannerService.update` (last-write-wins). The bot must pass through the **same** 423/409/403 the REST layer does — surfaced as the friendly bot copy (Error-Handling §6). The parity discipline extends to writes.
- **Search scope respects role isolation (M-05):** CMD+K global search over `search_indexes` (GIN) must apply the **same** per-role filtering — a team_member's search doesn't surface others' tasks; a freelancer's is shoot-scoped (ADR-011). Decide whether search filters post-query or the index rows carry a visibility predicate; recommend query-time role filtering mirroring the services, never a raw index scan.
- **Bot `update_calendar_cell` sets `source='manual'`** (it's a user-initiated write, just via the bot) — so the same auto-reset + version-bump path as the REST PATCH (ADR-013 case 2). Confirm the mutation tool goes through `updateCell` (which already does this) rather than a raw write.
- **Still deferred, on schedule:** remaining socket subscriptions + bell UI (Sprint 10), comment system (later sprint), attachment orphan cron + `coming_shoot_date` rollover recompute (Sprint 12).

---

## TROUBLESHOOTING — SPRINT 8 SPECIFIC

### Anthropic returns HTTP 400 on the first call
The model string isn't in the registry. Re-run the STEP 1.2 `GET /v1/models` check and set `ANTHROPIC_MODEL_PROD`/`DEV` to strings that actually appear. This is exactly why the verify gate is first.

### The bot returns another user's data (the isolation bug)
A tool issued its own DB query instead of calling the isolating service method, or a staffId leaked into a tool's input schema and the model set it. Fix: every tool calls `TaskService.getTasks(filters, currentUser, db)` etc. with the **JWT `currentUser`**, and no tool schema contains a staffId. The parity test catches this — if it's green and you still see leakage, the test isn't asserting row-set equality per role.

### A cache miss returns the role default even though an override exists in the DB
`resolvePermission` treated "not in the Redis array" as "not overridden". It must **read through to `user_permissions`** on a miss, not fall straight to `ROLE_DEFAULTS`. That's the security-relevant branch.

### An admin's permission change doesn't take effect for 5 minutes
The override endpoint isn't busting `perms:{staffId}`. `DEL` the key on every write (Auth-Matrix §6.3) so the next resolve re-reads.

### The HTTP response contains the bot's answer
C-01 violation. The 202 body is `{ messageId, sessionId }` only; `handleMessage` runs **after** `reply.send` and streams over the socket. If the answer is in the body, the handler is being awaited before the response.

### Tokens don't stream (the whole reply appears at once)
Either the frontend buffers until `bot:message` (it must render `bot:token` deltas incrementally), or the backend uses `messages.create` instead of `messages.stream`, or it's emitting one big chunk. TTFT is the metric — render deltas as they arrive.

### The bot socket drops after ~1 hour and the next message never streams
The C-05 client handshake is missing or mismatched. `on('auth:refresh_required')` → refresh → re-auth the socket, matching the Sprint 0 `socketTokenWatcher` event contract exactly.

### `bot:message` cards flicker or render half-built
You overloaded a single event for deltas and the final card. Use `bot:token` for deltas and a **terminal** `bot:message` that carries the final content + card — the render finalizes once.

### MFA enroll throws 501 / "admin client can't enroll"
You're calling enrollment through the admin service client. Enrollment must run **client-side** against the user's Supabase session (`supabase.auth.mfa.enroll`); the backend only records `mfa_enrolled`. This is the Sprint-1 gap — the fix is the client SDK path (THIRD-PARTY §2.3).

### Model verify passes but Haiku gives worse tool calls in dev
Expected — dev uses Haiku for cost; prod uses Sonnet for tool-call accuracy (TRD §9). Test tool *wiring* in dev; don't judge tool-call quality on Haiku. The env split is intentional.

---

## END OF SPRINT 8 DETAILED GUIDE

*Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1..7-DETAILED.md`. Source-of-truth precedence when documents differ: the numbered spec docs (`01`–`14`) + the schema win, then this guide's reconciliations and the ADRs it executes (002, 005, 006–013, ADR-010 amended), then the Master Build Guide's shorthand. The bot's read side, the permission resolver, the shared socket client, and MFA enrollment all land here. Sprint 9 (mutation tools + search) reuses this sprint's tool loop under the two-turn confirmation protocol — read the first pre-Sprint-9 decision before starting.*
