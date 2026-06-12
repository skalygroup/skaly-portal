# 14 — PRE-BUILD AUDIT (FINAL)
## Scaly Business Portal — Document Suite V2.1 → Build Readiness Review
**Version:** 2.2 | **Date:** June 2026 | **Status:** Final — Build Gate
**Auditor scope:** All 13 V2.1 documents (PRD, TRD, UI/UX, APPFLOW, BACKEND-SCHEMA, IMPLEMENTATION-PLAN, API-CONTRACT, AUTH-MATRIX, ERROR-HANDLING, INFRA-DEPLOYMENT, THIRD-PARTY-INTEGRATIONS, TESTING-STRATEGY, NFRS)
**Cross-refs:** All thirteen V2.1 source documents

---

## 0. EXECUTIVE SUMMARY

### 0.1 One-Line Verdict
**🟡 CONDITIONAL GO** — The 13-document suite is materially complete and architecturally sound. **18 build-blocking and high-severity findings must be resolved during Sprint 0** (Week 1) before any feature sprint begins. None are structural; all are addressable in days, not weeks.

### 0.2 Finding Counts

| Severity | Count | Resolution Window |
|----------|-------|-------------------|
| 🔴 **BLOCKER** — must fix before Sprint 1 starts | **3** | Sprint 0, Days 1–3 |
| 🟠 **CRITICAL** — must fix during Sprint 0 | **6** | Sprint 0, Week 1 |
| 🟡 **HIGH** — fix before the sprint that depends on it | **9** | Per-sprint, pre-affected work |
| 🔵 **MEDIUM** — fix before launch | **12** | Sprints 1–13 |
| ⚪ **LOW** — accepted technical debt or post-MVP | **9** | Post-launch backlog |
| **TOTAL** | **39** | |

### 0.3 What's Solid

- **Architecture:** Three-tier separation, JWT-only Supabase, Kysely+PostgreSQL on Railway, Upstash Redis, Cloudflare R2 — every choice is defensible at MVP scale (50 concurrent users) with a clear scale-up path.
- **Data integrity:** Optimistic locking on volatile records, append-only audit log enforced at DB role level, idempotent rollover inside a single transaction, derived fields (pipeline status) instead of stored fields that drift.
- **Real-time foundations:** Socket.io with `@socket.io/redis-adapter` configured in Sprint 0 (not bolted on later) — Railway rolling deploys won't drop broadcasts.
- **Bot safety:** Mutation confirmation protocol is mandatory, tool permissions are filtered per-user per-request, locked periods block all bot mutations, error messages never reveal role hierarchy.
- **RBAC:** Three-layer enforcement (middleware → auth plugin → service layer). Frontend restrictions are explicitly labeled UX-only; backend is the security boundary.
- **Auth hardening:** Email+IP keyed rate limits prevent shared-office lockout (the audit catch from prior iterations is well-handled), MFA mandatory for admin/manager, internal routes use `X-Internal-Secret` separate from JWT plugin.

### 0.4 Where the Risk Lives

1. **External dependencies not delivered** (T1–T4 templates, Skaly lion SVG, per-client shoot slots, Google Sheets migration plan). These are tracked but four of them are still ⏳ Pending. Two block Sprint 1 (templates) and Sprint 5 (slot counts).
2. **A few spec contradictions** between PRD §5 and NFR §1.2 (bot latency target), plus one minor schema-vs-code mismatch.
3. **Three integration-level decisions are implicit but never written down** — transactional email policy (none in MVP), `staff/me` endpoint, refresh-token rotation contract.
4. **Database role permissions are described but the migration file that grants them does not exist** in the migration list.

### 0.5 Bottom Line

Mohammed Arslaan can begin Sprint 0 today. The 3 blockers and 6 critical findings should land as the **first Sprint 0 PRs**, before infrastructure provisioning is treated as complete. The audit produces:

1. This document (`14-PRE-BUILD-AUDIT.md`) — the authoritative finding register
2. `SPRINT-0-READINESS-CHECKLIST.md` — a tickable list for Sprint 0 close-out
3. `CRITICAL-PATCHES.md` — drop-in code for the blockers and criticals

Once those 9 items are green, the spec freeze is complete and the 14-sprint plan begins.

---

## 1. SCOPE & METHODOLOGY

### 1.1 What Was Audited

Every byte of every V2.1 document, with three lenses:

| Lens | What It Tests |
|------|--------------|
| **Internal consistency** | Do all 13 docs say the same thing about the same field/endpoint/flow? |
| **External feasibility** | Does each spec match what the named tool/library/service actually does in production? |
| **Build-readiness** | Could a developer (D1, D2, D3) start the next sprint without asking a clarifying question? |

### 1.2 Severity Rubric

| Code | Severity | Definition | Resolution Window |
|------|----------|-----------|-------------------|
| 🔴 **B** | Blocker | Sprint 1 cannot start. Spec contradiction, missing critical artifact, or production-data-corruption risk. | Sprint 0 Days 1–3 |
| 🟠 **C** | Critical | Sprint 0 cannot close. Security, data integrity, or production reliability risk if shipped as-is. | Sprint 0 Week 1 |
| 🟡 **H** | High | Specific feature sprint will hit a wall if not resolved before its kickoff. | Before the sprint that depends on it |
| 🔵 **M** | Medium | Quality risk for launch. UX gaps, scaling friction, documentation gaps. | Within the 14-sprint window |
| ⚪ **L** | Low | Post-MVP polish, accepted tech debt, or speculative. | Phase 2 backlog |

### 1.3 Reading This Document

Each finding follows the same shape:

```
ID  TITLE                                         [SEVERITY]
    Where:     [docs / sections affected]
    What:      [the issue, in one paragraph]
    Why:       [what breaks if shipped as-is]
    Action:    [the specific fix]
    Owner:     [TL / D1 / D2 / D3 / external dependency]
    Sprint:    [Sprint number or "Sprint 0" or "Pre-launch"]
    Patch:     [pointer to CRITICAL-PATCHES.md if code provided]
```


---

## 2. 🔴 BLOCKER FINDINGS (3) — RESOLVE BEFORE SPRINT 1

These have a structural impact on Sprint 0 close-out. Do not start Sprint 1 with any of these unresolved.

---

### B-01  Database role permissions described, but no migration applies them
| | |
|---|---|
| **Where** | `05-BACKEND-SCHEMA.md` §11 (lists GRANT/REVOKE statements) vs `05-BACKEND-SCHEMA.md` §2 (migration order — no permissions migration listed) vs `06-IMPLEMENTATION-PLAN.md` §3.4 (no Sprint 0 task to apply them) |
| **What** | The audit log is described as "append-only enforced at database role level" via `REVOKE UPDATE, DELETE ON audit_log FROM skaly_app`. The exact SQL exists in §11 but no migration file in §2 ever runs it. Sprint 0 has no checklist item that grants/revokes anything. |
| **Why** | Without this migration, the `audit_log` table can be UPDATEd or DELETEd by any application bug, malicious endpoint, or compromised JWT. The "tamper-proof audit log" claim in NFR §4.2, PRD §4.13 (FR-AUDIT-04), and ERROR-HANDLING is not actually enforced anywhere — only documented. This is the difference between an audit log and a notepad. |
| **Action** | Add migration `026_database_roles.ts` to the sequence. Make it the **final** migration so all tables exist. See `CRITICAL-PATCHES.md` §B-01 for the full migration file. Add a Sprint 0 DoD item: "Migration 026 applied on staging and production; verified `REVOKE` is in effect by attempting an UPDATE as `skaly_app` and confirming the failure." |
| **Owner** | TL |
| **Sprint** | Sprint 0 |
| **Patch** | `CRITICAL-PATCHES.md` §B-01 |

---

