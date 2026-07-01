# SPRINT 2 — DATABASE SCHEMA + API SCAFFOLD: DETAILED PROMPT-BY-PROMPT GUIDE

## Scaly Business Portal • Sprint 2 of 13

**Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9**
**Same Goal / Prompt / Verify framework as Sprint 1 (and Sprint 0, PART 7)**
**Tooling interfaces verified as of January 2026** — Fastify 5, `@fastify/swagger` v9 + `@fastify/swagger-ui` v5, `fastify-type-provider-zod` v4, `socket.io` v4 + `@socket.io/redis-adapter` v8, `@aws-sdk/client-s3` v3, `kysely-codegen` latest, `ioredis` latest.

---

## WHAT YOU'RE BUILDING IN SPRINT 2

Sprint 1 gave you a working auth surface but it stands on **placeholders**. Sprint 2 replaces every placeholder with the real thing and lays down the patterns that **every sprint from 3 to 13 will reuse**. By the end of this week:

- Every table in the live database has a generated Kysely type in `packages/shared/src/db.types.ts` — including the tables Sprint 1 added (`mfa_recovery_codes` and whatever else landed as migrations 027–029).
- The **base service pattern** exists: `assertPeriodNotLocked`, `softDelete` (audit H-02), `getCurrentPeriod`, and `optimisticUpdate` (audit C-02).
- `AuditService.log()` is **real** — it writes to `audit_log` through whatever lockdown path Sprint 0 installed, with the System Actor UUID for automated writes (audit C-04). The Sprint 1 placeholder call sites are migrated to the real signature.
- `NotificationService.create()` is **real** — it writes a row to `notifications` **and** emits over Socket.io.
- The **Socket.io server** boots with three namespaces, the Redis adapter, JWT handshake auth, room joins (`user:` / `role:` / `org:all`), and the Redis presence model.
- The `EventBus` exists with the two cross-module trigger events declared (listeners wired in Sprints 6 and 7).
- **R2 presigned-URL utilities** work for upload and download.
- The **read endpoints** for clients, months, and staff respond with the exact shapes in `07-API-CONTRACT.md`.
- **Swagger UI** is live at `/docs` in non-production only (audit M-12).
- Rate-limit response headers are confirmed present on responses (audit M-06).

**Estimated time:** 5 working days (per `06-IMPLEMENTATION-PLAN.md` §5). Sprint 2 is the foundation sprint — it is dense with *patterns*, not features. A sloppy `BaseService` or `AuditService` here metastasises into every later sprint. Do not rush. Every box in the close-out checklist must be green before Sprint 3 starts.

**Prerequisites from Sprint 1** (all must be true — if any is not, stop and fix it before you start):

- `apps/api` boots; `GET /v1/health` returns `{ status: 'ok' }`.
- `apps/web` boots; the gold "Scaly Business Portal" placeholder renders; `/login`, `/signup`, `/signup/pending`, `/mfa-setup`, `/forgot-password`, `/reset-password` exist.
- Auth works end-to-end: invite → signup, self-signup → approve → login, reject (private note never transmitted), password reset, session refresh.
- **B-01 lockdown is verified** — `audit_log` is write-protected. Note *how* it was implemented in your Sprint 0 (REVOKE UPDATE/DELETE only, or REVOKE + a `SECURITY DEFINER` write function). STEP 5 needs to know which.
- All migrations applied — through the latest Sprint 1 added (`029_mfa_recovery_codes.ts` plus any 027/028). `pnpm --filter @skaly/api db:status` shows zero pending.
- The Sprint 1 `auditServiceLog(...)` / `notificationServiceCreate(...)` placeholders exist and are called from `AuthService`. STEP 5 and STEP 8 replace them.
- The Sprint 0 `socketTokenWatcher.plugin.ts` (C-05) and `internalAuth.plugin.ts` (B-03) exist.
- Git is on `main` with the Sprint 1 close-out pushed and CI green.

---

## READ FIRST (Open in Antigravity Split View)

Pin these tabs before you begin. In Antigravity you can `@`-reference them in chat with `@docs/05-BACKEND-SCHEMA.md`.

| Doc | Sections | Why |
|---|---|---|
| `docs/05-BACKEND-SCHEMA.md` | **entire** | The contract. Column names, enums, indexes, Redis keys, DB role grants. This is the source of truth this sprint serves. |
| `docs/07-API-CONTRACT.md` | §1 (envelopes), §2 (clients), §3 (months), §4 (staff), §6 (WebSocket events) | Exact request/response shapes + socket event names |
| `docs/02-TRD.md` | §5 (Fastify plugin order + service pattern + EventBus), §8 (Socket.io topology, rooms, presence) | The scaffold architecture |
| `docs/08-AUTH-MATRIX.md` | §2 (three layers), §3–§4 (module/endpoint access), §7–§8 (ownership, freelancer isolation) | Which role sees which fields on the read endpoints |
| `docs/09-ERROR-HANDLING.md` | §1–§2 (error shape + registry), §4 (global handler) | `PERIOD_LOCKED`, `STALE_DATA`, `RESOURCE_NOT_FOUND` shapes |
| `docs/06-IMPLEMENTATION-PLAN.md` | §5 | Sprint 2 checklist |
| `docs/11-THIRD-PARTY-INTEGRATIONS.md` | §4 (R2), §5 (Redis keys) | Presign TTLs + Redis presence pattern |
| `docs/14-PRE-BUILD-AUDIT.md` | C-02, C-04, H-02, M-06, M-12 | The five audit items this sprint resolves |

---

## CONSISTENCY RECONCILIATIONS — LOCK THESE BEFORE YOU PROMPT

The Master Build Guide PART 9 Sprint 2 prompt uses a few shorthand names that **drift from the canonical schema**. The numbered spec docs win. Apply these everywhere this sprint — they are baked into the prompts below, but know *why*:

1. **Audit source column is `changed_by_source`**, enum `('user' | 'system' | 'bot')`, default `'user'`. (Not `actorSource = 'web'`.) Source: `05-BACKEND-SCHEMA.md` §6.
2. **Audit `action` is a fixed enum**: `('INSERT' | 'UPDATE' | 'DELETE' | 'LOCK' | 'UNLOCK' | 'DEACTIVATE')`. The Sprint 1 placeholder passed dotted strings like `'invite.create'` / `'staff.create'` — those would **violate the CHECK constraint** the moment a real INSERT hits `audit_log`. STEP 5 maps them onto the enum + `table_name`.
3. **Notification socket event is `notify:new`** to room `user:{staffId}`. (Not `notification:new`.) Source: `02-TRD.md` §10.2 + `07-API-CONTRACT.md` §6.
4. **Notifications columns** are `staff_id, type, title, message, payload (JSONB), is_read`. Map `create({ recipientId, ..., body, data })` → `{ staff_id: recipientId, ..., message: body, payload: data }`. The valid set is the **18 values in the `notifications_type_check` enum** — read it from the type, never hardcode a count.
5. **Socket.io namespaces are `/ws/chat`, `/ws/presence`, `/ws/notify`.** (Not `/portal`, `/bot`, `/presence`.) Bot streaming (`bot:message`), `notify:new`, and live grid-update events all ride **`/ws/notify`**; chat events ride `/ws/chat`; heartbeats ride `/ws/presence`. Source: `02-TRD.md` §8 + `07-API-CONTRACT.md` §6.
6. **`months` has no `is_current` / `status` column.** Its columns are `period, label, locked, locked_at, locked_by, unlocked_at, unlocked_by, unlock_reason, created_at`. So `getCurrentPeriod` is **computed from the current IST month**, with a fallback to the latest `period`. (Not `WHERE is_current = true`.) Source: `05-BACKEND-SCHEMA.md` §3.
7. **`version` is a live optimistic-lock column** on `attendance_logs`, `content_pipelines`, and `content_calendar`. If any schema comment still says "future use," ignore it — treat it as live (audit C-02).
8. **Reuse, don't reinvent.** The JWT verifier you wrote in Sprint 1 (`auth.plugin.ts`) is the same one the Socket.io handshake needs. Extract it into one shared function and call it from both. Same for the Sprint 0 `socketTokenWatcher` — apply it to the namespaces, don't write a new one.

