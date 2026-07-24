# SPRINT 8.1 — PERMISSION CONSOLIDATION + DETERMINISTIC BOT REFUSAL

## Scaly Business Portal • Remediation patch between Sprints 8 and 9

**Companion to `SPRINT-8-DETAILED.md`. Two defects found at Sprint 8 STEP 9. Fix both before Sprint 9 mutation tools land on top of them.**
**Tooling interfaces verified as of January 2026** — same stack as Sprint 8.

---

## USING `/ponytail`

Same convention as Sprints 6–8: `▶ /ponytail` at each **Verify** gate as a per-step review/checkpoint pass. (Placement still an assumption — tell me its actual function and I'll re-place it.)

---

## WHAT YOU'RE FIXING

### Defect 1 — Two implementations of one permission rule

`lib/permissions.ts::getEffectivePermissions` backs `/v1/staff/me` and returns the **role baseline only**, ignoring `user_permissions` overrides. `PermissionService::resolvePermission` (Sprint 8) implements the correct Auth-Matrix §6 precedence. Both claim ownership in contradictory comments ("Sprint 8 will wrap" vs "Sprint 11 wraps this").

**Auth-Matrix §6 defines one precedence rule, singular. Having two implementations is the defect**, independent of current blast radius. The observable symptom: an admin revokes `bot.tool.get_attendance`, the bot correctly refuses, but `/staff/me` still reports `true` — so the frontend shows a stale capability.

**Severity is conditional and STEP 1 resolves it.** "Display-only, therefore harmless" holds *only if* nothing enforces on `getEffectivePermissions`. If any route guard or Layer-3 service check reads it, a **revoking** override is silently ignored at that call site and the user keeps a capability the admin thought they removed — a real hole. (The granting direction is only ever an under-grant, which is safe.)

**Fix shape: delegate, don't wrap.** A 6-line wrapper leaves two implementations that can drift again — precisely how this arose. Consolidate onto one shared batch primitive in `PermissionService`, and add an import guard so a third implementation can't appear.

### Defect 2 — The canned refusal copy is near-unreachable

`BotService.ts:40`'s "Ask an admin to update your bot access settings" only fires when the model calls an **unpermitted** tool — but `getPermittedBotTools` strips those before the model ever sees them. It's a backstop for a hallucinated tool name, not the normal path.

**Consequence:** when a team_member with `get_attendance` revoked asks about attendance, the model doesn't have the tool, falls back on the anti-hallucination directive, and **improvises** the refusal. It may be unhelpful, factually wrong ("attendance isn't tracked here"), or leak the permission model. APPFLOW §9 specifies exact copy **and** an explicit constraint ("never states which role level is required") — neither of which a model reliably honors while improvising.

**Why this must be fixed before Sprint 9, not after.** Auth-Matrix §5 marks `update_task_status` as 🔧 for team_member — **default OFF**. So in Sprint 9, denial isn't an edge case, it's the **default path** for every team member who asks the bot to change a task status until an admin grants it. Same for `chat.access` on freelancers. Shipping that as model improvisation means the most-hit conversational path is non-deterministic.

**Fix shape:** inject the denied capabilities + the exact copy + the constraint into the system prompt. `buildSystemPrompt` already takes staff context. No extra round trip, no latency cost, and Sonnet follows this class of instruction reliably. Keep `BotService.ts:40` as the backstop it actually is.

> **Scope discipline:** only tools **filtered out before the model sees them** are affected. Tools that *are* permitted but fail at execution (`PERIOD_LOCKED`, `DEPENDENCY_UNRESOLVED`, `STAGE_SEQUENCE_VIOLATION`) return a `tool_result` the model relays — that path is reachable and already correct. Don't touch it.

---

## READ FIRST

| Doc | Sections | Why |
|---|---|---|
| `docs/08-AUTH-MATRIX.md` | **§6** (precedence §6.1, key naming §6.2, Redis cache §6.3), §5 (the 🔧 rows) | The single rule both implementations must serve |
| `docs/04-APPFLOW.md` | §9 (permission-denied copy + the never-state-the-role constraint) | The exact refusal text |
| `docs/09-ERROR-HANDLING.md` | §6 (bot error communication table) | Same copy, canonical source |
| `docs/02-TRD.md` | §9.1 (system prompt contents) | Where the denial section slots in |
| `docs/07-API-CONTRACT.md` | §Staff (`GET /v1/staff/me` response shape) | Compat constraint on the fix |

**Canonical refusal copy** (Error-Handling §6 + APPFLOW §9, verbatim):

> `I don't have permission to [action] on your behalf. Ask an admin to update your bot access settings.`

Constraint: **never state which role or permission level is required.**

---

## STEP-BY-STEP STRUCTURE

| # | Type | What |
|---|---|---|
| 1 | Manual | Caller audit — resolve the severity question; branch |
| 2 | Prompt | Consolidate onto one batch resolver in `PermissionService` |
| 3 | Prompt | Wire `/v1/staff/me`, retire `lib/permissions.ts`, add the import guard |
| 4 | Prompt | Defect 2 — deterministic denial copy in the system prompt |
| 5 | Prompt | Tests for both + correct the Sprint 8 STEP 9.1 E2E assertion |
| 6 | Manual | Verify, commit, close-out |

---

## STEP 1: Caller audit (manual)

**Goal:** Determine whether Defect 1 is display-only or an enforcement hole. This changes nothing about the fix — it changes how loudly you should have been told.

```bash
git checkout main && git pull
docker compose up -d && pnpm install
pnpm typecheck && pnpm --filter @skaly/api test    # green baseline

git checkout -b sprint-8.1-permission-consolidation
```

### 1.1 — Find every reader of the stale resolver

```bash
grep -rn "getEffectivePermissions" apps/api/src apps/web
```

Classify **every** hit:

- **Display-only** (the `/v1/staff/me` response payload, sidebar gating, a UI capability check) → under-grant only, harmless.
- **Enforcement** (a route `preHandler`, a Layer-3 service check, any `if (!perms[...]) throw`) → **a revoking override is being ignored here.** Note it; STEP 2 fixes it, but flag it in the commit message as a security-relevant correction rather than a cosmetic one.

### 1.2 — Find the same class of bug elsewhere

Anything reading `ROLE_DEFAULTS` directly bypasses overrides in exactly the same way:

```bash
grep -rn "ROLE_DEFAULTS" apps/api/src apps/web
```

Expected legitimate hits: `packages/shared/src/constants/permissions.ts` (the definition) and `PermissionService`. **Any other enforcement-side hit is a third implementation** — fold it into STEP 2.

### 1.3 — Confirm the frontend contract you must not break

```bash
grep -rn "permissions" apps/web/app apps/web/components apps/web/store | grep -i "staff/me\|useMe\|currentUser" | head
```

Note the shape the frontend expects from `/v1/staff/me` (likely a `permissions` object or array). STEP 3 must preserve it — the fix corrects the *values*, not the contract.

**Verify gate:** every `getEffectivePermissions` caller classified, no unknown `ROLE_DEFAULTS` enforcement sites, the `/staff/me` shape recorded.
`▶ /ponytail` — checkpoint the audit findings before changing code.

---

## STEP 2: Consolidate onto one batch resolver

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 8.1, STEP 2. Fixing Defect 1: two implementations of one permission rule. Read `docs/08-AUTH-MATRIX.md` §6 (precedence, key naming, Redis cache), `apps/api/src/services/PermissionService.ts` (the correct Sprint 8 implementation), and `apps/api/src/lib/permissions.ts` (the stale one).
>
> **THE RULE (Auth-Matrix §6.1), implemented exactly once:**
> explicit override in `user_permissions` (TRUE → allow, FALSE → deny) beats `ROLE_DEFAULTS[key][role]`; no row → role default; unknown key → `false`. `ROLE_DEFAULTS` is the safe floor, applied last.
>
> **WHAT TO BUILD** — in `apps/api/src/services/PermissionService.ts`:
>
> 1. **One shared override loader** (extract from whatever `resolvePermission`/`getPermittedBotTools` currently do — do not duplicate it):
>    `loadOverrides(staffId, db): Promise<Map<PermissionKey, boolean>>`
>    - Read Redis `perms:{staffId}` (JSON array of `{ permissionKey, value }`). If present, return it as a Map.
>    - On cache **miss** or Redis error → `SELECT permission_key, value FROM user_permissions WHERE staff_id = ?` → build the Map → if Redis is reachable, repopulate `perms:{staffId}` with a **5-minute TTL** (§6.3).
>    - Redis errors are caught and logged, never thrown through. Never fail-open.
>
> 2. **`getEffectivePermissions(staffId, role, db): Promise<Record<PermissionKey, boolean>>`** — the new single source of truth:
>    - Start from `ROLE_DEFAULTS[role]` across **all** permission keys (not just `bot.tool.*` — the frontend needs `module.*`, `chat.access`, `report.generate`, `months.unlock` too).
>    - Overlay `loadOverrides(staffId, db)`.
>    - Return the complete effective map.
>
> 3. **Refactor the two existing functions to delegate — do not leave parallel logic:**
>    - `resolvePermission(staffId, role, key, db)` → reads the effective map (or keeps a single-key fast path that calls the **same** `loadOverrides`, never its own query).
>    - `getPermittedBotTools(staffId, role, db)` → filter the effective map for `bot.tool.*` keys that are `true`. **Change its return to `{ permitted: string[], denied: string[] }`** — STEP 4 needs the denied list, and computing the complement in one place avoids a second source of truth.
>    - Update the Sprint 8 `BotService` call site for the new return shape.
>
> **RULES**
>
> - One override-loading path. One precedence implementation. If you find yourself writing the merge twice, stop and extract.
> - Preserve Sprint 8's behavior exactly — `resolvePermission`'s existing tests must stay green untouched.
> - The batch path must not fan out into N round trips: one Redis read + at most one DB query per call.
>
> Show me `loadOverrides`, `getEffectivePermissions`, and the two refactored delegates.

**Verify:**

```bash
pnpm --filter @skaly/api test services/PermissionService   # Sprint 8 tests still green, unmodified
pnpm typecheck
```
`▶ /ponytail` — confirm there is now exactly one merge implementation.

---

## STEP 3: Wire `/v1/staff/me`, retire `lib/permissions.ts`, add the import guard

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 8.1, STEP 3. The consolidated resolver exists. Now retire the stale one and prevent a third from appearing. My STEP 1 audit found these callers of `getEffectivePermissions`: **[paste the classified list from STEP 1.1]**. The `/v1/staff/me` response shape the frontend depends on is: **[paste from STEP 1.3]**.
>
> **WHAT TO BUILD**
>
> 1. **Repoint every caller** to `PermissionService.getEffectivePermissions(staffId, role, db)`. For `/v1/staff/me`, **preserve the existing response shape exactly** — this fix corrects the values, not the contract. If any caller from my list is an **enforcement** site (not display-only), call it out explicitly in your summary: that one was silently ignoring revoking overrides.
>
> 2. **Delete `apps/api/src/lib/permissions.ts`.** Do not leave a re-export shim — a shim is a second import path and invites the same drift. Fix the imports at the call sites instead. Delete the contradictory Sprint 8/Sprint 11 comments with it.
>
> 3. **Add a regression guard** so a third implementation can't appear. In the API package's ESLint config, restrict direct `ROLE_DEFAULTS` imports to `PermissionService`:
>    ```js
>    // eslint.config.js (or .eslintrc) — apps/api
>    'no-restricted-imports': ['error', {
>      paths: [{
>        name: '@skaly/shared',
>        importNames: ['ROLE_DEFAULTS'],
>        message: 'Import permissions via PermissionService.getEffectivePermissions — ROLE_DEFAULTS is the floor, not the answer (Auth-Matrix §6.1).'
>      }]
>    }]
>    ```
>    Add the narrow override that permits it inside `PermissionService.ts` only. Verify `pnpm lint` passes and that removing the exemption makes it fail (prove the guard works).
>
> 4. **Frontend note:** the sidebar reads `/staff/me` via TanStack Query, so after an admin changes a permission the affected user's UI updates on next refetch/reload (the override endpoint already busts the Redis cache server-side). That's acceptable — do **not** build a push mechanism here. Leave a comment: `// Sprint 10 may push a permission-changed event; until then the sidebar refreshes on refetch.`
>
> **RULES**
>
> - No shim, no deprecation period — one import path.
> - `/v1/staff/me`'s response **shape** is unchanged; only values are corrected.
>
> Show me the repointed call sites, the deletion, and the working lint guard.

**Verify:**

```bash
pnpm --filter @skaly/api test && pnpm typecheck && pnpm lint
ls apps/api/src/lib/permissions.ts 2>/dev/null && echo "STILL PRESENT — delete it" || echo "retired ✓"
grep -rn "ROLE_DEFAULTS" apps/api/src | grep -v PermissionService   # expect: no hits
```
`▶ /ponytail` — one implementation, one import path, guard proven.

---

## STEP 4: Deterministic denial copy in the system prompt

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 8.1, STEP 4. Fixing Defect 2: the canned refusal at `BotService.ts:40` is near-unreachable because `getPermittedBotTools` strips unpermitted tools before the model sees them — so denial is currently improvised. Read `docs/04-APPFLOW.md` §9 (the exact copy + the never-state-the-role constraint), `docs/09-ERROR-HANDLING.md` §6, and `docs/02-TRD.md` §9.1 (system prompt contents). `getPermittedBotTools` now returns `{ permitted, denied }` (STEP 2).
>
> **WHAT TO BUILD**
>
> 1. **Extend `buildSystemPrompt`** to accept the denied tool list and emit a denial section **only when `denied.length > 0`** (omit entirely otherwise — no wasted tokens, no invited confusion). Render each denied tool as a **short human-readable capability** derived from its registry `description` (e.g. `get_attendance` → "viewing attendance records"), not the raw tool name.
>
>    The section, appended after the existing anti-hallucination directive:
>    ```
>    TOOL ACCESS
>    This user does not have access to the following capabilities: <comma-separated capability phrases>.
>
>    If the user asks for something that would require one of these, reply with exactly this
>    sentence and nothing more:
>    "I don't have permission to [action] on your behalf. Ask an admin to update your bot access settings."
>    Replace [action] with a short description of what they asked for.
>
>    Never state which role or permission level is required. Never explain why access is denied.
>    Never attempt a different tool to work around it.
>
>    This applies only to the capabilities listed above. If the user asks about something the
>    portal does not cover at all, say you can't help with that instead — do not use the
>    permission sentence.
>    ```
>
> 2. **Pass `denied` through** from `BotService.handleMessage` — it already calls `getPermittedBotTools`; feed both halves in (permitted → the Anthropic `tools` array, denied → the prompt).
>
> 3. **Keep `BotService.ts:40` unchanged** as the backstop for a hallucinated tool name, and update its comment to say exactly that: `// Backstop only — unpermitted tools are filtered before the model sees them; the normal denial path is the system prompt's TOOL ACCESS section (Sprint 8.1).`
>
> **RULES**
>
> - The final-sentence copy is verbatim from Error-Handling §6 / APPFLOW §9. Do not paraphrase it in the prompt.
> - The last paragraph is load-bearing: it stops the bot from giving a *permission* refusal to an out-of-scope question ("what's the weather"), which would be both wrong and confusing.
> - Denial enumeration must stay short — capability phrases, not sentences. A freelancer has ~10 denied query tools; keep that under ~120 tokens.
>
> Show me the extended `buildSystemPrompt` and the `handleMessage` wiring.

**Verify:**

```bash
pnpm --filter @skaly/api test services/BotService
pnpm typecheck
```
`▶ /ponytail` — review the prompt text against the canonical copy word-for-word.

---

## STEP 5: Tests + correct the Sprint 8 E2E assertion

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 8.1, STEP 5. Both fixes in. Now the tests — including a correction to a Sprint 8 spec that could not have been passing honestly.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/test/services/PermissionService.test.ts` — additions for Defect 1:**
>    - **The reported bug, as a test:** an admin sets `bot.tool.get_attendance = false` for a team_member → `getEffectivePermissions` returns `false` for that key. (Before the fix this returned the role default `true`.)
>    - **The revoking direction specifically** (the security-relevant one): a key whose role default is `true`, overridden to `false`, is `false` in the effective map.
>    - The granting direction: default `false` + override `true` → `true`.
>    - The effective map covers **all** key families, not just `bot.tool.*` — assert a `module.*` and `chat.access` key are present.
>    - Cache miss reads through to DB; Redis-down falls to DB then floor; override endpoint busts the cache (these exist from Sprint 8 — confirm still green).
>    - `getPermittedBotTools` returns `permitted` + `denied` that are complementary and together equal the full tool registry.
>
> 2. **`apps/api/test/routes/staff.test.ts` — the end-to-end symptom:**
>    - Set an override via `PUT /v1/staff/:id/permissions/:key { value: false }` as admin → `GET /v1/staff/me` as that user reflects `false`. **This is the exact bug reported; it must fail without the fix.**
>    - The `/v1/staff/me` response **shape** is unchanged (assert the same keys the frontend consumes).
>
> 3. **`apps/api/test/services/BotService.test.ts` — Defect 2 (deterministic half):**
>    - `buildSystemPrompt` with a non-empty `denied` list contains the verbatim refusal sentence **and** the never-state-the-role constraint.
>    - With an empty `denied` list, the `TOOL ACCESS` section is **absent**.
>    - Denied capabilities render as readable phrases, not raw tool names.
>    - `handleMessage` passes only `permitted` into the Anthropic `tools` array (denied tools never reach the model) — regression-guards the filter that made the backstop unreachable.
>
> 4. **Correct the Sprint 8 STEP 9.1 E2E assertion.** The existing spec ("ask an attendance question → assert the 'Ask your admin' refusal") assumes deterministic copy the model was never instructed to produce — it could only pass mocked or with a loose matcher. Now that the prompt mandates the sentence, make it honest but non-brittle:
>    - Keep the **deterministic** contract in the unit test above (the prompt contains the copy).
>    - In `tests/e2e/bot.spec.ts`, assert a **case-insensitive substring** (`/ask an admin/i`) rather than the full sentence, and add a comment that model output is probabilistic — the prompt contract is what's strictly tested.
>    - Add the complementary assertion that matters most: the reply **does not** name a role — `expect(text).not.toMatch(/\b(admin|manager|team.member|freelancer)\s+(role|permission|access|level)/i)` — enforcing APPFLOW §9's constraint.
>
> **RULES**
>
> - Each test must fail without its corresponding fix. If a test passes on `main`, it isn't testing the defect.
> - Don't assert exact model prose in E2E; assert the prompt contract deterministically and the output loosely.
>
> Show me the `/staff/me` override test and the corrected E2E assertions first, then run everything.

**Verify:**

```bash
pnpm --filter @skaly/api test        # full API suite green
pnpm --filter @skaly/web test
pnpm typecheck && pnpm lint
```
`▶ /ponytail` — confirm each new test fails on `main` and passes here.

---

## STEP 6: Verify, commit, close-out (manual)

### 6.1 — Manual confirmation

```bash
docker compose up -d && pnpm dev
```

1. **Defect 1, by hand:** as admin, `PUT /v1/staff/:teamMemberId/permissions/bot.tool.get_attendance { value: false }` → log in as that team_member → `GET /v1/staff/me` now reports `false` for that key, and the sidebar/capability UI matches. Re-grant → reflects `true` after refetch.
2. **Defect 2, by hand (dev-Haiku key):** as that same team_member, ask the bot "what's my attendance this month?" → the reply contains the canonical refusal and **names no role**. Ask something out of portal scope ("what's the weather?") → a plain can't-help answer, **not** the permission sentence (proves the last prompt paragraph works).
3. **No regression:** an admin asks the same attendance question → gets a real attendance card.

### 6.2 — Close-out checklist

```
DEFECT 1 — permission consolidation
  [ ] STEP 1 audit complete; every getEffectivePermissions caller classified
  [ ] Any enforcement-side caller identified and called out in the commit message
  [ ] No ROLE_DEFAULTS reads outside PermissionService
  [ ] One override loader, one precedence merge (loadOverrides + getEffectivePermissions)
  [ ] resolvePermission + getPermittedBotTools delegate; Sprint 8 tests green unmodified
  [ ] getPermittedBotTools returns { permitted, denied }; BotService call site updated
  [ ] /v1/staff/me reflects overrides; response SHAPE unchanged (TESTED)
  [ ] lib/permissions.ts deleted — no shim, no second import path
  [ ] ESLint no-restricted-imports guard active and proven to fire

DEFECT 2 — deterministic refusal
  [ ] buildSystemPrompt emits TOOL ACCESS only when denied.length > 0
  [ ] Verbatim canonical sentence + never-state-the-role constraint present
  [ ] Denied tools rendered as capability phrases, not raw names
  [ ] Out-of-scope paragraph present (no permission copy for non-portal questions)
  [ ] Denied tools never reach the Anthropic tools array (TESTED)
  [ ] BotService.ts:40 retained as backstop; comment corrected
  [ ] Sprint 8 STEP 9.1 E2E corrected: substring match + no-role-named assertion

BOTH
  [ ] Every new test fails on main, passes here
  [ ] pnpm typecheck + lint + full suite green
  [ ] /ponytail run at each Verify gate
```

### 6.3 — Commit

```bash
git add -A
git commit -m "Sprint 8.1: consolidate permission resolution onto PermissionService (single Auth-Matrix §6 implementation); make bot denial copy deterministic via system prompt"
git push -u origin sprint-8.1-permission-consolidation
```

> If STEP 1 found an **enforcement** caller, amend the message to lead with that: `fix: revoking permission overrides were ignored at <site>` — it's a security correction, not a cosmetic one.

Open the PR to `main`; CI green before merge. Merge, then `git checkout main && git pull`.

### 6.4 — Back to Sprint 9

Both defects are now closed and the Sprint 9 surfaces that would have inherited them are clean:

- **Mutation gating** reads one resolver — `update_task_status` (🔧, default OFF for team_member) resolves identically for the bot, the REST layer, and `/staff/me`.
- **The denial path is deterministic** — which matters because for team members it is the *default* path in Sprint 9, not an edge case.
- **Search scope filtering** (M-05) can build on `getEffectivePermissions` without inheriting a second implementation.

The pre-Sprint-9 decisions from `SPRINT-8-DETAILED.md` are unchanged and still stand: the two-turn confirmation as a **server-side state machine** (pending `{ toolName, input, summary }` in the Redis session so turn 2's "yes" maps to the exact stored call, never a re-parse), mutation tools reusing mutating service methods with 423/409/403 passthrough as friendly copy, role-filtered search, and `update_calendar_cell` routing through `updateCell` so the `source='manual'` auto-reset + version bump (ADR-013 case 2) still apply.

---

## TROUBLESHOOTING

### `/v1/staff/me` returns the right values but the sidebar still shows the old capability
TanStack Query cache. The server is correct; the client refetches on next mount/invalidate. Expected — don't build a push mechanism (Sprint 10 may add a permission-changed event).

### Sprint 8's `resolvePermission` tests break during STEP 2
The refactor changed behavior, not just structure. Those tests are the contract — revert and re-extract so they pass **unmodified**. If a test genuinely encoded the old duplicate logic, that's a different problem: say so rather than editing it to fit.

### The lint guard fires inside `PermissionService`
The narrow exemption isn't scoped correctly. Allow the import for that file only (an `overrides`/`files` block), not for the whole `services/` directory.

### The bot now refuses things it should answer
The denied list is over-broad — likely `denied` is being computed against every tool in the registry including mutation tools that don't exist yet, or the capability phrases are vague enough that the model pattern-matches too eagerly. Narrow the phrases and confirm `permitted + denied` equals exactly the **query** tool set in Sprint 8.

### The bot gives the permission refusal for out-of-scope questions
The final prompt paragraph is missing or too weak. It must explicitly distinguish "denied capability" from "not a portal question."

### The E2E refusal assertion is still flaky
You're matching the full sentence. Match `/ask an admin/i` and keep the strict wording assertion in the unit test on `buildSystemPrompt`, where it's deterministic.

---

## END OF SPRINT 8.1 PATCH GUIDE

*Companion to `SPRINT-8-DETAILED.md`. Both defects were found at Sprint 8 STEP 9 and are fixed before Sprint 9's mutation tools and search build on top of them. Source-of-truth precedence unchanged: numbered spec docs + schema, then the ADR series, then Master Build Guide shorthand.*