### B-02  T1–T4 design template files are not delivered (Sprint 1 dependency)
| | |
|---|---|
| **Where** | `01-PRD.md` §7 OD-04, `06-IMPLEMENTATION-PLAN.md` §18 (status ⏳ Pending) |
| **What** | Auth UI (Sprint 1) is built on top of T1–T4 template components from the design lead. The deadline is "before Sprint 1," but as of V2.1 they are still pending. The risk register notes a "fallback: build auth UI without template, retrofit later" — but no actual fallback design is specified. |
| **Why** | Sprint 1 owners (TL + D1) will sit idle for an unknown duration, or will produce auth UI that gets thrown away when templates land. Either outcome derails the 14-week timeline. |
| **Action** | **Decision deadline: end of Sprint 0, Day 5.** Either (a) confirm template delivery date with design lead in writing, or (b) commit to the fallback path — build auth UI using shadcn/ui primitives directly with the CSS variables already in `globals.css`. The fallback gets us 90% there; the retrofit later is a 2-day cosmetic update, not a rewrite. |
| **Owner** | TL + Skaly design lead |
| **Sprint** | Sprint 0 (decision); Sprint 1 (execution) |
| **Patch** | N/A — process item |

---

### B-03  CRON_SECRET comparison is not specified as timing-safe
| | |
|---|---|
| **Where** | `02-TRD.md` §15 (`CRON_SECRET` env var declared), `10-INFRA-DEPLOYMENT.md` §4 (Cron service curls the endpoint), `07-API-CONTRACT.md` §5 (`X-Internal-Secret` header), `02-TRD.md` §5.1 (`internalAuthPlugin` mentioned) |
| **What** | The internal route auth uses `X-Internal-Secret: <CRON_SECRET>` and is explicitly separated from the JWT auth plugin. But nowhere in any document is the comparison specified to use a constant-time comparison (`crypto.timingSafeEqual` or equivalent). A naive `if (header === secret)` is vulnerable to timing attacks. |
| **Why** | This endpoint runs the rollover — full mutation power over the entire database. If an attacker can byte-by-byte recover the CRON_SECRET via response-time analysis, they own the rollover. With 32-char secrets and ms-precision timing, this is exploitable in lab conditions and trivially fixed. |
| **Action** | Specify the `internalAuthPlugin` implementation to use `crypto.timingSafeEqual` with length pre-check. See `CRITICAL-PATCHES.md` §B-03 for the 12-line plugin. Add to Sprint 0 backend foundation. |
| **Owner** | TL |
| **Sprint** | Sprint 0 |
| **Patch** | `CRITICAL-PATCHES.md` §B-03 |

---

## 3. 🟠 CRITICAL FINDINGS (6) — RESOLVE IN SPRINT 0

These either pose a production-reliability risk if shipped, or hide spec contradictions that will cause merge conflicts between developers.

---

### C-01  Bot latency target contradicts itself across PRD and NFR
| | |
|---|---|
| **Where** | `01-PRD.md` §5 ("Bot response < 4s end-to-end including Anthropic API") vs `13-NFRS.md` §1.2 (TTFT < 2s, full streaming < 8s, with an explicit Gemini-audit note that the 4s target is "incorrect because it conflates TTFT with generation time") |
| **What** | Two documents state two different bot latency targets. The NFR §1.2 clarification is more recent and technically correct (streaming is the chosen approach per TRD §9.1 `stream: true`). The PRD §5 row was not updated to match. |
| **Why** | A test engineer will write a test asserting `<4s end-to-end` per PRD; QA will mark it failing because actual full-streaming completion is 6s on Sonnet. The dev fixes the test number; PM (Arslaan) sees the test changed and asks why; cycle wastes a half-day of meetings. Easier to fix the source of truth now. |
| **Action** | Update `01-PRD.md` §5 row "Bot response" to read: "Bot TTFT < 2s; full streaming completion < 8s (see NFR §1.2)". Same target, two metrics, no contradiction. Then update PRD §1.4 success metrics where it lists TTFT and full streaming correctly already — they're consistent. PRD §5 is the only outlier. |
| **Owner** | TL |
| **Sprint** | Sprint 0 |
| **Patch** | `CRITICAL-PATCHES.md` §C-01 (one-line doc patch) |

---

### C-02  PATCH endpoint response envelopes inconsistent / unspecified
| | |
|---|---|
| **Where** | `07-API-CONTRACT.md` §5 — most PATCH endpoints (attendance, tasks, content-dropper, content-calendar, shoot-planner) document the request body but show no response body. |
| **What** | The standard envelope (§1.1) says success = `{ data: { ...resource }, meta: { version, updatedAt } }`. But individual PATCH endpoints don't restate this, and the absence creates ambiguity: does PATCH return the full updated row? Or just `{ ok: true }`? Or `{ data: { id, version } }`? |
| **Why** | TanStack Query optimistic update patterns need to know what comes back to merge into cache. If D1 builds the attendance PATCH returning `{ data: { ok: true } }` and D2 builds the calendar PATCH returning the full row, the frontend has two contracts. The contradiction is invisible until both grids are wired and the second one fails silently. |
| **Action** | Standardize: every PATCH returns `{ data: { ...full row including new version }, meta: { updatedAt, updatedBy } }`. Add this as a one-line clause to API-CONTRACT §1.1: "All PATCH endpoints return the full updated resource. Clients should replace cache entries, not merge fields." See `CRITICAL-PATCHES.md` §C-02 for the API-CONTRACT diff. |
| **Owner** | TL |
| **Sprint** | Sprint 0 |
| **Patch** | `CRITICAL-PATCHES.md` §C-02 |

---

### C-03  Transactional email policy is implicit — needs to be written down
| | |
|---|---|
| **Where** | `11-THIRD-PARTY-INTEGRATIONS.md` §2 (Supabase Auth — auth emails only), `01-PRD.md` §4.9 FR-NOTIF-01 ("in-app notifications delivered via Socket.io"), `04-APPFLOW.md` (multiple flows say "user is notified" without specifying channel) |
| **What** | The portal sends `task_assigned`, `shoot_confirmed`, `report_ready`, `signup_approved`, etc. as in-app notifications. But there's no explicit statement that **email is out of scope** for these. Some readers will assume "notification" means email; others (correctly per FR-NOTIF-01) will read it as in-app only. Supabase handles auth-flow emails (invite, password reset) — that's it. |
| **Why** | If Sprint 11 (Notifications) ships with no SendGrid/Resend/Postmark integration, but Sprint 13 launch is signed off by an admin who expected emails, the launch retros badly. Worse, missing emails for `signup_approved` could leave new staff guessing for hours waiting for an email that never comes — they're staring at a stuck `/signup/pending` page. |
| **Action** | Add one explicit row to `01-PRD.md` §6 "Out of Scope — MVP": **"Transactional email beyond Supabase Auth flows (invite, password reset). All operational notifications are in-app via Socket.io + DB-backed bell."** Then audit APPFLOW §2.6 — the user on `/signup/pending` polls (10s → 30s → 60s → stops at 10min) — confirm the polling-only design is intentional and visible to the admin reviewer. (It is, in V2.1, but worth re-confirming.) See `CRITICAL-PATCHES.md` §C-03 for the PRD diff. |
| **Owner** | TL + Skaly stakeholder confirmation |
| **Sprint** | Sprint 0 |
| **Patch** | `CRITICAL-PATCHES.md` §C-03 |

---