---

## AUDIT ITEMS THIS SPRINT MUST HANDLE

| ID | What | Where it lives |
|---|---|---|
| **C-02** | `optimisticUpdate(table, id, expectedVersion, patch, trx)` runs `UPDATE ... WHERE id = ? AND version = ?`, increments `version`, and throws `STALE_DATA` (409) with `details.currentVersion` + `details.updatedBy` when 0 rows match. `version` is live, not future. | STEP 4 (BaseService) |
| **C-04** | `AuditService.log` always writes a **non-NULL** `staff_id`. Automated/system writes use `SYSTEM_ACTOR_UUID = '00000000-0000-0000-0000-000000000000'` with `changed_by_source = 'system'`. | STEP 5 (AuditService) |
| **H-02** | A reusable `softDelete` / `softDeletable(qb)` helper so no service forgets `WHERE deleted_at IS NULL`. Lives in `apps/api/src/lib/queries.ts`. | STEP 4 (BaseService) + STEP 10 (read endpoints use it) |
| **M-06** | `@fastify/rate-limit` emits `x-ratelimit-limit` / `x-ratelimit-remaining` / `x-ratelimit-reset` headers. Confirm with a route test asserting header presence. | STEP 12 (verify) |
| **M-12** | `@fastify/swagger` + `@fastify/swagger-ui` registered **only when `NODE_ENV !== 'production'`**, mounted at `/docs`, schemas auto-derived from the Zod validators. | STEP 11 (Swagger) |

If you skip the test for any of these, Sprint 2 is not done. They reappear in CI when you push.

---

## STEP-BY-STEP STRUCTURE

| # | Type | What |
|---|---|---|
| 1 | Manual | Pre-flight — confirm Sprint 1 close-out, env vars, Docker, branch |
| 2 | Manual + Prompt | Kysely types refresh + drift reconciliation |
| 3 | Prompt | Sprint 2 dependencies + shared constants (`SYSTEM_ACTOR_UUID`, error codes) |
| 4 | Prompt | `BaseService` utilities (C-02 + H-02 + period lock + current period) |
| 5 | Prompt | `AuditService` (real) + reconcile Sprint 1 call sites (C-04) |
| 6 | Prompt | `EventBus` (typed; two trigger events, no listeners yet) |
| 7 | Prompt | Socket.io scaffold (3 namespaces, Redis adapter, handshake auth, rooms) + presence |
| 8 | Prompt | `NotificationService` (real — DB write + `notify:new` emit) |
| 9 | Prompt | R2 presigned-URL utilities (`lib/r2.ts`) |
| 10 | Prompt | Read endpoints — `clients`, `months`, `staff` |
| 11 | Prompt | Swagger UI (M-12, dev-only) |
| 12 | Prompt | Wire-up in `server.ts` + M-06 header verify + full suite |
| 13 | Manual | End-to-end smoke + commit + close-out |

---

## SPRINT 2 — STEP 1: Pre-flight (manual)

**Goal:** Prove the ground under Sprint 2 is solid before you write a line of it. Five minutes now saves a day of "why is this broken" later.

**This is a manual step.** Run each command; every one must pass.

### 1.1 — Confirm the apps boot and migrations are clean

```bash
# From repo root
docker compose up -d                      # Postgres 16 + Redis 7 (both should report healthy)
docker compose ps                         # STATUS column = "healthy" / "Up" for both

pnpm install                              # ensure workspace is hydrated
pnpm --filter @skaly/api db:status        # MUST show 0 pending migrations
```

If `db:status` shows pending migrations, apply them before continuing:

```bash
pnpm --filter @skaly/api db:migrate
```

### 1.2 — Confirm the live migration set includes Sprint 1's additions

```bash
# List the migration files actually on disk
ls database/migrations | sort
```

You should see the original `001`–`025`, the audit's `026_database_roles.ts`, **and** the Sprint 1 additions (at minimum `029_mfa_recovery_codes.ts`, plus whatever 027/028 Sprint 1 introduced). Note the **highest** migration number — STEP 2's type regeneration must reflect all of them.

### 1.3 — Confirm the `audit_log` lockdown style (you'll need this in STEP 5)

```bash
# Connect to local Postgres
docker compose exec postgres psql -U skaly -d skaly_dev
```

```sql
-- Are UPDATE/DELETE revoked on audit_log for the app role?
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_name = 'audit_log';

-- Is there a SECURITY DEFINER write function? (Sprint 1 close-out implied "writes only via function")
SELECT proname, prosecdef
FROM pg_proc
WHERE proname ILIKE '%audit%';

\q
```

Write down which you have:
- **(A)** Only `UPDATE`/`DELETE` revoked, `INSERT` still granted → `AuditService.log` can do a direct parameterised Kysely `insertInto('audit_log')`.
- **(B)** `INSERT` also revoked + a `SECURITY DEFINER` function (e.g. `app_write_audit_log(...)`) → `AuditService.log` must call that function, not `insertInto`.

### 1.4 — Confirm env vars Sprint 2 touches

Open `apps/api/.env` and confirm these are present and non-empty (they were set in Sprint 0 / Sprint 1):

```bash
DATABASE_URL=postgresql://skaly:localdev@localhost:5432/skaly_dev
REDIS_URL=...                    # Upstash rediss:// (staging) OR redis://localhost:6379 for local
SUPABASE_JWKS_URL=...            # set in Sprint 1 STEP 3.2 — the socket handshake reuses this
SUPABASE_JWT_SECRET=...
R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=skaly-portal-staging
```

> **R2 note (Jan 2026 console):** Cloudflare R2 → your bucket → **Settings → CORS policy** must already allow `PUT` from `http://localhost:3000` and `https://portal.skaly.in` (set in Sprint 0 per `11-THIRD-PARTY-INTEGRATIONS.md` §4.4). You don't change it this sprint — just confirm it exists. The presign utilities in STEP 9 are useless if CORS blocks the browser PUT later.

### 1.5 — Branch

```bash
git checkout main && git pull
git checkout -b sprint-2-api-scaffold
```

**Verify gate:** Both containers healthy, `db:status` clean, `audit_log` lockdown style known, env vars present, on a fresh branch. Proceed.

---

## SPRINT 2 — STEP 2: Kysely types refresh + drift reconciliation

**Goal:** `packages/shared/src/db.types.ts` is a 1:1 mirror of the live database, including Sprint 1's new tables. Every service you write this sprint is typed against this file — if it's stale, you'll get green compiles that crash at runtime.

### 2.1 — Regenerate from the live schema (manual)

`kysely-codegen` reads `DATABASE_URL` from the environment and introspects the actual database — so it always reflects what migrated, regardless of the doc's theoretical migration list.

```bash
cd apps/api

# kysely-codegen auto-detects the postgres dialect from the URL.
# (If your Sprint 0 pinned an explicit script, use it: pnpm db:codegen)
DATABASE_URL="postgresql://skaly:localdev@localhost:5432/skaly_dev" \
  npx kysely-codegen --out-file ../../packages/shared/src/db.types.ts

cd ../..
```

### 2.2 — Review the diff (manual)

```bash
git diff packages/shared/src/db.types.ts
```