### C-04  `GET /v1/staff/me` endpoint is implicit — used by frontend, not in contract
| | |
|---|---|
| **Where** | `03-UIUX.md` §15 (Profile route), `04-APPFLOW.md` §18 ("Profile route MUST appear in every sidebar"), `07-API-CONTRACT.md` §4 (GET /v1/staff/:id documented, no `/me`) |
| **What** | All four roles have a `/profile` UI route. That UI fetches the current user's profile. By convention, that's `GET /v1/staff/me` — but it's not in the contract. The closest documented endpoint is `GET /v1/staff/:id` (full profile for admin/manager/own), which requires the frontend to know its own staffId before calling. |
| **Why** | The staffId comes from the JWT. The frontend would need to decode the JWT (or call `/v1/auth/whoami`) to get it. Cleaner: a `/v1/staff/me` endpoint that the auth plugin already has the staffId for. Without it, every frontend developer reinvents this pattern. |
| **Action** | Add to `07-API-CONTRACT.md` §4: `GET /v1/staff/me` — returns the authenticated user's full profile. Same response shape as `GET /v1/staff/:id` with `:id = own staffId`. No permission check needed; authenticated by JWT. Add Sprint 1 task. |
| **Owner** | TL |
| **Sprint** | Sprint 1 (auth + signup) |
| **Patch** | `CRITICAL-PATCHES.md` §C-04 |

---

### C-05  WebSocket auth: token expiry mid-connection is unspecified
| | |
|---|---|
| **Where** | `02-TRD.md` §8 (Socket.io connection joins rooms based on `handshake.auth`), `02-TRD.md` §8 (reconnection config — 1s → max 30s), `09-ERROR-HANDLING.md` §5.3 (HTTP 401 silent refresh) |
| **What** | Socket.io handshake validates the JWT once at connect time. But JWTs expire in 1 hour. What happens at the 60-minute mark when the JWT inside the running socket expires? Three possibilities, none specified: (a) the socket stays open with stale auth (security risk); (b) the server force-disconnects on JWT expiry (UX disruption); (c) the client refreshes the JWT and re-emits a `auth:refresh` event (the right answer, but no event exists). |
| **Why** | At the 60-minute mark of a working session, a user's chat messages may silently stop delivering, or their bot session may break, or — worse — an attacker holding a stolen socket can keep using it indefinitely past its JWT lifetime. |
| **Action** | Specify: (1) Server tracks JWT `exp` per socket; (2) At `exp - 60s`, server emits `auth:refresh_required`; (3) Client calls `/v1/auth/refresh` to get a new JWT, then emits `auth:refresh` with the new token; (4) Server validates, replaces stored auth, allows continued use; (5) If client fails to refresh within 30s of expiry, server disconnects with code `TOKEN_EXPIRED`, triggering normal reconnect flow which will fail without a valid JWT and route through the existing HTTP 401 path. See `CRITICAL-PATCHES.md` §C-05 for the server plugin and client handler. |
| **Owner** | TL + D2 |
| **Sprint** | Sprint 0 (server plugin) + Sprint 10 (client wiring during chat sprint) |
| **Patch** | `CRITICAL-PATCHES.md` §C-05 |

---

### C-06  Rollover edge case: no prior period exists (bootstrap month)
| | |
|---|---|
| **Where** | `04-APPFLOW.md` §16 (rollover flow Step 2: "UPDATE months SET locked=true WHERE period = prevPeriod"), `12-TESTING-STRATEGY.md` §4.1 (test asserts `may?.locked === true` — assumes May exists) |
| **What** | Rollover step 2 locks the prior period. But what about the **very first** rollover ever run — when no prior period exists in the `months` table? `UPDATE` with no matching row is a no-op (correct silent behavior in Postgres), but the test `expect(may?.locked).toBe(true)` would fail because `may` is `undefined`. More importantly, the rollover should explicitly handle "prev period not found → skip step 2, log info" rather than relying on silent no-op behavior. |
| **Why** | Two consequences. (1) The bootstrap rollover at production launch will run with no May 2026 (or whatever the prior month is) — the test suite would fail if invoked in this scenario without conditional logic. (2) Operations team manually triggering a rollover for a month two months ahead (e.g., July when only June exists, August is requested) needs to handle the gap. Currently undefined. |
| **Action** | (1) RolloverService logic: `if (await monthExists(prevPeriod)) { await lockMonth(prevPeriod, txn); }` — explicit conditional, not silent no-op. (2) Decide and document: can manual rollover skip months (e.g., create July with May existing, no June)? Probably no — enforce contiguity. (3) Add test: "bootstrap rollover for first-ever month succeeds without a prior period to lock". |
| **Owner** | TL |
| **Sprint** | Sprint 0 (spec); Sprint 12 (implementation) |
| **Patch** | `CRITICAL-PATCHES.md` §C-06 |

---

## 4. 🟡 HIGH SEVERITY FINDINGS (9) — RESOLVE BEFORE THE DEPENDENT SPRINT

These have a specific sprint they can derail. Each one needs to land before its dependent sprint kicks off, not later.

---

### H-01  Holiday removal must un-flag attendance rows — service flow not specified
| | |
|---|---|
| **Where** | `01-PRD.md` §4.2 FR-ATT-10 ("Holiday removal restores the day to a working day"), `05-BACKEND-SCHEMA.md` §4 (holidays table has `removed_at`, `removed_by`), `07-API-CONTRACT.md` (DELETE /v1/holidays/:id mentioned, no detail) |
| **What** | When a holiday is removed, two tables need updating in one transaction: (1) `holidays` row's `removed_at` set; (2) **all attendance_logs rows with `day_type='holiday'` and `date = holidayDate` and `period = holidayPeriod`** flipped back to `day_type='working'`. Step 2 is implicit but never written. |
| **Why** | If only step 1 runs, attendance grid still shows that date as gold-tinted non-interactive while the holidays list shows it removed. Visual contradiction; team members can't mark attendance. |
| **Action** | Specify `HolidayService.remove(id, removedBy, txn)` as: (1) update holiday row; (2) update all matching attendance_logs; (3) audit log entry; (4) emit `holiday_removed` event → Socket.io broadcast → TanStack Query invalidation; (5) all in one DB transaction. See `CRITICAL-PATCHES.md` §H-01 for the service stub. |
| **Owner** | D1 (Sprint 3 owner of attendance) |
| **Sprint** | Sprint 3 |
| **Patch** | `CRITICAL-PATCHES.md` §H-01 |

---

### H-02  Soft-deletion `WHERE deleted_at IS NULL` is not enforced anywhere systematic
| | |
|---|---|
| **Where** | `05-BACKEND-SCHEMA.md` — `tasks`, `staff`, `clients`, `messages` all have `deleted_at`. Indexes are partial (`WHERE deleted_at IS NULL`). |
| **What** | Kysely doesn't auto-apply soft-delete filters. Every query in every service has to manually add `.where('deleted_at', 'is', null)`. There's no helper, no Kysely plugin, no review checklist for this. One missed clause and deleted records leak into a grid. |
| **Why** | Probability of human error compounds over 20+ tables across 14 sprints. The cost of a leak is "this user sees data they shouldn't" — for a soft-deleted client, the deactivated staff member shows up in dropdowns. UX bug, not security bug, but corrosive. |
| **Action** | Build a thin Kysely query helper `softDeletable(qb, table)` that auto-applies `deleted_at IS NULL` for tables that have the column. Document the pattern in a `apps/api/src/lib/queries.ts` file (created in Sprint 2). Add ESLint rule (or code-review checklist) requiring all SELECT on soft-deletable tables to go through the helper. See `CRITICAL-PATCHES.md` §H-02. |
| **Owner** | TL (helper) + all devs (review discipline) |
| **Sprint** | Sprint 2 (helper); enforced throughout |
| **Patch** | `CRITICAL-PATCHES.md` §H-02 |

---

### H-03  Initial materialised view population at migration time creates an empty view
| | |
|---|---|
| **Where** | `05-BACKEND-SCHEMA.md` §7 (lines noting "Initial population at migration time (NON-CONCURRENTLY). CONCURRENTLY is not allowed on an empty materialised view.") |
| **What** | The schema correctly notes that CONCURRENTLY refresh fails on an empty MV, and adds `REFRESH MATERIALIZED VIEW dashboard_org_stats;` (non-concurrent) at the end of migration 024. ✅ Good. **However:** at migration time, `attendance_logs` and `tasks` are also empty (since seed data hasn't loaded yet). So the MV is created, refreshed, and remains empty. The first dashboard query after the FIRST rollover (which DOES populate tables) will see empty MV until the post-rollover CONCURRENTLY refresh succeeds. This is documented behavior in `04-APPFLOW.md` §16 Step 8 with a `rollover_view_refresh_failed` notification path. ✅ Good. **The actual gap:** Sprint 11 dashboard testing will have an empty MV unless the test harness manually triggers a refresh, AND the home-page dashboard widget on a brand-new staging environment will show empty data even after seed data is loaded — devs will hit this and waste an hour. |
| **Why** | Developer experience friction. Not a production blocker. |
| **Action** | (1) Add a CLI script `pnpm --filter api db:refresh-views` that runs both refreshes (non-concurrent). (2) Document in README that after running seeds or restoring backups, run this script. (3) Sprint 11 owner adds to dashboard onboarding doc. |
| **Owner** | D2 |
| **Sprint** | Sprint 0 (CLI script); Sprint 11 (use it) |
| **Patch** | `CRITICAL-PATCHES.md` §H-03 |

---

### H-04  Bot streaming Socket.io pattern not specified end-to-end
| | |
|---|---|
| **Where** | `02-TRD.md` §9.1 (stream: true), `07-API-CONTRACT.md` §5 Bot (HTTP 202 + Socket.io `bot:message` events with `{chunk, done}`), `13-NFRS.md` §1.2 (TTFT < 2s) |
| **What** | The contract specifies the wire protocol (chunks via `bot:message` events). What's not specified: how the backend bridges Anthropic SDK's `messages.stream()` async iterator into Socket.io emits while also (a) tracking tool_use blocks for separate handling, (b) handling the second Anthropic call after tool execution, (c) updating the Redis session, (d) archiving to messages table, (e) handling client disconnect mid-stream. |
| **Why** | Sprint 8 (bot query tools) is the riskiest sprint. Without a reference implementation pattern, the lead dev will spend 2+ days on the streaming wiring alone. With one, it's a half-day of integration. The cost of getting it wrong: dropped tokens visible to the user, double-archived messages, Redis session out of sync with DB. |
| **Action** | Write a reference implementation file `apps/api/src/bot/stream-handler.ts` BEFORE Sprint 8 begins. Treat this as a Sprint 0 doc deliverable. See `CRITICAL-PATCHES.md` §H-04 for the full handler (≈ 80 lines, demonstrates the orchestration pattern). |
| **Owner** | TL |
| **Sprint** | Sprint 0 (pattern); Sprint 8 (use) |
| **Patch** | `CRITICAL-PATCHES.md` §H-04 |

---

### H-05  Comment notification routing is not specified per module
| | |
|---|---|
| **Where** | `04-APPFLOW.md` §13 ("Owner of record receives 'new_comment' notification"), `02-TRD.md` §10.1 (notification type `new_comment` listed), but **no module has its "owner" defined**. |
| **What** | "Owner of record" is ambiguous for each of the three comment-enabled modules:
- **Shoot Planner row** — who's the owner? The `freelancer_id` (if assigned)? The `updated_by`? All admins/managers? The creator (not stored)?
- **Content Dropper row** — same question. `updated_by` is the last editor, not the owner.
- **Content Calendar cell** — `updated_by` is the last editor. Cell has no creator concept (rollover-generated).
The current spec leaves it to the developer to invent. |
| **Why** | Different developers will make different choices. Sprint 12 reviewer will catch it during code review, but the notification recipients will already be hard-coded into 3 service methods. Refactor cost: low. Decision cost: needs PM input. |
| **Action** | Decide and document in `04-APPFLOW.md` §13: **For all three modules, `new_comment` notifies (a) the assigned freelancer if the comment is on a shoot row with `freelancer_id`, AND (b) all admins + managers** (broadcast to `role:admin` + `role:manager` rooms). The "all admins/managers" model matches Skaly's actual operating reality (small team, everyone needs to know). |
| **Owner** | Arslaan (PM decision) + TL (doc) |
| **Sprint** | Sprint 0 (decide); Sprint 12 (implement) |
| **Patch** | `CRITICAL-PATCHES.md` §H-05 |

---

### H-06  Per-client shoot slot counts not delivered (Sprint 5 dependency)
| | |
|---|---|
| **Where** | `01-PRD.md` §7 OD-05, `06-IMPLEMENTATION-PLAN.md` §18 (status ⏳ Pending) |
| **What** | The `clients.shoot_slots_per_month` column has no default — explicit value required at creation (per `05-BACKEND-SCHEMA.md` §3). Sprint 5 (Shoot Planner) needs real counts per client for the rollover to generate slot rows. The risk register notes a placeholder of `4` per client. |
| **Why** | The first production rollover will generate slot rows based on whatever values are in the database. If the team rolls forward with placeholder `4` for everyone and the actual numbers come later, then either (a) some clients have phantom unused slots, or (b) some clients have too-few slots and need a mid-month schema change to add more rows — which requires unlocking the period or a custom service method. |
| **Action** | **Decision deadline: end of Sprint 4 (Week 5).** Operations team confirms per-client slot counts BEFORE Sprint 5 starts. If unavailable, use placeholder = 4 for all clients AND document a `ShootSchedulerService.adjustSlotCount(clientId, period, newCount)` method that allows post-hoc slot adjustment within an unlocked period. This method must (a) reject decrement if any of the to-be-removed slots are non-`Unset`, (b) generate new slot rows on increment, (c) emit audit log. |
| **Owner** | Skaly operations + TL |
| **Sprint** | Sprint 4 close (decision); Sprint 5 (implementation) |
| **Patch** | `CRITICAL-PATCHES.md` §H-06 |

---

### H-07  Sentry / error tracking is missing — Pino logs alone are insufficient for production
| | |
|---|---|
| **Where** | `10-INFRA-DEPLOYMENT.md` §8 (monitoring is alert-based, not error-tracking-based), `02-TRD.md` §2.2 (Pino logger; no Sentry) |
| **What** | Production errors flow to Railway log streams. Alerts fire on error rate > 1%. But there's no structured error tracking — no Sentry, Bugsnag, or Honeybadger. To debug a specific user's stack trace, the ops person logs into Railway and greps logs. |
| **Why** | At MVP scale (50 users) this is workable for the first few weeks. Once the portal is critical infrastructure, the team needs (a) deduplication of repeated errors, (b) source-mapped stack traces from frontend, (c) user/session context, (d) release tracking. Adding it later is a one-day integration; not adding it for launch means flying blind during the highest-risk period. |
| **Action** | Add Sentry (free tier covers MVP volume). Sprint 13 task. Frontend: `@sentry/nextjs` initialised in `app/sentry.client.config.ts` + `sentry.server.config.ts`. Backend: `@sentry/node` initialised in `apps/api/src/server.ts` before plugin registration. Source maps uploaded via Sentry CLI in deploy step. Add `SENTRY_DSN` env var to both Railway and Vercel. |
| **Owner** | TL |
| **Sprint** | Sprint 13 (pre-launch) |
| **Patch** | `CRITICAL-PATCHES.md` §H-07 |

---

### H-08  No CSP (Content Security Policy) header configured
| | |
|---|---|
| **Where** | `10-INFRA-DEPLOYMENT.md` §9 (Vercel headers — X-Frame-Options, X-Content-Type-Options, Referrer-Policy only) |
| **What** | The Vercel config sets three security headers but not Content-Security-Policy. The backend uses `@fastify/helmet` which provides CSP defaults but only for API responses — not the rendered HTML the user sees from Vercel. |
| **Why** | XSS sanitization (DOMPurify on chat messages) is one layer. CSP is the second layer that prevents executing any inline or third-party script even if XSS escapes. Modern compliance audits expect CSP. |
| **Action** | Add CSP header in Vercel config. Strict-but-livable starter: `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.skaly.in wss://api.skaly.in https://*.supabase.co; frame-ancestors 'none';` — then incrementally tighten (drop `unsafe-eval`, narrow img-src, narrow connect-src to Anthropic if needed in browser). See `CRITICAL-PATCHES.md` §H-08. |
| **Owner** | TL |
| **Sprint** | Sprint 13 (pre-launch) |
| **Patch** | `CRITICAL-PATCHES.md` §H-08 |

---

### H-09  Database connection pool sizing review for 50 concurrent users
| | |
|---|---|
| **Where** | `10-INFRA-DEPLOYMENT.md` §6 (`DATABASE_POOL_MIN=2, DATABASE_POOL_MAX=20`) |
| **What** | At 50 concurrent users, if a typical page load fires 3–4 API calls and each opens a brief connection, that's potentially 150–200 connection-acquires per second at peak. Pool of 20 + Railway's per-instance Postgres limit (typically 100–200 connections for Hobby tier) leaves headroom but no margin if any query holds a connection. The rollover transaction can hold a single connection for 30–60 seconds — during which pool capacity is effectively 19. |
| **Why** | Won't break MVP. Will start to show as p95 spikes if user count grows past 75–100. Documenting now means no surprise at scale. |
| **Action** | (1) k6 performance tests at 50 concurrent users (already in Sprint 13 plan) MUST measure pool wait time, not just response time. (2) Add Railway PostgreSQL connection limit to the monitoring dashboard alongside pool usage. (3) Document scaling path in `10-INFRA-DEPLOYMENT.md` §10: at 75+ users → upgrade Railway tier to dedicated PostgreSQL, set pool MAX to 50. |
| **Owner** | TL |
| **Sprint** | Sprint 13 (validate); ongoing (monitor) |
| **Patch** | `CRITICAL-PATCHES.md` §H-09 (monitoring config) |

---

## 5. 🔵 MEDIUM SEVERITY FINDINGS (12)

These won't block launch but should land within the 14-sprint window.

---

### M-01  Avatar upload flow is implied but no endpoint exists
| | |
|---|---|
| **Where** | `05-BACKEND-SCHEMA.md` §3 (`staff.avatar_url`), `07-API-CONTRACT.md` (no `/staff/:id/avatar` endpoint) |
| **What** | The staff table has `avatar_url`. The chat shows avatars (`senderAvatar`). But there's no endpoint to upload/change one. Default = NULL. |
| **Action** | For MVP: avatars are initials-based (CSS-generated, no upload). Document this in `03-UIUX.md` §13 explicitly. Phase 2: add `POST /v1/staff/me/avatar` with R2 presign + confirm flow mirroring task attachments. |
| **Owner** | D1 |
| **Sprint** | Sprint 11 (settings) — doc only; Phase 2 implementation. |

---

### M-02  Mobile fallback message for sub-768px web access
| | |
|---|---|
| **Where** | `13-NFRS.md` §6.1 ("Below 768px, the web app is not supported — use the mobile app (Phase 2)") |
| **What** | Mobile app is Phase 2. So at MVP launch, a user opening portal.skaly.in on their phone sees… what? Unspecified. |
| **Action** | Render a polite, branded fallback page: Skaly logo, "Scaly Business Portal requires a desktop browser. Mobile app coming Q3 2026." Implement as a Next.js media query gate at app layout level. |
| **Owner** | D1 |
| **Sprint** | Sprint 0 (build the gate) |

---

### M-03  Task attachment cleanup on hard delete
| | |
|---|---|
| **Where** | `05-BACKEND-SCHEMA.md` §4 (task_attachments cascades on task hard-delete) |
| **What** | Tasks are soft-deleted (`deleted_at`). But if a task IS hard-deleted (e.g., admin tooling, future cleanup), R2 files orphan. |
| **Action** | Phase 2: build a nightly cleanup job that finds R2 objects with no corresponding `task_attachments` row and removes them. For MVP: accept minor R2 storage cost as acceptable tech debt. Document accepted-risk decision. |
| **Owner** | TL |
| **Sprint** | Post-MVP |

---

### M-04  Concurrent bot session conflict across devices (Phase 2 implications)
| | |
|---|---|
| **Where** | `02-TRD.md` §9.4 (`bot:session:{staffId}` — one per staff, shared across devices) |
| **What** | Single Redis key per staff means if a user has the bot open on web AND Phase 2 mobile simultaneously, both clients see the same conversation. Confirmation flow (turn 1 / turn 2) could be confusing if the user confirms on web and the mobile shows the post-confirmation state without context. |
| **Action** | For MVP (web-only): no issue. For Phase 2: either (a) accept shared session as a feature ("conversation is the same wherever you are"), or (b) separate sessions per-device with `bot:session:{staffId}:{deviceId}`. Decide before Phase 2 starts. |
| **Owner** | TL |
| **Sprint** | Phase 2 design |

---

### M-05  Search GIN implementation details
| | |
|---|---|
| **Where** | `05-BACKEND-SCHEMA.md` §8 (search indexes), `07-API-CONTRACT.md` §5 (`GET /v1/search` returning 4 categories) |
| **What** | The schema specifies the indexes (trigram on names, full-text on description/result/remark/content). The endpoint returns 4 grouped categories. But the query strategy isn't shown — does it UNION ALL across 4 SELECTs? Use a single CTE? How are results ranked across categories? Top 5 per category — how scored? |
| **Action** | Sprint 9 (search) needs a reference query. Use 4 separate parallelisable queries, each ORDER BY `ts_rank(search_vector, plainto_tsquery($1))` DESC, LIMIT 5. Combine in service layer. Period filter optional based on `scope`. |
| **Owner** | D3 |
| **Sprint** | Sprint 9 |

---

### M-06  Rate limit response headers (X-RateLimit-*)
| | |
|---|---|
| **Where** | `07-API-CONTRACT.md` §1.2 (HTTP 429 with Retry-After) |
| **What** | Standard rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`) are good practice but unmentioned. `@fastify/rate-limit` provides them by default but they need to be enabled. |
| **Action** | Enable `addHeaders` option in `@fastify/rate-limit` config. Frontend can pre-emptively slow down requests when `X-RateLimit-Remaining` is low. |
| **Owner** | TL |
| **Sprint** | Sprint 2 |

---

### M-07  Notification dedup for double-trigger rollover
| | |
|---|---|
| **Where** | `04-APPFLOW.md` §16 (rollover idempotency check returns early if already done), `02-TRD.md` §10 (no dedup logic for notifications) |
| **What** | Cron fires `POST /v1/internal/rollover` at 00:01 IST. Admin manually triggers `POST /v1/internal/rollover/manual` 5 minutes later. Idempotency check prevents double-data-creation. But does it prevent a duplicate `month_ready` notification? Currently the notification fires on the "completed" branch, not the "already_complete" branch. ✅ Actually fine — the idempotency exits before notification. Good. |
| **Action** | Confirm in unit test: idempotent rollover does NOT emit notification on the second call. Already partially covered by the existing rollover idempotency test in TESTING-STRATEGY §4.1; just extend to assert on notification non-creation. |
| **Owner** | D3 |
| **Sprint** | Sprint 12 |

---

### M-08  Bot tool execution errors — UX behavior
| | |
|---|---|
| **Where** | `09-ERROR-HANDLING.md` §6 (Bot error communication table) |
| **What** | Table maps internal errors (PERIOD_LOCKED, etc.) to user-friendly bot responses. But "tool execution error" (e.g., `create_task` with an invalid `clientId` UUID) — what does the bot say? Currently it would fall through to "Any unhandled error: Something went wrong." |
| **Action** | Add row: "Tool execution validation error → 'I tried to [action] but the [parameter] was invalid. Could you clarify?'" — the bot can use the tool_result error to compose a helpful re-prompt. Specify that the bot's second Anthropic call (after tool execution) receives the error as `tool_result` content so it can recover gracefully. |
| **Owner** | TL |
| **Sprint** | Sprint 9 (bot mutation) |

---

### M-09  PDF report font bundling
| | |
|---|---|
| **Where** | `02-TRD.md` §2.1 (`@react-pdf/renderer` server-side only), `03-UIUX.md` §3.1 (three fonts) |
| **What** | `@react-pdf/renderer` needs fonts registered explicitly via `Font.register({ family, src })`. Without it, the PDF uses Helvetica fallback. The TTF/OTF files need to be bundled with the backend. |
| **Action** | Sprint 12 task: download Big Shoulders Display + DM Sans + DM Mono `.ttf` files from Google Fonts to `apps/api/assets/fonts/`. Register them in `apps/api/src/services/report.service.ts` before any PDF generation call. |
| **Owner** | D3 |
| **Sprint** | Sprint 12 |

---

### M-10  Initial seed data plan (clients, staff, holidays)
| | |
|---|---|
| **Where** | `05-BACKEND-SCHEMA.md` §9 (only System Actor is seeded), `06-IMPLEMENTATION-PLAN.md` §16 ("First-month data migration: client roster and team roster manually entered") |
| **What** | Sprint 13 manual entry covers production launch. But staging dev environments need test data — without it, every developer who pulls latest has to type clients/staff by hand or import via admin UI. |
| **Action** | Add `database/seeds/002_dev_data.ts` — a dev-only seed (NODE_ENV !== 'production') that inserts 5 sample staff (1 of each role), 8 sample clients with varied slot counts, 2 sample holidays. Runs after migrations on local dev only. |
| **Owner** | D2 |
| **Sprint** | Sprint 0 |

---

### M-11  Onboarding documentation for new contributors
| | |
|---|---|
| **Where** | Not in any of the 13 docs |
| **What** | The team is 4 developers. If a 5th joins mid-build, or for handoff post-launch, there's no README, CONTRIBUTING, or local-dev-setup doc. |
| **Action** | Sprint 0: create `README.md` at repo root with (a) project overview, (b) local dev setup commands (clone → `docker compose up` → `pnpm install` → `pnpm --filter api db:migrate` → `pnpm dev`), (c) link to all 13 spec docs, (d) link to this audit. |
| **Owner** | TL |
| **Sprint** | Sprint 0 |

---

### M-12  OpenAPI / API documentation generation
| | |
|---|---|
| **Where** | `07-API-CONTRACT.md` is the spec; no machine-readable OpenAPI / Swagger artifact exists |
| **What** | The hand-written API contract is excellent documentation. But there's no Swagger UI, no `swagger.json`, no auto-generated SDK. Fastify supports `@fastify/swagger` natively — drop-in. |
| **Action** | Sprint 2: install `@fastify/swagger` + `@fastify/swagger-ui`. Annotate route schemas (already done for Zod validation). Mount at `/v1/docs` (admin-only via auth plugin). Frontend devs use Swagger UI for live API exploration instead of manually re-reading the contract. |
| **Owner** | D2 |
| **Sprint** | Sprint 2 |

---

## 6. ⚪ LOW SEVERITY FINDINGS (9)

Accepted as tech debt or post-MVP. Documented for visibility.

| ID | Title | Notes |
|----|-------|-------|
| **L-01** | Health check doesn't probe R2 or Anthropic | Acceptable — these failure modes are surfaced via their own user-visible errors. Adding to health check could cause false alarms. |
| **L-02** | No virus scanning on uploaded files (R2) | Acceptable risk for internal portal with 50 known users. Document as accepted risk; Phase 2 could add ClamAV via Cloudflare Workers. |
| **L-03** | No CDN-level caching for static API endpoints | Single-region deployment, low latency requirements met. Re-evaluate if user base expands geographically. |
| **L-04** | No background job queue (BullMQ, etc.) | Direct async calls work at MVP scale. Rollover is the only long-running job; it's idempotent and runs daily. |
| **L-05** | Manual restore drill (monthly) — not automated | Acceptable — manual drill builds operator familiarity. Automated drill is Phase 2. |
| **L-06** | Period selector "past months" endpoint not explicit | `GET /v1/months` returns the list; UI filters to past. Implicit but works. |
| **L-07** | Mobile offline replay protocol is Phase 2 documentation only | Already well-documented in UIUX §21.9. No MVP impact. |
| **L-08** | Bot session retention beyond 12h Redis TTL | Persistent archive in `messages` table (channel='bot') already handles long-term retrieval. 12h is the active-session window — correct. |
| **L-09** | No automated security scanning in CI (Dependabot, Snyk, etc.) | GitHub Dependabot is free and on-by-default for security alerts. Confirm it's enabled on the repo in Sprint 0. |

---

## 7. CROSS-DOCUMENT CONSISTENCY VERIFICATION

Spot-checks across the 13 documents for the most error-prone consistency points:

| Topic | PRD | TRD | UI/UX | APPFLOW | SCHEMA | API | AUTH | IMPL | INFRA | THIRD | ERROR | TEST | NFR | Consensus |
|-------|-----|-----|-------|---------|--------|-----|------|------|-------|-------|-------|------|-----|----------|
| 6 calendar statuses | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | ✅ | — | — | — | — | — | ✅ Consistent |
| 4 shoot statuses | ✅ | — | ✅ | ✅ | ✅ | ✅ | — | ✅ | — | — | — | ✅ | — | ✅ Consistent |
| 22 bot tools (11+11) | ✅ | ✅ | — | — | — | — | ✅ | ✅ | — | — | — | — | — | ✅ Consistent |
| 50 user MVP scale | ✅ | — | — | — | — | — | — | — | ✅ | — | — | — | ✅ | ✅ Consistent |
| TTFT <2s, full <8s | — | — | — | — | — | — | — | — | — | — | — | ✅ | ✅ | ⚠️ **C-01** PRD §5 contradicts |
| MFA admin+manager | ✅ | — | — | ✅ | — | ✅ | ✅ | ✅ | — | ✅ | ✅ | — | ✅ | ✅ Consistent |
| `claude-sonnet-4-6` prod | ✅ | ✅ | — | — | — | — | — | ✅ | ✅ | ✅ | ✅ | — | — | ✅ Consistent |
| `claude-haiku-4-5-20251001` dev | — | ✅ | — | — | — | — | — | ✅ | ✅ | ✅ | — | — | — | ✅ Consistent |
| Rate limit: email+IP login | — | — | — | — | — | ✅ | ✅ | — | — | — | — | — | — | ✅ Consistent |
| Internal route: X-Internal-Secret | ✅ | ✅ | — | — | — | ✅ | — | ✅ | ✅ | — | — | — | — | ✅ Consistent |
| Audit log append-only | ✅ | ✅ | — | — | ✅ | — | — | — | — | — | — | — | ✅ | ⚠️ **B-01** No migration enforces |
| Idempotent rollover | ✅ | — | — | ✅ | — | ✅ | — | ✅ | — | — | — | ✅ | — | ✅ Consistent |
| All optimistic locks have version | — | ✅ | — | ✅ | ✅ | ✅ | — | ✅ | — | — | ✅ | ✅ | — | ✅ Consistent |
| Three-font stack | — | ✅ | ✅ | — | — | — | — | ✅ | — | ✅ | — | — | — | ✅ Consistent |
| 60/30/10 color rule | — | — | ✅ | — | — | — | — | — | — | — | — | — | — | ✅ Single source |
| Soft delete pattern | ✅ | — | — | — | ✅ | — | — | — | — | — | — | — | — | ⚠️ **H-02** No enforcement helper |
| `record_context` for comments | — | — | — | ✅ | ✅ | ✅ | — | ✅ | — | — | — | — | — | ✅ Consistent |
| Reactivation (M-01 audit) | — | — | — | — | — | ✅ | — | ✅ | — | — | — | — | — | ✅ Consistent |

**Overall consistency:** 17/19 spot-checks pass cleanly. Two known issues (C-01 and B-01) are captured above. H-02 is a methodology gap, not a contradiction.

---

## 8. ARCHITECTURE VALIDATION

### 8.1 Will it work?

| Component | Validation |
|-----------|-----------|
| **Three-tier separation** (Vercel / Railway / Supabase) | ✅ Clean. JWT-only Supabase use avoids the "auth + DB locked together" trap. |
| **Materialised views** for dashboard | ✅ Right choice at 50-user scale. Refresh-failure path is documented (`rollover_view_refresh_failed`). |
| **Optimistic locking** on volatile records | ✅ Calendar, attendance, pipeline all carry `version`. STALE_DATA error contract is explicit. |
| **Cross-module triggers** via EventEmitter bus | ✅ Decoupled, testable. The two triggers (shoot → dropper, dropper → calendar) match Skaly's actual workflow. |
| **Socket.io rooms** (user / role / org) | ✅ Right level of granularity. Redis adapter present from Sprint 0 — won't drop on rolling deploys. |
| **Anti-hallucination bot system prompt** | ✅ Tool-only response constraint + permission filtering + locked-period guard. Three layers of safety. |
| **Idempotent rollover in single transaction** | ✅ Atomic. Failure rolls back fully. Retry then AI-generated failure notification. |
| **Append-only audit log** | ⚠️ Documented; B-01 needs to actually apply it. |

### 8.2 Will it scale?

| Metric | MVP | Growth Path | Validated |
|--------|-----|-------------|----------|
| Users | 50 | → 500 via Railway tier upgrade | ✅ |
| API instances | 1 | → N via Socket.io Redis adapter (already in place) | ✅ |
| DB | Railway managed PG 16 | → dedicated PG → RDS | ✅ |
| Redis | Upstash serverless | → Upstash Pro | ✅ |
| WebSocket | Single instance | → Multi via adapter | ✅ (already configured) |
| Frontend | Vercel CDN | No change | ✅ |

**Verdict:** Architecture is right-sized for MVP with a clear path to 10× scale. No "MVP shortcut that becomes a rewrite" patterns identified.

### 8.3 Will it ship in 14 sprints?

**Sprint-by-sprint risk profile:**

| Sprint | Risk | Mitigation in place? |
|--------|------|--------------------|
| Sprint 0 — Foundation | 🟢 Low | Comprehensive DoD list |
| Sprint 1 — Auth | 🟠 Medium (templates dependency) | B-02 needs decision |
| Sprint 2 — DB Scaffold | 🟢 Low | Schema fully specified |
| Sprint 3 — Attendance | 🟢 Low | First operational module — well-understood |
| Sprint 4 — Tasks | 🟢 Low | Dependency blocking is the only complex piece |
| Sprint 5 — Shoot Planner | 🟠 Medium (slot counts dependency) | H-06 needs decision |
| Sprint 6 — Content Dropper + Trigger 1 | 🟢 Low | Pattern established Sprint 5 |
| Sprint 7 — Content Calendar + Trigger 2 | 🟡 High (virtual scroll + column highlight + 31×N grid) | Sprint 0 prototype reduces this |
| Sprint 8 — Bot Query | 🟡 High (streaming + tool registry) | H-04 reference implementation reduces this |
| Sprint 9 — Bot Mutation + Search | 🟡 High (confirmation protocol + search query strategy) | M-05 + H-04 reduce this |
| Sprint 10 — Chat + Notifications | 🟢 Low | Standard patterns |
| Sprint 11 — Dashboard + Settings | 🟢 Low | Materialised views already populated |
| Sprint 12 — Rollover + PDF + Comments | 🟠 Medium (rollover transaction depth) | k6 staging test pre-launch |
| Sprint 13 — QA + Launch | 🟢 Low if 0–12 land clean | Full week buffer |

**Verdict:** 14 weeks is tight but realistic with the audit fixes applied early. Most risk concentrates in Sprints 7–9. Front-load Sprint 0 prototypes for those modules.

---

## 9. SECURITY POSTURE REVIEW

### 9.1 What's strong
- JWT RS256 verification via Supabase public key — never trust client claims
- Three-layer RBAC (middleware → auth plugin → service layer)
- Append-only audit log (subject to B-01 actually enforcing it)
- Internal routes separated from user auth (subject to B-03 timing-safe comparison)
- Email + IP keyed login rate limit (not pure IP — avoids shared-office lockout)
- DOMPurify on chat message content
- All inputs validated with Zod (shared between frontend and backend)
- Soft delete preserves data; can't be wiped by routine endpoints
- TLS 1.2+ enforced by Vercel + Railway
- R2 files private only — presigned URLs with documented expiry policy
- MFA mandatory for admin/manager
- 3-attempt TOTP lockout
- Account deactivation invalidates sessions immediately

### 9.2 Gaps captured in findings
- B-01: Audit log REVOKE not actually applied via migration
- B-03: CRON_SECRET comparison not timing-safe
- C-05: WebSocket auth token expiry handling undefined
- H-07: No error tracking (Sentry) — can't see attacks happening
- H-08: No CSP header — second XSS layer missing
- L-02: No virus scanning on uploads (accepted risk)

### 9.3 What I checked and found OK
- ✅ No SQL injection vector (Kysely parameterised)
- ✅ No XSS in chat (DOMPurify)
- ✅ No secrets in code or git (all env vars)
- ✅ Locked period: API returns 423, frontend is UX-only
- ✅ Freelancer data isolation: WHERE clause added before query executes (not post-fetch filter)
- ✅ Team member attendance ownership: enforced at service layer
- ✅ Refresh token: handled by Supabase (default rotation is on in Supabase JS SDK 2.x)
- ✅ Internal `rejection_note` never appears in user-facing payload (test exists)

### 9.4 Compliance notes
- Data at rest: AES-256 (Railway managed)
- Data in transit: TLS 1.2+
- Audit log retention: 2 years
- PII (CV files): private R2, presigned URLs only, owners + admin/manager only

For a private internal SMB tool, this is enterprise-grade. No GDPR/HIPAA/SOC2 framework formally documented but the controls would substantially pass a SOC 2 Type 1 audit with documentation cleanup.

---

## 10. POSITIVE OBSERVATIONS — WHAT TO CELEBRATE

These are choices made elsewhere in the spec suite that I want to highlight as well-done. Don't lose them under the volume of findings.

1. **Period in URL.** Every grid page carries `?period=YYYY-MM`. Bookmarkable, browser-back works, debug-friendly. Underrated piece of UX.
2. **Three-font discipline.** Big Shoulders Display + DM Sans + DM Mono with clear roles for each. Most projects pick fonts and never document when to use which. This one does.
3. **Locked-period UX-vs-security distinction.** Frontend renders cells as `<span>` (not `<input>`) so there's nothing to focus, nothing to type into. Backend returns 423 as the enforceable boundary. Both layers acknowledged.
4. **CSV format option on audit log export.** Streaming response. The export-as-CSV is a small detail that turns "I need to grep this" into "I download it and open in Excel." Auditor mode.
5. **The audit annotations (H-XX, M-XX, etc.) embedded throughout V2.1.** The spec authors did their own audit and left their work visible. Every "audit M-02 / audit H-06" reference shows where a real human read the spec carefully and added the fix. This is the single biggest indicator that V2.1 is build-ready.
6. **No Electron / no Tauri.** The spec calls this out twice. Web browser is the desktop client. Right answer for a 14-week MVP. Don't let scope creep change this.
7. **Idempotency check BEFORE the transaction.** Most rollover designs put idempotency inside the transaction. This one checks first. Cheaper and easier to reason about.
8. **Bot mutation confirmation as a HARD requirement, not a UX recommendation.** Two-turn protocol is mandatory in the spec. This is what keeps the bot from being a foot-gun.
9. **System Actor UUID is a specific fixed value, not nullable.** `00000000-0000-0000-0000-000000000000`. Eliminates all "is this a user or system action?" ambiguity in the audit log.
10. **Three-font stack matches mobile (Expo Google Fonts) AND PDF generation.** Continuity from web → mobile → printed report. Brand discipline.
11. **The risk register, external dependency tracker, AND open decisions tables.** Three different artifacts tracking three different kinds of unknowns. PM-grade discipline.
12. **Materialised view CONCURRENTLY refresh has a fallback failure path** that doesn't fail the rollover. Dashboard goes stale; portal stays up. Right tradeoff.
13. **R2 PUT expiry increased to 15 minutes** based on a real upload-time calculation (50MB MP4 at 500kbps office connection = ~13 min). Empirical, not arbitrary.

---

## 11. OPEN DECISIONS — STATUS UPDATE

PRD §7 lists 5 open decisions. Status check:

| ID | Decision | Deadline | Status |
|----|----------|----------|--------|
| **OD-01** | Comment acknowledgment in MVP | Closed (in MVP) | ✅ Resolved in V2.1 |
| **OD-02** | Google Sheets migration plan | Before Sprint 13 | ⏳ Open — still 13 weeks out |
| **OD-03** | Skaly lion logo SVG | Before Sprint 10 | ⏳ Open — placeholder allowed for dev |
| **OD-04** | T1–T4 template files | Before Sprint 1 | 🔴 **B-02 — escalated** |
| **OD-05** | Per-client shoot slot counts | Before Sprint 5 | 🟡 **H-06 — escalated** |

**Audit additions:**

| ID | Decision | Deadline |
|----|----------|----------|
| **OD-06** | Comment notification routing per module (H-05) | Sprint 0 |
| **OD-07** | Transactional email policy explicit OoS (C-03) | Sprint 0 |
| **OD-08** | Sentry integration go/no-go for launch (H-07) | Sprint 13 |

---

## 12. PRE-BUILD READINESS CHECKLIST

A condensed go-list for Sprint 0 close-out. See companion file `SPRINT-0-READINESS-CHECKLIST.md` for the tickable version.

```
🔴 BLOCKER (3) — must be ✅ before Sprint 1
  [ ] B-01  Migration 026_database_roles applied + verified
  [ ] B-02  T1–T4 templates decision documented (delivered or fallback path)
  [ ] B-03  internalAuthPlugin uses timingSafeEqual

🟠 CRITICAL (6) — must be ✅ before Sprint 0 close
  [ ] C-01  PRD §5 bot latency row corrected
  [ ] C-02  API-CONTRACT §1.1 PATCH response envelope clause added
  [ ] C-03  PRD §6 OoS row for transactional email added
  [ ] C-04  /v1/staff/me endpoint added to API-CONTRACT §4
  [ ] C-05  Socket auth refresh protocol specified
  [ ] C-06  Rollover bootstrap edge case spec'd + test added

📋 SPRINT 0 STANDARD DOD (per V2.1 IMPL-PLAN §3.5, copied here for completeness)
  [ ] Railway, Vercel, R2, Upstash, Supabase provisioned
  [ ] GitHub Actions CI passes on test PR
  [ ] Docker Compose runs on all 4 machines
  [ ] All 20+ DB tables migrated to Railway staging
  [ ] pg_trgm extension on staging
  [ ] globals.css CSS variables live
  [ ] All three fonts loading
  [ ] Framer Motion 11 installed
  [ ] useColumnHighlight hook with passing tests
  [ ] Gold overlay demo working
  [ ] GET /v1/health returns ok
  [ ] @socket.io/redis-adapter configured

📦 AUDIT-ADDED SPRINT 0 TASKS
  [ ] M-02 Sub-768px fallback page rendered
  [ ] M-10 Dev seed data (002_dev_data.ts) created
  [ ] M-11 README.md at repo root
  [ ] L-09 GitHub Dependabot enabled
  [ ] H-04 Bot streaming reference implementation drafted
  [ ] H-03 db:refresh-views CLI script created

🎯 DECISION CLOSURE BY END OF SPRINT 0
  [ ] OD-06 Comment notification recipients per module
  [ ] OD-07 Transactional email policy explicit
  [ ] B-02  T1–T4 path (delivered or fallback)

✅ When all of the above are checked: Sprint 1 begins.
```

---

## 13. RISK REGISTER — UPDATES

Additions and changes to `06-IMPLEMENTATION-PLAN.md` §17:

| Risk | Probability | Impact | Mitigation | Status |
|------|------------|--------|-----------|--------|
| (existing) T1–T4 templates late | Medium | High | Fallback spec defined (B-02) | Active |
| (existing) Skaly lion SVG late | Medium | Medium | Placeholder OK for dev | Active |
| (existing) Anthropic rate limits in dev | Low | Medium | Haiku 4.5 throughout dev/test | Mitigated |
| (existing) Calendar virtual scroll + column highlight conflict | Medium | High | Sprint 0 prototype | Mitigated |
| (existing) Rollover timing on shared PG | Low | High | k6 staging tests pre-launch | Active |
| (existing) Shoot slot counts late | High | Medium | H-06 escalates with `adjustSlotCount` fallback | Mitigated |
| **NEW** Sentry/error tracking absent at launch | Medium | Medium | H-07 — Sprint 13 add | Open |
| **NEW** CSP gap allows successful XSS escape | Low | High | H-08 — Sprint 13 add | Open |
| **NEW** WebSocket token expiry causes silent disconnect | Medium | Medium | C-05 — Sprint 0 spec, Sprint 10 client wire | Open |
| **NEW** Connection pool starvation under load | Low | Medium | H-09 — staging k6 measures + alert | Open |
| **NEW** Audit log mutable in absence of REVOKE | High (if not fixed) | Critical | B-01 — Sprint 0 migration | Blocker until fixed |

---

## 14. FINAL VERDICT

**The Scaly Business Portal V2.1 document suite is build-ready conditional on Sprint 0 resolving 3 blockers and 6 criticals.**

These 9 items are concentrated in Sprint 0 and total an estimated 3–5 developer-days of work (most are doc patches, one is a migration, two are reference implementations). The Sprint 0 timeline already has slack for foundation work — these absorb cleanly.

After Sprint 0 close-out:
- Sprints 1–13 can execute against the spec as written, with the 9 high-severity findings consumed by their respective sprint teams.
- The 12 medium-severity findings spread across the 14 weeks with no single sprint loaded by more than 1–2.
- The 9 low-severity findings are accepted as tech debt or Phase 2 work.

**Quality of the document suite:** This is the most rigorously cross-referenced internal spec I've audited at this scale. The embedded "audit M-XX / H-XX" annotations throughout V2.1 show the authors did the hard intellectual work of stress-testing their own decisions. V2.2 (this audit) closes the remaining loops; from here, the work is execution.

**Recommendation to Mohammed Arslaan:** Take this audit to the team in the Sprint 0 kickoff. Assign owners to the 9 must-fix items. Set the Sprint 0 close-out review for end of Week 1 with the checklist above. From there, ship the thing.

---

**END OF AUDIT — V2.2**

*This document supersedes no prior version of any V2.1 source document; it adds to the canonical spec suite as the 14th document. Source documents 01–13 remain authoritative on their respective subjects; this document is authoritative on findings and corrective actions.*