Expected outcome: either **"no changes"** (Sprint 0's codegen already captured everything and Sprint 1 regenerated as it went) **or** new interfaces for the Sprint 1 tables — most importantly `MfaRecoveryCodes`. If `mfa_recovery_codes` is **missing** from the generated types, your local DB hasn't applied `029` — go back to STEP 1.1 and migrate.

### 2.3 — Prompt: reconcile any drift and typecheck

> **WHERE WE ARE**
>
> Sprint 2, STEP 2. I just regenerated `packages/shared/src/db.types.ts` from the live database with `kysely-codegen`. Here is the diff: [paste the `git diff` output, or write "no changes"].
>
> **WHAT TO DO**
>
> 1. Confirm the generated `DB` interface includes every table from `database/migrations` 001 through the highest number on disk — including `mfa_recovery_codes` (migration 029) and any 027/028 tables Sprint 1 added.
> 2. If any hand-written type in `packages/shared/src/` (e.g. domain types, Zod-inferred types) duplicates or contradicts a generated table type, point it out. We keep the generated `db.types.ts` as the single source for **row** shapes; Zod schemas remain the source for **request/response** shapes.
> 3. Run `pnpm typecheck` across all packages and fix any breakage caused by the regenerated types (renamed columns, nullability changes). Do not loosen types to make errors disappear — fix the call site.
>
> **RULES**
>
> - Never hand-edit `db.types.ts`. It is generated. If a column is wrong, the fix is a migration, not a type edit.
> - `version`, `deleted_at`, and `changed_by_source` must all appear in the generated types on their respective tables. If `version` is missing on `attendance_logs` / `content_pipelines` / `content_calendar`, stop — the schema didn't migrate correctly.
>
> Show me the result of `pnpm typecheck`.

**Verify:**

```bash
pnpm typecheck        # green across @skaly/shared, @skaly/api, @skaly/web
```

Commit the types now so the rest of the sprint builds on a stable base:

```bash
git add packages/shared/src/db.types.ts
git commit -m "Sprint 2: regenerate Kysely types from live schema (incl. mfa_recovery_codes)"
```

---

## SPRINT 2 — STEP 3: Dependencies + shared constants

**Goal:** Install the packages Sprint 2 needs (Swagger, the socket test client, the S3 presigner if Sprint 1 didn't already pull it) and add the two shared constants the services depend on.

### 3.1 — Install backend dependencies (manual)

```bash
# Swagger (Fastify 5 compatible major versions)
pnpm --filter @skaly/api add @fastify/swagger@^9 @fastify/swagger-ui@^5

# R2 presigner (skip the ones already present from Sprint 1's CV upload)
pnpm --filter @skaly/api add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner

# Socket.io server + Redis adapter (adapter may already be in package.json from Sprint 0 — Master Build Guide STEP 5/the redis-adapter DoD item)
pnpm --filter @skaly/api add socket.io @socket.io/redis-adapter ioredis

# Test-only: socket client for the NotificationService integration test
pnpm --filter @skaly/api add -D socket.io-client
```

> **Heads-up:** `@socket.io/redis-adapter` v8 expects two ioredis clients (a publisher and a duplicated subscriber). Upstash supports Redis pub/sub, so the adapter works against your `rediss://` URL — no extra Upstash configuration. Confirm `ioredis` is a **prod** dependency (the adapter and presence both use it at runtime).

### 3.2 — Prompt: shared constants and error-code coverage

> **WHERE WE ARE**
>
> Sprint 2, STEP 3. Dependencies installed. Now I need two foundational constants in `packages/shared` and to confirm the error registry is complete before services start throwing.
>
> **WHAT TO BUILD**
>
> 1. **`packages/shared/src/constants/system.ts`** — export `export const SYSTEM_ACTOR_UUID = '00000000-0000-0000-0000-000000000000' as const;` This is the fixed System Actor row seeded in `database/seeds/001_system_actor.ts`. Every automated/system audit write uses it (audit C-04). Re-export it from the package index.
>
> 2. **Confirm the `AppError` infrastructure from Sprint 0 covers every code this sprint needs.** Open `apps/api/src/lib/errors.ts` (or wherever Sprint 0 put `AppError` + the global handler per `09-ERROR-HANDLING.md` §4). Ensure these codes exist with the right HTTP status, and add any that are missing:
>    - `PERIOD_LOCKED` → 423
>    - `STALE_DATA` → 409 (carries `details.currentVersion`, `details.updatedBy`)
>    - `RESOURCE_NOT_FOUND` → 404
>    - `PERIOD_NOT_FOUND` → 404
>    - `VALIDATION_ERROR` → 400
>    - `PERMISSION_DENIED` → 403
>    Do not duplicate the global error handler — only extend the code table if a code is absent.
>
> **RULES**
>
> - `SYSTEM_ACTOR_UUID` is defined **once**, in `packages/shared`, and imported everywhere. No string literals of the zero-UUID anywhere else in the codebase.
> - The error shape stays exactly `{ error: { code, message, details? } }` per `09-ERROR-HANDLING.md` §1. Don't invent a new envelope.
>
> Show me `system.ts` and the final list of error codes with their statuses.

**Verify:**

```bash
pnpm typecheck
```

---

## SPRINT 2 — STEP 4: `BaseService` utilities (C-02 + H-02)

**Goal:** The four utilities every service from Sprint 3 onward composes with. Get these exactly right — `optimisticUpdate` and `softDelete` in particular are reused dozens of times.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 2, STEP 4. Constants and errors are in place. Now I'm building the base service utilities. Read `docs/06-IMPLEMENTATION-PLAN.md` §5 and `docs/05-BACKEND-SCHEMA.md` (the `months` table and the `version` columns).
>
> **WHAT TO BUILD**
>
> Create `apps/api/src/services/BaseService.ts` and `apps/api/src/lib/queries.ts`.
>
> 1. **`assertPeriodNotLocked(period: string, trx: Kysely<DB> | Transaction<DB>): Promise<void>`** (in `BaseService.ts`)
>    - `SELECT locked FROM months WHERE period = $1`.
>    - If no row → throw `AppError('PERIOD_NOT_FOUND', 404)`.
>    - If `locked === true` → throw `AppError('PERIOD_LOCKED', 423)`.
>    - Else return.
>
> 2. **`optimisticUpdate<T>(table, id, expectedVersion, patch, trx)`** — **audit C-02** (in `BaseService.ts`)
>    - Runs `UPDATE {table} SET ...patch, version = version + 1, updated_at = now() WHERE id = $id AND version = $expectedVersion RETURNING *`.
>    - If `numUpdatedRows === 0` (or no row returned): the version was stale. Re-`SELECT` the current row to read `version` and `updated_by`, then throw `AppError('STALE_DATA', 409, { currentVersion, updatedBy: { staffId, name } })`. Resolve `updatedBy.name` by joining/selecting from `staff`.
>    - On success: return the full updated row (PATCH endpoints return the whole row per `07-API-CONTRACT.md` §1.1 — audit C-02's sibling fix).
>    - Only valid for tables that have a `version` column: `attendance_logs`, `content_pipelines`, `content_calendar`. Type-constrain so it can't be called on a versionless table.
>
> 3. **`getCurrentPeriod(trx): Promise<MonthsRow>`** (in `BaseService.ts`)
>    - The `months` table has **no** `is_current`/`status` column. Compute the current period string as the present month in **Asia/Kolkata** (`YYYY-MM`) using date-fns. The server runs `TZ=Asia/Kolkata` (INFRA §6) but compute it explicitly so it's correct regardless of host TZ — use `date-fns-tz` `formatInTimeZone(new Date(), 'Asia/Kolkata', 'yyyy-MM')` if available, else format with the IST offset.
>    - `SELECT * FROM months WHERE period = $current`. If found, return it.
>    - If not found (e.g. before the first-ever rollover), fall back to `SELECT * FROM months ORDER BY period DESC LIMIT 1`. If still nothing, throw `AppError('PERIOD_NOT_FOUND', 404)`.
>
> 4. **`softDelete(table, id, deletedBy, trx)`** + **`softDeletable<QB>(qb)`** — **audit H-02** (in `lib/queries.ts`)
>    - `softDelete`: `UPDATE {table} SET deleted_at = now() WHERE id = $1 RETURNING *`. The **calling service** writes the corresponding `audit_log` row (with `action: 'DELETE'`) — `softDelete` only flips the timestamp and returns the row. Only for tables with `deleted_at`: `staff`, `clients`, `tasks`, `messages` (type-constrain).
>    - `softDeletable`: a query-builder helper that appends `.where('deleted_at', 'is', null)`. Every SELECT on a soft-deletable table must go through this. Document the rule in a comment block at the top of `queries.ts`.
>
> 5. **Unit tests** `apps/api/test/services/BaseService.test.ts` (real local Postgres, `NODE_ENV=test`):
>    - `assertPeriodNotLocked` throws `PERIOD_LOCKED` on a locked period, `PERIOD_NOT_FOUND` on a missing one, returns on an unlocked one.
>    - `optimisticUpdate` succeeds and increments `version` on a matching version; throws `STALE_DATA` with `details.currentVersion` on a mismatch.
>    - `softDelete` sets `deleted_at`; a subsequent `softDeletable` SELECT excludes the row.
>    - `getCurrentPeriod` returns the IST-current month when it exists; falls back to the latest period when it doesn't.
>
> **RULES**
>
> - Every utility takes a `trx` parameter and runs inside the caller's transaction — never opens its own.
> - `optimisticUpdate` is the **only** sanctioned way to write a versioned row. No service does a bare `UPDATE` on `attendance_logs` / `content_pipelines` / `content_calendar`.
> - Do not catch-and-swallow Postgres errors. Let them bubble to the global handler.
> - **Verify before moving on.** Write the utilities, then the unit tests, get them green, then stop.
>
> Start with `BaseService.ts`. Show me the four signatures, then the implementations.

**Verify:**

```bash
pnpm --filter @skaly/api test services/BaseService.test
pnpm typecheck
```

---

## SPRINT 2 — STEP 5: `AuditService` (real) + reconcile Sprint 1 call sites (C-04)

**Goal:** Replace the Sprint 1 `pino.info` placeholder with a real `AuditService` that writes to `audit_log` through the correct lockdown path, with a non-NULL `staff_id` always, and migrate the Sprint 1 call sites onto the real signature **and the real `action` enum**.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 2, STEP 5. `BaseService` is in place. Now I'm building the real `AuditService` and retiring the Sprint 1 placeholder. Read `docs/05-BACKEND-SCHEMA.md` §6 (the `audit_log` table and its CHECK constraints) carefully.
>
> **CONTEXT YOU MUST RESPECT**
>
> - In Sprint 0, `audit_log` was write-locked (audit B-01). My lockdown style is: **[paste from STEP 1.3 — either "(A) only UPDATE/DELETE revoked, INSERT still granted" or "(B) INSERT also revoked + a SECURITY DEFINER function named `___`"]**.
> - The Sprint 1 placeholder `auditServiceLog(...)` is called from `AuthService` with this arg shape: `{ actorId, entity, entityId, action, before, after, trx }` and dotted action strings like `'invite.create'`, `'staff.create'`. Those dotted strings are **not** valid — `audit_log.action` is constrained to `('INSERT','UPDATE','DELETE','LOCK','UNLOCK','DEACTIVATE')`.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/src/services/AuditService.ts`** — `class AuditService` (or a factory taking `db`) exposing:
>    `log({ actorId, actorSource, entity, entityId, action, before, after, ip, trx })` where:
>    - `actorId` → `audit_log.staff_id`. **Audit C-04:** if `actorId` is null/undefined (automated context), use `SYSTEM_ACTOR_UUID` from `@skaly/shared`. `staff_id` is **never NULL**.
>    - `actorSource` → `audit_log.changed_by_source`, enum `'user' | 'system' | 'bot'`, **default `'user'`**. Use `'system'` whenever `actorId` falls back to `SYSTEM_ACTOR_UUID`.
>    - `entity` → `audit_log.table_name` (the literal table name string, e.g. `'invite_links'`, `'staff'`).
>    - `entityId` → `audit_log.record_id`.
>    - `action` → `audit_log.action`, must be one of the six enum values.
>    - `before` → `old_value` (JSONB), `after` → `new_value` (JSONB).
>    - `ip` → `ip_address` (INET), nullable.
>    - **Write path depends on the lockdown style above:** if (A), a direct parameterised Kysely `insertInto('audit_log')` inside `trx`. If (B), call the `SECURITY DEFINER` function via `sql\`SELECT <fn>(...)\`.execute(trx)`. Either way the row lands the same.
>
> 2. **Migrate the Sprint 1 call sites.** Find every `auditServiceLog(...)` / placeholder call in `AuthService` and replace it with `auditService.log(...)`, mapping the dotted actions onto the enum + `table_name`:
>    | Sprint 1 placeholder | `action` | `entity` (table_name) |
>    |---|---|---|
>    | `invite.create` | `INSERT` | `invite_links` |
>    | `staff.create` (invite consume + approve) | `INSERT` | `staff` |
>    | invite consumed (`used_at` set) | `UPDATE` | `invite_links` |
>    | signup request created | `INSERT` | `signup_requests` |
>    | signup approved | `UPDATE` | `signup_requests` |
>    | signup rejected | `UPDATE` | `signup_requests` |
>    | MFA enrolled (`mfa_enrolled` flip) | `UPDATE` | `staff` |
>    Keep the human-readable detail in `before`/`after` JSONB, not in `action`.
>
> 3. **Tests** `apps/api/test/services/AuditService.test.ts`:
>    - `log` with a real `actorId` writes a row with that `staff_id` and `changed_by_source = 'user'`.
>    - `log` with `actorId = null` writes `staff_id = SYSTEM_ACTOR_UUID` and `changed_by_source = 'system'` (audit C-04).
>    - `log` with an invalid `action` (e.g. `'invite.create'`) is **rejected** — assert the CHECK constraint or a pre-validation guard catches it. (This proves the migration in step 2 actually fixed the call sites.)
>    - A re-run of one Sprint 1 auth integration test (e.g. invite create) still passes with the real AuditService swapped in, and an `audit_log` row now exists for it.
>
> **RULES**
>
> - `staff_id` is non-NULL on every single row. No exceptions. This is the whole point of the System Actor pattern.
> - Never `UPDATE` or `DELETE` `audit_log` from application code. Append only.
> - The arg shape stays `{ actorId, actorSource, entity, entityId, action, before, after, trx }` so the Sprint 1 swap is a near-mechanical find-and-replace.
> - **Verify before moving on.** Build the service, migrate the call sites, run the AuditService tests **and** re-run `pnpm --filter @skaly/api test auth/` to confirm Sprint 1 still passes.
>
> Start with `AuditService.ts`. Show me `log()`, then the call-site migration diff.

**Verify:**

```bash
pnpm --filter @skaly/api test services/AuditService.test
pnpm --filter @skaly/api test auth/          # Sprint 1 must still be green with the real service
pnpm typecheck
```

---

## SPRINT 2 — STEP 6: `EventBus` (typed; declare the two triggers)

**Goal:** A typed in-process event emitter that declares the two cross-module trigger events. **No listeners this sprint** — Trigger 1 is wired in Sprint 6, Trigger 2 in Sprint 7. We declare the contract now so those sprints just attach handlers.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 2, STEP 6. Now the cross-module event bus. Read `docs/02-TRD.md` §5.3 (the EventBus example) and `docs/05-BACKEND-SCHEMA.md` for the payload fields.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/src/lib/EventBus.ts`** — a singleton wrapping Node's `EventEmitter` with a **typed** emit/on surface. Define an interface mapping event name → payload:
>    - `'shoot:confirmed'` → `{ clientId: string; period: string; slotDate: string }` (Trigger 1 → Content Dropper, Sprint 6)
>    - `'pipeline:posted'` → `{ clientId: string; period: string; postedAt: string }` (Trigger 2 → Content Calendar, Sprint 7)
>    Export a typed `emit<E>(event, payload)` and `on<E>(event, handler)` so a wrong payload is a compile error.
>
> 2. **Do not attach any listeners.** Add a short comment in the file: "Listeners attached in Sprint 6 (shoot:confirmed → ContentDropperService.setComingShootDate) and Sprint 7 (pipeline:posted → ContentCalendarService.updateCell)."
>
> 3. **Test** `apps/api/test/lib/EventBus.test.ts`: emitting `shoot:confirmed` with a typed payload invokes a registered handler with that exact payload; a wrong-shaped payload fails to compile (demonstrate with a `// @ts-expect-error` line).
>
> **RULES**
>
> - The bus is process-local. It is **not** the Socket.io layer — cross-instance fan-out is Socket.io's job (STEP 7), the EventBus is for in-process service-to-service triggers.
> - Keep it tiny. No retries, no persistence — triggers run inline after the originating transaction commits (the service emits *after* COMMIT, per `02-TRD.md` §5.2).
>
> Show me `EventBus.ts`.

**Verify:**

```bash
pnpm --filter @skaly/api test lib/EventBus.test
pnpm typecheck
```

---

## SPRINT 2 — STEP 7: Socket.io scaffold + Redis presence

**Goal:** Boot Socket.io with the three canonical namespaces, the Redis adapter (so Railway rolling deploys don't drop broadcasts), JWT handshake auth that **reuses** the Sprint 1 verifier, room joins, and the Redis presence model. This is the real-time backbone for chat (Sprint 10), bot streaming (Sprint 8), and live grid updates.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 2, STEP 7. Building the Socket.io server. Read `docs/02-TRD.md` §8 (namespaces, reconnection, presence, room joins) and `docs/07-API-CONTRACT.md` §6 (the event tables). Read `docs/11-THIRD-PARTY-INTEGRATIONS.md` §5 (Redis presence key).
>
> **WHAT TO BUILD**
>
> 1. **Extract the JWT verifier.** My Sprint 1 `apps/api/src/middleware/auth.plugin.ts` verifies Supabase JWTs (RS256 via JWKS) and looks up the staff row. Extract the pure verification + staff-lookup into a reusable `verifySupabaseToken(token: string): Promise<{ staffId, role, email, active }>` in `apps/api/src/lib/auth-verify.ts`, and have the HTTP auth plugin call it too (no behaviour change to the plugin). The socket handshake will reuse this — do not reimplement JWT verification.
>
> 2. **`apps/api/src/sockets/index.ts`** — `initSockets(httpServer)`:
>    - Create the Socket.io v4 server on the existing Fastify HTTP server.
>    - **Redis adapter:** `const pub = new Redis(process.env.REDIS_URL, { tls: process.env.REDIS_URL.startsWith('rediss') ? {} : undefined }); const sub = pub.duplicate(); io.adapter(createAdapter(pub, sub));` (per `02-TRD.md` §8 — this is the Sprint 0 DoD item; if it already exists, fold it in, don't duplicate).
>    - **Three namespaces:** `/ws/chat`, `/ws/presence`, `/ws/notify`. (NOT `/portal`,`/bot`,`/presence`.)
>    - **Handshake auth on each namespace:** read the token from `socket.handshake.auth.token`, call `verifySupabaseToken`. On failure, reject the connection. On success, attach `{ staffId, role }` to the socket and continue.
>    - **Room joins (audit H-05 preview):** on every authenticated connect (all three namespaces), `socket.join('user:' + staffId)`, `socket.join('role:' + role)`, `socket.join('org:all')`. Full H-05 test lands in Sprint 10; wire the joins now.
>    - **Apply the Sprint 0 `socketTokenWatcher` plugin (C-05)** to each namespace's connection so a JWT that expires mid-session triggers the refresh/disconnect flow. Do not write a new watcher — import and apply the existing one.
>    - Configure reconnection-friendly server options consistent with the client config in `02-TRD.md` §8.
>
> 3. **`apps/api/src/sockets/presence.ts`** — on `/ws/presence` connect:
>    - `await redis.set('presence:' + staffId, '1', 'EX', 60);`
>    - Handle a `presence:ping` client event every 30s → `await redis.expire('presence:' + staffId, 60);`
>    - On disconnect: do nothing (the 60s TTL expires the key naturally, per `11-THIRD-PARTY-INTEGRATIONS.md` §5).
>    - Expose a small helper `getOnlineStaffIds(): Promise<string[]>` that scans `presence:*` (used by chat in Sprint 10).
>
> 4. **Boot it.** In `apps/api/src/server.ts`, call `initSockets(server.server)` after the Fastify instance is built (server starts listening). Make the `io` instance importable by services (NotificationService in STEP 8 needs `io.of('/ws/notify').to('user:'+id).emit(...)`).
>
> 5. **Test** `apps/api/test/sockets/connect.test.ts` (using `socket.io-client`): a client connecting to `/ws/notify` with a valid stubbed token connects successfully and is joined to `user:{staffId}` (assert by emitting a server-side broadcast to that room and receiving it on the client). A client with an invalid token is rejected.
>
> **RULES**
>
> - Namespaces are `/ws/chat`, `/ws/presence`, `/ws/notify` — match `02-TRD.md` §8 exactly.
> - The handshake uses the **same** verifier as HTTP. One source of truth for "is this token valid + who is it."
> - Presence keys never get an explicit `DEL` on disconnect — TTL only. (Avoids flicker on brief network blips.)
> - **Verify before moving on.** Boot the server, run the socket connect test, confirm a room broadcast round-trips.
>
> Start by extracting `verifySupabaseToken`. Show me that, then `sockets/index.ts`.

**Verify:**

```bash
pnpm --filter @skaly/api test sockets/connect.test
pnpm --filter @skaly/api dev      # in another terminal: server boots, logs "socket.io listening on /ws/chat,/ws/presence,/ws/notify"
pnpm typecheck
```

---

## SPRINT 2 — STEP 8: `NotificationService` (real — DB write + socket emit)

**Goal:** Replace the Sprint 1 notification placeholder with a real service that writes a `notifications` row **and** emits `notify:new` to the recipient's `user:` room on `/ws/notify`. This is what Sprint 1's approve/reject already calls.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 2, STEP 8. Socket.io is live. Now the real `NotificationService`, replacing the Sprint 1 placeholder. Read `docs/05-BACKEND-SCHEMA.md` (the `notifications` table + its type enum) and `docs/02-TRD.md` §10.2 (delivery flow) and `docs/07-API-CONTRACT.md` §6 (event name).
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/src/services/NotificationService.ts`** — `create({ recipientId, type, title, body, data, trx })`:
>    - Insert into `notifications`: `{ staff_id: recipientId, type, title, message: body, payload: data ?? {}, is_read: false }`. (Column names are `staff_id` / `message` / `payload` — map them.)
>    - `type` must be one of the values in the `notifications_type_check` enum (18 values). **Validate against the enum/type — do not hardcode the number 18.** Reject an unknown type with `VALIDATION_ERROR`.
>    - After the row is written, emit over Socket.io: `io.of('/ws/notify').to('user:' + recipientId).emit('notify:new', notificationRow);` (event name is `notify:new`, per `02-TRD.md` §10.2 — NOT `notification:new`).
>    - If the recipient is offline, the row is still in the DB for later `GET /v1/notifications` (offline delivery). The emit is fire-and-forget; a failed emit must not roll back the DB write.
>
> 2. **Swap the Sprint 1 placeholder.** Replace `notificationServiceCreate(...)` calls in `AuthService` (signup approved → `signup_approved`; signup rejected → `signup_rejected`; the rejected notification carries **only** `public_rejection_message`, never `rejection_note`) with `notificationService.create(...)`. Re-confirm the rejection-privacy test from Sprint 1 still passes against the real service.
>
> 3. **Tests** `apps/api/test/services/NotificationService.test.ts`:
>    - `create` writes a `notifications` row with correct `staff_id`, `type`, `message`, `payload`.
>    - `create` emits `notify:new` to `user:{recipientId}` — assert with a `socket.io-client` connected to `/ws/notify` joined to that room.
>    - An unknown `type` is rejected with `VALIDATION_ERROR`.
>    - Re-run: rejection notification payload contains the public message and **never** the internal `rejection_note` (Sprint 1's privacy test, now against the real service).
>
> **RULES**
>
> - DB write first, emit second. A socket failure never loses a notification.
> - `rollover_failed` is special (full text, never truncated, never auto-dismiss) — that handling is Sprint 12; for now just make sure the `type` is in the enum and the row writes.
> - **Verify before moving on.** Build, swap call sites, run the NotificationService tests **and** re-run Sprint 1 auth tests.
>
> Show me `NotificationService.create`, then the AuthService swap diff.

**Verify:**

```bash
pnpm --filter @skaly/api test services/NotificationService.test
pnpm --filter @skaly/api test auth/      # Sprint 1 rejection-privacy test still green
pnpm typecheck
```

---

## SPRINT 2 — STEP 9: R2 presigned-URL utilities

**Goal:** Reusable presign helpers that Sprint 4 (task attachments), Sprint 12 (report downloads), and the avatar flow all depend on. 15-minute upload TTL, 1-hour download TTL, per `11-THIRD-PARTY-INTEGRATIONS.md` §4.3.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 2, STEP 9. Building the R2 presign utilities. Read `docs/11-THIRD-PARTY-INTEGRATIONS.md` §4 (R2 config, SDK setup, the named TTL constants).
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/src/lib/r2.ts`**:
>    - Construct the S3 client once: `new S3Client({ region: 'auto', endpoint: process.env.R2_ENDPOINT, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! } })`.
>    - Export the named TTL constants exactly as the spec mandates: `const UPLOAD_EXPIRY_SECONDS = 900; const DOWNLOAD_EXPIRY_SECONDS = 3600; const REPORT_EXPIRY_SECONDS = 86400;` — never hardcode raw numbers at call sites.
>    - `getPresignedUploadUrl(key: string, contentType: string, ttlSeconds = UPLOAD_EXPIRY_SECONDS): Promise<string>` → `getSignedUrl(client, new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key, ContentType: contentType }), { expiresIn: ttlSeconds })`.
>    - `getPresignedDownloadUrl(key: string, ttlSeconds = DOWNLOAD_EXPIRY_SECONDS): Promise<string>` → `getSignedUrl(client, new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }), { expiresIn: ttlSeconds })`.
>    - (Optional, if Sprint 1's CV upload duplicated this — consolidate the CV upload to reuse this client; don't keep two S3 clients.)
>
> 2. **Tests** `apps/api/test/lib/r2.test.ts`:
>    - `getPresignedUploadUrl` returns a URL string containing the bucket and key and an `X-Amz-Expires=900` query param.
>    - `getPresignedDownloadUrl` returns a URL with `X-Amz-Expires=3600`.
>    - (These assert URL *shape*; they do not hit R2 over the network.)
>
> **RULES**
>
> - The `ContentType` on the PUT presign must be passed through so the browser's `Content-Type` header matches the signed request (R2 rejects a mismatch). The frontend will send the same `Content-Type` on its PUT.
> - One S3 client for the whole app. One set of TTL constants. No magic numbers.
>
> Show me `r2.ts`.

**Verify:**

```bash
pnpm --filter @skaly/api test lib/r2.test
pnpm typecheck
```

---

## SPRINT 2 — STEP 10: Read endpoints — clients, months, staff

**Goal:** The first real GET endpoints, returning the exact shapes in `07-API-CONTRACT.md` §2–§4, with role-correct field filtering (Auth Matrix) and soft-delete filtering (H-02). Most later sprints assume these exist (task assignment dropdowns, period selector, @mention list).

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 2, STEP 10. Base patterns and services are in place. Now the read endpoints. Read `docs/07-API-CONTRACT.md` §2 (clients), §3 (months — `GET /v1/months`, `GET /v1/months/current`), §4 (`GET /v1/staff`, `GET /v1/staff/:id`, `GET /v1/staff/me`, `GET /v1/staff/:id/profile`), and `docs/08-AUTH-MATRIX.md` §3–§4 for who sees what.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/src/services/ClientService.ts` + route `routes/clients/`:**
>    - `GET /v1/clients` — all authenticated roles. Active clients only by default; `?includeInactive=true` returns inactive too but **admin only** (403 otherwise). Use `softDeletable` so soft-deleted clients never appear. Shape per API Contract §2.
>
> 2. **`apps/api/src/services/MonthService.ts` + route `routes/months/`:**
>    - `GET /v1/months` — list of month rows (period, label, locked, lock metadata), newest first.
>    - `GET /v1/months/current` — calls `BaseService.getCurrentPeriod`. Returns the current month row.
>
> 3. **`StaffService` + route `routes/staff/`** (some of this may exist from Sprint 1 — extend, don't duplicate):
>    - `GET /v1/staff` — all roles. **Limited** fields only: `{ id, name, role, avatarUrl, isOnline }`. `isOnline` comes from the presence helper (`getOnlineStaffIds`). Use `softDeletable`.
>    - `GET /v1/staff/:id` — full profile. **admin, manager, or own row only** (else 403). Full fields per API Contract §4. Note: returning `cvFileKey` for the user's *own* profile is intentional (NFR §4.2).
>    - `GET /v1/staff/me` — the authenticated user's own full profile (audit C-04 from the pre-build audit — added so the frontend never has to decode its own JWT). Same shape as `/:id` with `:id = request.user.staffId`.
>    - `GET /v1/staff/:id/profile` — public-safe `{ id, name, role, avatarUrl }`, all roles. (Used by team_member/freelancer search results.)
>
> 4. **Tests** `apps/api/test/routes/reads.test.ts`:
>    - `GET /v1/clients` returns 200 with an empty list on a fresh DB; a soft-deleted client never appears.
>    - `?includeInactive=true` returns 403 for a non-admin.
>    - `GET /v1/months/current` returns the IST-current month.
>    - `GET /v1/staff` returns only the limited fields (assert `email` / `dateOfBirth` are **absent**).
>    - `GET /v1/staff/:id` returns 403 when a team_member requests another staff member's full profile; 200 for own; 200 for admin.
>    - `GET /v1/staff/me` returns the caller's own full profile.
>
> **RULES**
>
> - Field filtering is enforced **server-side** in the service/route, not by trusting the client to ask for the right fields.
> - Every SELECT on `staff` / `clients` goes through `softDeletable`.
> - Zod-validate query params (`includeInactive`, etc.) via `fastify-type-provider-zod` so they appear in Swagger (STEP 11).
> - These are reads — no `audit_log` writes, no `assertPeriodNotLocked`.
> - **Verify before moving on.** Build services, then routes, then tests.
>
> Start with `ClientService` + its route. Show me when the three route groups are wired.

**Verify:**

```bash
pnpm --filter @skaly/api test routes/reads.test
pnpm typecheck
```

---

## SPRINT 2 — STEP 11: Swagger UI (M-12, dev-only)

**Goal:** Live, browsable API docs at `/docs` in non-production — derived automatically from the Zod schemas you already attached to routes. Frontend devs explore the API here instead of re-reading the contract by hand.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 2, STEP 11. Read endpoints exist. Now Swagger (audit M-12). I installed `@fastify/swagger` v9 + `@fastify/swagger-ui` v5, and I'm using `fastify-type-provider-zod` (installed Sprint 1).
>
> **WHAT TO BUILD**
>
> 1. In `apps/api/src/server.ts`, **gate the entire Swagger registration behind `if (process.env.NODE_ENV !== 'production')`** (audit M-12 — never expose `/docs` in prod).
> 2. Register `@fastify/swagger` with the Zod transform so the Zod route schemas become OpenAPI: import `jsonSchemaTransform` from `fastify-type-provider-zod` and pass it as the `transform` option. Set basic `openapi` info (title "Scaly Business Portal API", version from package.json, server `http://localhost:3001`).
> 3. Register `@fastify/swagger-ui` mounted at `routePrefix: '/docs'`.
> 4. **Order matters:** both Swagger plugins must be registered **before** the route plugins so they capture the schemas. Verify the registration order in `server.ts`.
>
> **RULES**
>
> - `/docs` exists only when `NODE_ENV !== 'production'`. Add a one-line test or a manual note that hitting `/docs` in a `NODE_ENV=production` boot 404s.
> - Don't hand-write OpenAPI — it comes from the Zod validators via `jsonSchemaTransform`. If a route has no Zod schema, it'll appear under-documented; that's a signal to add the schema, not to hand-write JSON.
>
> Show me the `server.ts` registration block.

**Verify (manual):**

```bash
pnpm --filter @skaly/api dev
# Open http://localhost:3001/docs in a browser.
# You should see: auth/* (Sprint 1), clients, months, staff routes, each with request/response schemas.
```

---

## SPRINT 2 — STEP 12: Wire-up in `server.ts` + M-06 header verify + full suite

**Goal:** Every new route plugin is registered in the correct plugin order; rate-limit headers are confirmed present (audit M-06); the whole suite and typecheck are green before close-out.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 2, STEP 12. Final wiring. Read `docs/02-TRD.md` §5.1 (the canonical Fastify plugin registration order) and `docs/07-API-CONTRACT.md` §2 (rate-limit table).
>
> **WHAT TO BUILD / VERIFY**
>
> 1. **Confirm plugin order in `apps/api/src/server.ts`** matches `02-TRD.md` §5.1: `@fastify/helmet` → `@fastify/cors` (portal.skaly.in + localhost:3000 only) → `@fastify/rate-limit` → auth plugin → rbac/role helpers → Swagger (dev-only) → route plugins (auth, staff, clients, months, …) → internal routes (X-Internal-Secret). Register the new `clients` / `months` / `staff` route plugins in this order.
> 2. **Audit M-06:** ensure `@fastify/rate-limit` is configured with header emission on (`addHeaders` for `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`). Add a route test that hits any endpoint and asserts those three headers are present on the response.
> 3. **Confirm the global error handler** (Sprint 0, `09-ERROR-HANDLING.md` §4) is registered and catches `AppError`, Zod validation errors (→ `VALIDATION_ERROR` 400), and rate-limit 429s with `Retry-After`.
> 4. Run the full API test suite and typecheck.
>
> **RULES**
>
> - CORS stays restricted to `https://portal.skaly.in` + `http://localhost:3000`. No wildcard.
> - The `/v1/internal/*` routes use the `internalAuth` plugin (X-Internal-Secret), **not** the JWT auth plugin. Confirm they're registered separately.
>
> Show me the final `server.ts` plugin order and the M-06 header test.

**Verify:**

```bash
pnpm --filter @skaly/api test          # full API suite green
pnpm --filter @skaly/web test          # frontend hook tests still green
pnpm typecheck                          # all packages
pnpm lint                               # if Sprint 1 hardened lint with --max-warnings 0, keep it clean
```

---

## SPRINT 2 — STEP 13: End-to-end smoke + commit + close-out (manual)

**Goal:** Walk the sprint's surface by hand, then commit and verify CI before declaring Sprint 2 done.

### 13.1 — Manual smoke walk-through

```bash
# Boot everything
docker compose up -d
pnpm dev          # api on :3001, web on :3000
```

1. **Swagger:** open `http://localhost:3001/docs` — auth, clients, months, staff routes all listed with schemas.
2. **Reads (use the admin JWT from Sprint 1 — log in via `/login` and copy the token, or mint one against Supabase):**
   ```bash
   TOKEN="<admin access token>"
   curl -s http://localhost:3001/v1/clients -H "authorization: Bearer $TOKEN" | jq
   curl -s http://localhost:3001/v1/months/current -H "authorization: Bearer $TOKEN" | jq
   curl -s http://localhost:3001/v1/staff -H "authorization: Bearer $TOKEN" | jq   # limited fields only
   curl -s http://localhost:3001/v1/staff/me -H "authorization: Bearer $TOKEN" | jq # full own profile
   # Confirm rate-limit headers are present:
   curl -sD - http://localhost:3001/v1/clients -H "authorization: Bearer $TOKEN" -o /dev/null | grep -i x-ratelimit
   ```
3. **Audit trail:** trigger one auditable Sprint 1 action (e.g. invite a user from `curl`), then check a row landed:
   ```sql
   -- docker compose exec postgres psql -U skaly -d skaly_dev
   SELECT staff_id, changed_by_source, table_name, action, created_at
   FROM audit_log ORDER BY created_at DESC LIMIT 5;
   -- staff_id is never NULL; an automated entry shows the System Actor UUID + 'system'.
   ```
4. **Socket presence:** from a quick node REPL or the browser console, connect a `socket.io-client` to `ws://localhost:3001/ws/presence` with a valid token, emit `presence:ping`, then in Redis confirm the key:
   ```bash
   docker compose exec redis redis-cli
   > KEYS presence:*        # your staffId should appear
   > TTL presence:<staffId> # ~60 (resets on each ping)
   ```

### 13.2 — Close-out checklist

Do not start Sprint 3 until **every** box is checked:

```
DATA / TYPES
  [ ] db.types.ts regenerated from live DB; includes mfa_recovery_codes (+ any 027/028 tables)
  [ ] pnpm typecheck green across @skaly/shared, @skaly/api, @skaly/web

BASE PATTERNS
  [ ] assertPeriodNotLocked throws PERIOD_LOCKED / PERIOD_NOT_FOUND correctly
  [ ] optimisticUpdate increments version + throws STALE_DATA (409) on mismatch (C-02)
  [ ] softDelete + softDeletable helper exist; documented rule in lib/queries.ts (H-02)
  [ ] getCurrentPeriod computes IST month with latest-period fallback (no is_current column)

SERVICES
  [ ] AuditService.log writes a row; staff_id NEVER null; System Actor UUID + 'system' for automated (C-04)
  [ ] Sprint 1 audit call sites migrated to the action enum (no dotted 'invite.create' strings)
  [ ] Sprint 1 auth tests STILL green against the real AuditService
  [ ] NotificationService.create writes a row AND emits notify:new on /ws/notify
  [ ] Sprint 1 rejection-privacy test green against the real NotificationService (note never transmitted)
  [ ] EventBus declares shoot:confirmed + pipeline:posted (typed, no listeners yet)

REAL-TIME
  [ ] Socket.io boots with /ws/chat, /ws/presence, /ws/notify
  [ ] @socket.io/redis-adapter wired (pub + duplicated sub)
  [ ] Handshake reuses the Sprint 1 JWT verifier (verifySupabaseToken)
  [ ] On connect: joins user:{staffId}, role:{role}, org:all (H-05 preview)
  [ ] socketTokenWatcher (C-05) applied to the namespaces
  [ ] Presence: SET presence:{staffId} EX 60 + 30s ping refresh; TTL-only expiry

STORAGE
  [ ] r2.ts: getPresignedUploadUrl (900s) + getPresignedDownloadUrl (3600s); named TTL constants only

READ ENDPOINTS
  [ ] GET /v1/clients (active default; ?includeInactive admin-only)
  [ ] GET /v1/months + /v1/months/current
  [ ] GET /v1/staff (limited fields) + /v1/staff/:id (admin/manager/own) + /v1/staff/me + /:id/profile
  [ ] Role-correct field filtering enforced server-side; soft-deleted rows excluded

TOOLING
  [ ] Swagger UI at /docs, dev-only (M-12); 404 in NODE_ENV=production
  [ ] Rate-limit headers present on responses (M-06)
  [ ] Plugin order matches TRD §5.1; CORS restricted; internal routes use X-Internal-Secret
  [ ] pnpm lint clean; full test suite green
```

### 13.3 — Final commit

```bash
git add -A
git commit -m "Sprint 2: schema types, base service, audit/notif/events, socket scaffold, read endpoints (C-02, C-04, H-02, M-12)"
git push -u origin sprint-2-api-scaffold
```

Open the PR to `main`. CI runs typecheck + lint + migrations + Vitest. **All must pass before merge.** Merge, then:

```bash
git checkout main && git pull
```

### 13.4 — Move to Sprint 3

Open `MASTER-BUILD-GUIDE-V2-FINAL.md` → PART 9 → **SPRINT 3 — STAFF ATTENDANCE**, or the forthcoming `SPRINT-3-DETAILED.md`.

The Sprint 3 driving prompt assumes:
- `AttendanceService.backfillCurrentPeriod` (stubbed in Sprint 1) gets fully fleshed out using Sprint 2's `BaseService` + `optimisticUpdate`.
- `HolidayService.remove` will use a single transaction to revert attendance rows (audit H-01) — `AuditService` and `NotificationService` from this sprint are the building blocks.
- The attendance grid PATCH uses `optimisticUpdate` (C-02) and returns the full row.
- Team-member column ownership is enforced at the service layer; the frontend `pointer-events: none` is UX-only.

If any Sprint 2 close-out box is unchecked, **stop**. Sprint 3 is the first feature module and it leans on every pattern you just built.

---

## DECISIONS TO MAKE BEFORE SPRINT 3

- **`audit_log` write path (carried from STEP 1.3):** confirm in writing which lockdown style is live (direct INSERT vs SECURITY DEFINER function) so Sprint 3+ services all use the same `AuditService.log` path. If Sprint 0 used a function, document its exact signature next to `AuditService`.
- **Per-user permission overrides (`perms:{staffId}`) + `ROLE_DEFAULTS`:** not needed for Sprint 2's role-only read endpoints, but the override-resolution helper (Auth-Matrix §6) is first exercised by the **bot** (Sprint 8/9) and **freelancer chat** (Sprint 10). Decide now whether to build `packages/shared/src/constants/permissions.ts` (`ROLE_DEFAULTS`) + a `resolvePermission(staffId, key)` helper proactively at the start of Sprint 3, or defer to Sprint 8. Recommendation: stub `ROLE_DEFAULTS` now (cheap, it's just a constant map from Auth-Matrix §5), wire the resolver in Sprint 8.
- **`getCurrentPeriod` before the first rollover:** until Sprint 12's rollover runs, the only `months` row in staging is whatever Sprint 0's dev seed (`002_dev_data.ts`) inserted. Confirm the dev seed inserts a current-month row, or `GET /v1/months/current` will fall back to the latest (or 404 on an empty table). Add a current-month row to the dev seed if it's missing.
- **Socket namespace for bot streaming:** locked to `/ws/notify` in this guide (per TRD §8). If you ever reconsider a dedicated `/ws/bot` namespace, change it **before** Sprint 8 wires bot streaming — not after.

---

## TROUBLESHOOTING — SPRINT 2 SPECIFIC

### `kysely-codegen` outputs an empty or partial `DB` interface
Your `DATABASE_URL` points at a database that hasn't had all migrations applied. Run `pnpm --filter @skaly/api db:migrate`, confirm `db:status` shows 0 pending, then regenerate. If it still misses `mfa_recovery_codes`, migration 029 didn't run.

### `AuditService.log` throws `permission denied for table audit_log`
Your Sprint 0 lockdown revoked `INSERT` (style B) and exposed a `SECURITY DEFINER` function — but `AuditService` is doing a direct `insertInto`. Switch the write path to call the function (STEP 5, lockdown style B).

### `AuditService.log` throws a CHECK constraint violation on `action`
A Sprint 1 call site still passes a dotted string like `'invite.create'`. Map it to the enum (`INSERT`/`UPDATE`/`DELETE`/`LOCK`/`UNLOCK`/`DEACTIVATE`) + the literal `table_name` per the STEP 5 table.

### Socket client connects but never receives the room broadcast
Three usual causes: (1) you broadcast on the wrong namespace — `notify:new` and grid updates ride `/ws/notify`, not the default `/`; (2) the room join didn't run because the handshake rejected the token silently — log the handshake result; (3) the Redis adapter isn't wired and you're testing across two instances — for a single dev instance the adapter isn't strictly required, but wire it now anyway (it's the Sprint 0 DoD item).

### `notify:new` not delivered but the DB row exists
The recipient socket isn't in `user:{recipientId}`. Confirm the connect handler joins `user:` + staffId on `/ws/notify`, and that you're emitting to `'user:' + recipientId` (string-concatenated, matching the join exactly).

### Upstash Redis: adapter errors with `MOVED` / cluster complaints
You're pointing the adapter at a Redis Cluster endpoint. Upstash standard databases are single-node and work with the basic ioredis client; if you provisioned a clustered tier, use the non-cluster connection string or `ioredis` cluster mode consistently. For local dev, point `REDIS_URL` at `redis://localhost:6379` (Docker).

### R2 presigned PUT later returns 403 `SignatureDoesNotMatch`
The browser's `Content-Type` header on the PUT must match the `ContentType` passed into `getPresignedUploadUrl`. Pass the file's MIME type through both, and confirm the R2 bucket CORS allows the `Content-Type` header (set in Sprint 0).

### `GET /v1/months/current` returns 404 on staging
No `months` row for the current IST month and the table is empty. Add a current-month row to the dev seed (`002_dev_data.ts`), or accept that it 404s until Sprint 12's first rollover creates one. See "Decisions before Sprint 3."

### Swagger `/docs` is blank or missing routes
The Swagger plugins were registered **after** the route plugins. Move both `@fastify/swagger` and `@fastify/swagger-ui` registration **before** the route plugins in `server.ts`. Also confirm routes carry Zod schemas and that `jsonSchemaTransform` is passed as the `transform` option.

### Sprint 1 auth tests fail after swapping in real Audit/Notification services
The placeholder accepted a slightly different arg shape than the real service. Reconcile the call sites (STEP 5 + STEP 8 swap diffs). The real services' arg shapes are intentionally identical to the placeholders so the swap is mechanical — if a test fails, a call site wasn't migrated.

---

## END OF SPRINT 2 DETAILED GUIDE

*Companion document to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 and `SPRINT-1-DETAILED.md`. Source-of-truth precedence when this guide and the Master Build Guide differ: the numbered spec docs (`01`–`14`) win, then this guide's reconciliations, then the Master Build Guide's shorthand. Sprint 3 (`Staff Attendance`) depends on every pattern established here.*
