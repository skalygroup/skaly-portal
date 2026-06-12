# CRITICAL-PATCHES.md
## Scaly Business Portal — Drop-In Fixes for Pre-Build Audit Findings
**Companion to:** `14-PRE-BUILD-AUDIT.md` (V2.2)
**Status:** Final — Ready to apply

This document provides drop-in code, doc diffs, and configuration for the 3 blockers (B-XX), 6 criticals (C-XX), and 4 high-severity items requiring code (H-01, H-02, H-03, H-04, H-05). Each section is self-contained and can be applied independently.

---

## B-01  Migration 026 — Database Role Permissions

**File:** `database/migrations/026_database_roles.ts`
**Apply order:** AFTER 025_search_indexes.ts (the last data migration)
**Run command:** `pnpm --filter api db:migrate`

```typescript
// database/migrations/026_database_roles.ts
import { Kysely, sql } from 'kysely';

/**
 * Applies the least-privilege role permissions documented in
 * 05-BACKEND-SCHEMA.md §11.
 *
 * The most important effect is the REVOKE on audit_log — this is what
 * makes the "append-only" claim actually enforceable at the database
 * level. Without this migration, audit_log can be mutated by any
 * application bug.
 *
 * NOTE: This migration runs as the database SUPERUSER (Railway-provisioned
 * connection). The role being granted/revoked TO is `skaly_app` — the
 * application connection user. If your Railway PostgreSQL setup uses a
 * different application user, change the role name below.
 */

const APP_ROLE = 'skaly_app';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Ensure the application role exists. If not, this migration runs against
  // the connection's own role (PUBLIC schema permissions).
  // In Railway managed PG, the app commonly connects as the same user that
  // ran migrations. Substitute the actual application role here.

  // Base grants — all tables get SELECT/INSERT/UPDATE
  await sql`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${sql.raw(APP_ROLE)}`.execute(db);

  // DELETE permissions — only the tables that support hard delete
  await sql`GRANT DELETE ON tasks, task_assignees, task_attachments TO ${sql.raw(APP_ROLE)}`.execute(db);
  await sql`GRANT DELETE ON shoot_schedules, content_pipelines, content_calendar TO ${sql.raw(APP_ROLE)}`.execute(db);
  await sql`GRANT DELETE ON messages, message_mentions, comments, notifications TO ${sql.raw(APP_ROLE)}`.execute(db);
  await sql`GRANT DELETE ON invite_links, bot_sessions TO ${sql.raw(APP_ROLE)}`.execute(db);

  // task_time_logs: SELECT + INSERT only — no DELETE endpoint in MVP
  await sql`REVOKE DELETE, UPDATE ON task_time_logs FROM ${sql.raw(APP_ROLE)}`.execute(db);
  await sql`GRANT SELECT, INSERT ON task_time_logs TO ${sql.raw(APP_ROLE)}`.execute(db);

  // ─── CRITICAL: audit_log is append-only ────────────────────────────────
  // This is the actual security control. Without this REVOKE, the
  // "tamper-proof audit log" claim is documentation only.
  await sql`REVOKE UPDATE, DELETE ON audit_log FROM ${sql.raw(APP_ROLE)}`.execute(db);

  // Sequence permissions for newly inserted rows
  await sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${sql.raw(APP_ROLE)}`.execute(db);

  // Future tables created in this schema inherit these defaults
  await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO ${sql.raw(APP_ROLE)}`.execute(db);
  await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${sql.raw(APP_ROLE)}`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restore mutability — only used for a forced rollback. In practice,
  // this migration should never be rolled back on production.
  await sql`GRANT UPDATE, DELETE ON audit_log TO ${sql.raw(APP_ROLE)}`.execute(db);
  await sql`GRANT DELETE, UPDATE ON task_time_logs TO ${sql.raw(APP_ROLE)}`.execute(db);
}
```

**Verification test** — add to `apps/api/tests/integration/database-roles.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { db } from '@/db';

describe('Database role permissions (audit log append-only)', () => {
  test('UPDATE on audit_log throws permission denied', async () => {
    // First insert a row as a normal audit log entry
    const inserted = await db.insertInto('audit_log').values({
      staff_id: '00000000-0000-0000-0000-000000000000',
      changed_by_source: 'system',
      table_name: 'test',
      action: 'INSERT',
    }).returning('id').executeTakeFirstOrThrow();

    // Attempt to update it — must fail at DB role level
    await expect(
      db.updateTable('audit_log')
        .set({ table_name: 'tampered' })
        .where('id', '=', inserted.id)
        .execute()
    ).rejects.toThrow(/permission denied|insufficient privilege/i);
  });

  test('DELETE on audit_log throws permission denied', async () => {
    await expect(
      db.deleteFrom('audit_log').where('table_name', '=', 'test').execute()
    ).rejects.toThrow(/permission denied|insufficient privilege/i);
  });
});
```

---

## B-02  T1–T4 Template Fallback Design Decision

**Not a code patch.** Action item: end of Sprint 0 Day 5, document one of two paths in the spec.

**Path A (templates delivered on time):**
- Add `apps/web/components/templates/T1.tsx`, `T2.tsx`, `T3.tsx`, `T4.tsx`
- Sprint 1 auth UI imports these directly

**Path B (fallback — no templates by Sprint 1 start):**
- Add this to `06-IMPLEMENTATION-PLAN.md` §17 risk row for templates:

```markdown
> **B-02 Fallback resolution:** As of Sprint 0 close, T1–T4 template files
> have not been delivered. Sprint 1 proceeds with the fallback path:
>
> Auth UI components are built directly using shadcn/ui primitives with
> the CSS variables already defined in `globals.css` (per UI/UX §2.1).
>
> Fallback page structure:
> - Wrapper: `<div class="min-h-screen bg-[var(--bg-base)] flex items-center justify-center p-6">`
> - Card: shadcn/ui `<Card>` with `border-[var(--border-default)] bg-[var(--bg-elevated)]`
> - Heading: `font-display text-[32px] font-bold text-[var(--text-primary)]`
> - Body text: `font-body text-[14px] text-[var(--text-secondary)]`
> - CTA: shadcn/ui `<Button>` with `bg-[var(--accent-gold)] text-[var(--bg-base)] hover:bg-[var(--accent-gold-hover)]`
>
> When T1–T4 arrive later (mid-Sprint anytime), retrofit is cosmetic:
> swap the wrapper component, no logic changes required. Estimated
> retrofit time: 4 developer-hours per page (login, signup, signup/pending,
> mfa-setup, forgot-password, reset-password = ~24 hours total).
```

---

## B-03  Internal Auth Plugin — Timing-Safe Comparison

**File:** `apps/api/src/middleware/internal-auth.ts`

```typescript
// apps/api/src/middleware/internal-auth.ts
import fp from 'fastify-plugin';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';

/**
 * Internal route authentication via X-Internal-Secret header.
 *
 * Used ONLY for /v1/internal/* routes (rollover, etc.) — NOT for user routes.
 * The secret is shared between Railway Cron service and the API; never sent
 * to or stored in the browser.
 *
 * Comparison uses crypto.timingSafeEqual to prevent timing-based recovery
 * of the secret byte-by-byte (B-03).
 */
const INTERNAL_HEADER = 'x-internal-secret';

function timingSafeStringCompare(a: string, b: string): boolean {
  // Pre-check lengths — Buffer.from + timingSafeEqual throws if lengths differ.
  // This pre-check itself does NOT leak the actual length difference because
  // the only observable is "valid or invalid", not the byte position.
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  // Now timingSafeEqual is safe — equal length is required.
  return crypto.timingSafeEqual(
    Buffer.from(a, 'utf8'),
    Buffer.from(b, 'utf8')
  );
}

async function internalAuthPlugin(app: FastifyInstance) {
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret || expectedSecret.length < 32) {
    throw new Error('CRON_SECRET must be set and >= 32 characters at server startup');
  }

  app.decorate('verifyInternal', async (request: FastifyRequest, reply: FastifyReply) => {
    const provided = request.headers[INTERNAL_HEADER];

    if (typeof provided !== 'string' || !timingSafeStringCompare(provided, expectedSecret)) {
      // Generic 401 — never specifies what was wrong.
      // Log the IP for monitoring but do not echo to caller.
      request.log.warn({
        ip: request.ip,
        url: request.url,
        hasHeader: typeof provided === 'string',
      }, 'Invalid internal secret attempt');

      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required.' }
      });
    }
  });
}

export default fp(internalAuthPlugin, { name: 'internal-auth' });
```

**Usage in route file** — `apps/api/src/routes/internal.ts`:

```typescript
import { FastifyInstance } from 'fastify';

export default async function internalRoutes(app: FastifyInstance) {
  // Apply internal auth to all routes in this plugin
  app.addHook('onRequest', app.verifyInternal);

  app.post('/rollover', async (request, reply) => {
    // The cron service hits this endpoint
    const period = computeNextPeriod();  // helper computes target period
    const result = await RolloverService.run(period);
    return reply.send({ data: result });
  });
}
```

**Verification test** — `apps/api/tests/integration/internal-auth.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { buildApp } from '@/test-utils';

describe('Internal route auth', () => {
  const app = buildApp();

  test('missing header returns 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/internal/rollover' });
    expect(res.statusCode).toBe(401);
  });

  test('wrong secret returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/internal/rollover',
      headers: { 'x-internal-secret': 'definitely-not-the-real-secret' }
    });
    expect(res.statusCode).toBe(401);
  });

  test('correct secret passes through', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/internal/rollover',
      headers: { 'x-internal-secret': process.env.CRON_SECRET! }
    });
    expect(res.statusCode).toBe(200);
  });
});
```

---

## C-01  PRD §5 Bot Latency Row Correction

**File:** `01-PRD.md` §5 (Non-Functional Requirements Summary)

**Find:**
```markdown
| Bot response | < 4s end-to-end including Anthropic API |
```

**Replace with:**
```markdown
| Bot response | TTFT (first token) < 2s; full streaming completion < 8s (see NFR §1.2) |
```

That's it. One row. Verifies the contradiction caught by NFR's own Gemini audit note.

---

## C-02  API Contract — PATCH Response Standard

**File:** `07-API-CONTRACT.md` §1.1

**Find the "Success" line in the Standard Response Envelopes block. Append this paragraph after the existing envelope examples:**

```markdown
### 1.1.1 PATCH Response Convention

All `PATCH /v1/.../:id` endpoints return the **full updated resource** in
the `data` field, plus updated optimistic-lock metadata in `meta`:

```json
{
  "data": { /* complete row with new version */ },
  "meta": { "version": 4, "updatedAt": "2025-06-01T12:00:00Z", "updatedBy": "uuid" }
}
```

Clients should **replace** the cached entry with the new `data` object,
not merge fields. This makes TanStack Query optimistic update reversal
trivial: revert to the prior cached object on error, replace on success.

The optimistic-lock `version` returned is the value AFTER the update —
clients must use this for their next PATCH on the same record.
```

**Backend implementation pattern** — every service `update*` method must return the full row:

```typescript
// Example: AttendanceService.update
async update(id: string, patch: AttendancePatch, staffId: string): Promise<AttendanceLog> {
  // ... validation, lock check, version check, write ...

  // Return the complete updated row, not just the patched fields:
  return await this.db
    .selectFrom('attendance_logs')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}
```

---

## C-03  PRD §6 — Transactional Email Out of Scope

**File:** `01-PRD.md` §6 (Out of Scope — MVP)

**Add new row to the table:**

```markdown
| Transactional email beyond Supabase Auth flows | All operational notifications (task assigned, shoot confirmed, report ready, signup approved, etc.) are delivered in-app via Socket.io + DB-backed bell. Only Supabase Auth flows (invite email, password reset email) use email. Email integration (Resend / SendGrid / Postmark) is Phase 2 work. |
```

**Add corresponding clarification to `04-APPFLOW.md` §2.6:**

```markdown
> **Signup approval notification (audit C-03):** When admin approves a
> signup request, the new user is notified by:
> (a) Supabase Auth sends a "set your password" email via `inviteUserByEmail`
> (b) The user's `/signup/pending` page polls status and auto-redirects on
>     approval (10s → 30s → 60s, stops at 10 min)
>
> No additional email is sent by the portal. The user discovers approval
> EITHER by checking email OR by leaving the pending page open. This is
> intentional for MVP.
```

---

## C-04  GET /v1/staff/me Endpoint

**File:** `07-API-CONTRACT.md` §4 (Staff Endpoints)

**Add this endpoint right after `GET /v1/staff/:id`:**

```markdown
### GET /v1/staff/me
Returns the authenticated user's full profile. Resolves staffId from JWT.
Convenience endpoint to avoid clients having to decode their own JWT.
**Auth:** Any authenticated user

**Response 200:** Same shape as `GET /v1/staff/:id` for own profile.

```json
{
  "data": {
    "id": "uuid", "name": "Sohail Khan", "email": "sohail@skaly.in",
    "role": "team_member", "dateOfBirth": "1998-05-10",
    "mobileNumber": "+91-9876543210",
    "cvFileKey": "cvs/uuid/cv.pdf", "avatarUrl": "...",
    "active": true, "mfaEnrolled": false,
    "pushToken": null, "pushPlatform": null,
    "createdAt": "2025-01-15T10:00:00Z"
  }
}
```

**Errors:** 401 `UNAUTHORIZED` (no valid JWT)
```

**Backend implementation** — `apps/api/src/routes/staff.ts`:

```typescript
app.get('/me', async (request, reply) => {
  const staff = await StaffService.getById(request.user.staffId);
  return { data: staff };
});
```

Frontend usage:

```typescript
// hooks/useCurrentUser.ts
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useCurrentUser() {
  return useQuery({
    queryKey: ['staff', 'me'],
    queryFn: () => api.get('/staff/me').then(r => r.data),
    staleTime: 5 * 60 * 1000, // 5 min — staff profile rarely changes
  });
}
```

---

## C-05  WebSocket Auth Refresh Protocol

**File:** `02-TRD.md` §8 — append after the existing reconnection config block.

```markdown
### 8.X JWT Refresh During Active WebSocket Connection

JWTs expire after 1 hour. A long-lived Socket.io connection must handle
expiry without disconnecting the user.

**Server-side (apps/api/src/socket/auth-refresh.ts):**

```typescript
import { Server, Socket } from 'socket.io';
import { verifyJwt } from '@/auth/jwt';

interface SocketWithMeta extends Socket {
  data: {
    staffId: string;
    role: string;
    jwtExp: number;        // unix seconds
    refreshTimer?: NodeJS.Timeout;
  };
}

const EXPIRY_WARNING_SECONDS = 60;  // emit refresh_required 60s before expiry
const GRACE_SECONDS = 30;            // disconnect 30s after expiry if no refresh

export function attachAuthRefresh(io: Server) {
  io.on('connection', (socket: SocketWithMeta) => {
    scheduleRefreshAlert(socket);

    socket.on('auth:refresh', async (newToken: string, ack) => {
      try {
        const { payload } = await verifyJwt(newToken);
        // Replace stored auth on this socket
        socket.data.jwtExp = payload.exp;
        socket.data.staffId = payload.sub;
        // Re-schedule next alert
        if (socket.data.refreshTimer) clearTimeout(socket.data.refreshTimer);
        scheduleRefreshAlert(socket);
        ack({ ok: true });
      } catch (err) {
        ack({ ok: false, code: 'TOKEN_INVALID' });
        socket.disconnect(true);
      }
    });

    socket.on('disconnect', () => {
      if (socket.data.refreshTimer) clearTimeout(socket.data.refreshTimer);
    });
  });
}

function scheduleRefreshAlert(socket: SocketWithMeta) {
  const now = Math.floor(Date.now() / 1000);
  const secondsUntilWarning = Math.max(0, socket.data.jwtExp - now - EXPIRY_WARNING_SECONDS);

  socket.data.refreshTimer = setTimeout(() => {
    socket.emit('auth:refresh_required');

    // Hard disconnect grace window
    const hardDisconnectMs = (EXPIRY_WARNING_SECONDS + GRACE_SECONDS) * 1000;
    setTimeout(() => {
      // Only disconnect if the socket is still using the old (now-expired) JWT
      if (Math.floor(Date.now() / 1000) >= socket.data.jwtExp) {
        socket.emit('auth:token_expired');
        socket.disconnect(true);
      }
    }, hardDisconnectMs);
  }, secondsUntilWarning * 1000);
}
```

**Client-side (apps/web/lib/socket.ts):**

```typescript
import { io as ioClient, Socket } from 'socket.io-client';
import { refreshAccessToken } from '@/lib/auth';

let socket: Socket;

export function getSocket(token: string): Socket {
  if (!socket) {
    socket = ioClient(process.env.NEXT_PUBLIC_WS_URL!, {
      auth: { token },
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      reconnectionAttempts: Infinity,
    });

    socket.on('auth:refresh_required', async () => {
      try {
        const newToken = await refreshAccessToken(); // POST /v1/auth/refresh
        socket.emit('auth:refresh', newToken, (resp: { ok: boolean }) => {
          if (!resp.ok) {
            window.location.href = '/login';
          }
        });
      } catch {
        window.location.href = '/login';
      }
    });

    socket.on('auth:token_expired', () => {
      window.location.href = '/login';
    });
  }
  return socket;
}
```

**Reconnect flow on expired token:**

If the socket disconnects naturally (network drop) and the JWT has since
expired, the reconnect attempt will fail JWT verification at the handshake
layer. The client's reconnection handler should catch this and route to
the existing HTTP 401 silent-refresh path, then reconnect with the new
JWT. No special-casing required — the existing 401 handler covers it.
```

---

## C-06  Rollover Bootstrap (No Prior Period)

**File:** `apps/api/src/jobs/rollover.service.ts`

```typescript
// Inside RolloverService.run(targetPeriod):

async run(targetPeriod: string): Promise<RolloverResult> {
  // Idempotency check — exits cleanly if already done
  const existing = await this.db
    .selectFrom('months')
    .where('period', '=', targetPeriod)
    .executeTakeFirst();

  if (existing) {
    this.logger.info({ targetPeriod }, 'Rollover already complete, exiting');
    return { period: targetPeriod, status: 'already_complete' };
  }

  const prevPeriod = computePrevPeriod(targetPeriod);  // e.g. '2026-05' for '2026-06'

  return await this.db.transaction().execute(async (trx) => {
    // Step 1 — create new month
    await trx.insertInto('months').values({
      period: targetPeriod,
      label: formatPeriodLabel(targetPeriod),  // 'June 2026'
    }).execute();

    // Step 2 — lock prior month IF IT EXISTS
    // Audit C-06: bootstrap edge case — first rollover ever runs with
    // no prior period to lock. This is expected and not an error.
    const prev = await trx.selectFrom('months')
      .where('period', '=', prevPeriod)
      .executeTakeFirst();

    if (prev && !prev.locked) {
      await trx.updateTable('months')
        .set({
          locked: true,
          locked_at: new Date(),
          locked_by: SYSTEM_ACTOR_ID,
        })
        .where('period', '=', prevPeriod)
        .execute();

      this.logger.info({ prevPeriod }, 'Locked prior period during rollover');
    } else if (!prev) {
      this.logger.info({ prevPeriod, targetPeriod },
        'Bootstrap rollover — no prior period to lock (expected on first run)');
    }

    // Steps 3-7 unchanged from spec...
    await this.attendanceService.generateForPeriod(targetPeriod, trx);
    await this.pipelineService.generateForPeriod(targetPeriod, trx);
    await this.shootService.generateForPeriod(targetPeriod, trx);
    await this.calendarService.generateForPeriod(targetPeriod, trx);
    await this.auditService.log({
      staff_id: SYSTEM_ACTOR_ID,
      changed_by_source: 'system',
      table_name: 'months',
      record_id: null,
      action: 'INSERT',
      new_value: { period: targetPeriod },
    }, trx);

    return { period: targetPeriod, status: 'completed' };
  });
}
```

**Test** — `apps/api/tests/integration/rollover-bootstrap.test.ts`:

```typescript
describe('RolloverService — bootstrap edge case', () => {
  test('first-ever rollover succeeds with no prior period in months table', async () => {
    // Database is empty — no months rows exist
    const result = await RolloverService.run('2026-06');

    expect(result.status).toBe('completed');

    const june = await db.selectFrom('months')
      .where('period', '=', '2026-06')
      .executeTakeFirst();
    expect(june).toBeDefined();
    expect(june?.locked).toBe(false);

    // May was never inserted, so we don't expect it to exist
    const may = await db.selectFrom('months')
      .where('period', '=', '2026-05')
      .executeTakeFirst();
    expect(may).toBeUndefined();
  });

  test('second rollover (June → July) locks June correctly', async () => {
    await RolloverService.run('2026-06');
    await RolloverService.run('2026-07');

    const june = await db.selectFrom('months')
      .where('period', '=', '2026-06')
      .executeTakeFirst();
    expect(june?.locked).toBe(true);
    expect(june?.locked_by).toBe('00000000-0000-0000-0000-000000000000');
  });
});
```

---

## H-01  Holiday Removal Service

**File:** `apps/api/src/services/holiday.service.ts`

```typescript
export class HolidayService {
  async remove(holidayId: string, removedBy: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      // 1. Load the holiday row to know its date + period
      const holiday = await trx.selectFrom('holidays')
        .selectAll()
        .where('id', '=', holidayId)
        .where('active', '=', true)
        .executeTakeFirst();

      if (!holiday) {
        throw new AppError('RESOURCE_NOT_FOUND', 404, 'Holiday not found or already removed');
      }

      // 2. Check the period isn't locked
      await assertPeriodNotLocked(holiday.period, trx);

      // 3. Mark holiday inactive
      await trx.updateTable('holidays')
        .set({
          active: false,
          removed_at: new Date(),
          removed_by: removedBy,
        })
        .where('id', '=', holidayId)
        .execute();

      // 4. Flip all attendance_logs for that date back to 'working'
      // Critical step missing from V2.1 spec
      const affected = await trx.updateTable('attendance_logs')
        .set({ day_type: 'working' })
        .where('period', '=', holiday.period)
        .where('date', '=', holiday.date)
        .where('day_type', '=', 'holiday')
        .returning('id')
        .execute();

      // 5. Audit log entry
      await this.auditService.log({
        staff_id: removedBy,
        changed_by_source: 'user',
        table_name: 'holidays',
        record_id: holidayId,
        action: 'UPDATE',
        old_value: { active: true, date: holiday.date },
        new_value: { active: false, removed_at: new Date().toISOString() },
      }, trx);

      // 6. Emit event (after txn commits — use Fastify's onClose pattern
      //    or queue the event for post-commit dispatch)
      this.eventBus.emit('holiday:removed', {
        period: holiday.period,
        date: holiday.date,
        affectedAttendanceRows: affected.length,
      });
    });

    // Real-time broadcast
    this.io.to('org:all').emit('attendance:holiday_removed', {
      period: holiday.period,
      date: holiday.date,
    });
  }
}
```

---

## H-02  Soft-Delete Query Helper

**File:** `apps/api/src/lib/queries.ts`

```typescript
import { Kysely, SelectQueryBuilder } from 'kysely';
import { DB } from '@/db/types';  // generated Kysely types

// List of tables that have a deleted_at column.
// Add to this set when new soft-deletable tables are created.
type SoftDeletableTable = 'staff' | 'tasks' | 'clients' | 'messages';

/**
 * Wraps a Kysely SELECT with an explicit `deleted_at IS NULL` filter.
 *
 * Usage:
 *   const tasks = await selectActive(db, 'tasks')
 *     .where('period', '=', period)
 *     .selectAll()
 *     .execute();
 *
 * This replaces:
 *   db.selectFrom('tasks').where('deleted_at', 'is', null).where(...)
 *
 * Standardising the soft-delete clause prevents accidental leakage of
 * soft-deleted records in 99% of queries. Edge cases (e.g., audit
 * queries that need to see deleted rows) bypass this helper deliberately.
 */
export function selectActive<TB extends SoftDeletableTable>(
  db: Kysely<DB>,
  table: TB
) {
  return db.selectFrom(table).where(`${table}.deleted_at`, 'is', null) as
    unknown as SelectQueryBuilder<DB, TB, {}>;
}
```

**ESLint rule (custom) — `eslint-rules/no-raw-soft-deletable.js`:**

For ambitious teams, add a custom ESLint rule that warns when `db.selectFrom('tasks'|'staff'|'clients'|'messages')` appears without a subsequent `.where('deleted_at', 'is', null)` clause. Implementation is ~50 lines; deferred to Phase 2 if dev velocity is the priority.

**Code review checklist addition** — `.github/PULL_REQUEST_TEMPLATE.md`:

```markdown
## Soft-Delete Checklist
- [ ] All SELECT on `staff`, `tasks`, `clients`, `messages` use `selectActive()` helper
- [ ] If bypassed for audit purposes, comment explains why
```

---

## H-03  Refresh Materialised Views CLI Script

**File:** `apps/api/scripts/refresh-views.ts`

```typescript
#!/usr/bin/env tsx
// Usage: pnpm --filter api db:refresh-views
//
// Refreshes both dashboard materialised views NON-CONCURRENTLY.
// Use this after restoring backups or loading seed data on dev / staging.
// In production, the post-rollover job uses CONCURRENTLY.

import { db } from '../src/db';
import { sql } from 'kysely';

async function main() {
  console.log('Refreshing dashboard_org_stats...');
  await sql`REFRESH MATERIALIZED VIEW dashboard_org_stats`.execute(db);

  console.log('Refreshing dashboard_staff_task_stats...');
  await sql`REFRESH MATERIALIZED VIEW dashboard_staff_task_stats`.execute(db);

  console.log('✅ Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
```

**Add to `apps/api/package.json`:**

```json
{
  "scripts": {
    "db:refresh-views": "tsx scripts/refresh-views.ts"
  }
}
```

---

## H-04  Bot Stream Handler Reference Implementation

**File:** `apps/api/src/bot/stream-handler.ts`

```typescript
// apps/api/src/bot/stream-handler.ts
//
// Orchestrates a single bot turn:
// 1. Load session from Redis (50 turns, 12hr TTL)
// 2. Build system prompt with role + period + anti-hallucination
// 3. Filter tool list by user's permissions
// 4. Call Anthropic with stream: true
// 5. Bridge stream chunks → Socket.io emits to user:{staffId} room
// 6. Detect tool_use blocks, execute via service layer
// 7. Second Anthropic call with tool_result if tools were used
// 8. Append turn to Redis session
// 9. Archive both messages to DB (channel='bot')
//
// Reference for Sprint 8. Pattern reused by mutation tools in Sprint 9.

import Anthropic from '@anthropic-ai/sdk';
import { Server } from 'socket.io';
import { redis } from '@/lib/redis';
import { db } from '@/db';
import { BotPermissionGuard } from './permission-guard';
import { BotToolExecutor } from './tool-executor';
import { logger } from '@/lib/logger';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const MODEL = process.env.NODE_ENV === 'production'
  ? 'claude-sonnet-4-6'
  : 'claude-haiku-4-5-20251001';

const MAX_TOKENS = 1024;
const SESSION_TTL_SECONDS = 43200; // 12 hours
const MAX_TURNS = 50;

interface HandleParams {
  staffId: string;
  role: string;
  userMessage: string;
  messageId: string;  // pre-created in DB before this fn is called
  sessionId: string;
  period: string;     // current IST period
  io: Server;
}

export async function handleBotMessage(params: HandleParams): Promise<void> {
  const { staffId, role, userMessage, messageId, sessionId, period, io } = params;
  const room = `user:${staffId}`;

  try {
    // 1. Load session from Redis
    const sessionKey = `bot:session:${staffId}`;
    const raw = await redis.get(sessionKey);
    const history: Anthropic.MessageParam[] = raw ? JSON.parse(raw) : [];

    // 2. Append user turn
    history.push({ role: 'user', content: userMessage });

    // 3. Build system prompt
    const systemPrompt = buildSystemPrompt({ role, period, staffId });

    // 4. Filter tools by user permissions
    const allTools = await BotToolExecutor.getAllToolDefinitions();
    const permittedTools = await BotPermissionGuard.filterTools(staffId, role, allTools);

    // 5. First Anthropic call — streaming
    let fullText = '';
    const toolUseBlocks: Anthropic.ToolUseBlock[] = [];

    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      tools: permittedTools,
      messages: history,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const chunk = event.delta.text;
        fullText += chunk;
        io.to(room).emit('bot:message', { messageId, sessionId, chunk, done: false });
      } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        toolUseBlocks.push(event.content_block);
      }
    }

    const finalMessage = await stream.finalMessage();

    // 6. Execute tool_use blocks if present
    let cardPayload: unknown = null;
    let toolsUsed: string[] = [];

    if (toolUseBlocks.length > 0) {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        toolsUsed.push(block.name);
        try {
          const result = await BotToolExecutor.execute({
            toolName: block.name,
            input: block.input as Record<string, unknown>,
            staffId,
            role,
            period,
          });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          });

          // The card to render in UI comes from the first tool result
          if (cardPayload === null) cardPayload = result;
        } catch (err) {
          // Tool errors flow back to the model so it can recover gracefully (M-08)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Error: ${(err as Error).message}`,
            is_error: true,
          });
        }
      }

      // Append assistant turn (with tool_use) + user turn (with tool_result)
      history.push({ role: 'assistant', content: finalMessage.content });
      history.push({ role: 'user', content: toolResults });

      // 7. Second Anthropic call to get the final user-facing text
      const followup = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        tools: permittedTools,
        messages: history,
      });

      const followupText = followup.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');

      // Stream the follow-up text in chunks to the client too
      io.to(room).emit('bot:message', { messageId, sessionId, chunk: followupText, done: false });
      fullText = followupText;

      history.push({ role: 'assistant', content: followupText });
    } else {
      history.push({ role: 'assistant', content: fullText });
    }

    // 8. Final event with metadata
    io.to(room).emit('bot:message', {
      messageId,
      sessionId,
      chunk: '',
      done: true,
      toolsUsed,
      card: cardPayload,
    });

    // 9. Trim to MAX_TURNS, save back to Redis
    const trimmed = history.slice(-MAX_TURNS * 2); // 2 entries per turn (user + assistant)
    await redis.set(sessionKey, JSON.stringify(trimmed), 'EX', SESSION_TTL_SECONDS);

    // 10. Archive assistant message to DB
    await db.insertInto('messages').values({
      channel: 'bot',
      sender_id: null,
      sender_type: 'bot',
      content: fullText,
      content_type: toolUseBlocks.length > 0 ? 'tool_result' : 'text',
    }).execute();
  } catch (err) {
    logger.error({ err, staffId, sessionId }, 'Bot stream handler failed');
    io.to(room).emit('bot:message', {
      messageId, sessionId, done: true,
      chunk: "I'm having trouble responding right now. Please try again in a moment.",
    });
  }
}

function buildSystemPrompt({ role, period, staffId }: { role: string; period: string; staffId: string }): string {
  const istNow = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' }).format(new Date());

  return `You are the Scaly Business Portal AI assistant. The current IST date and time is ${istNow}. The current operational period is ${period} (YYYY-MM format).

The user's role is "${role}". You only have access to the tools listed in this request. If a requested action is not in your tool list, you do not have permission for it — say so without revealing which roles do have access.

CRITICAL RULES:
- Only use the provided tools to query or mutate data. Never make up information.
- If you do not know something or a tool returns no results, say so explicitly. Do not guess.
- For ANY mutation tool, you MUST first present a summary of what you will do and explicitly ask the user to confirm. Only execute the mutation in your NEXT turn after the user confirms with a clear affirmative.
- If the period is locked, mutations will fail with a "locked period" error — explain to the user that the period is locked and they should ask an admin to unlock it for corrections.
- Never reveal technical error codes, stack traces, or implementation details.
- Be concise. Most responses should be 1-3 sentences. Use the card payload from tool results for structured data display.`;
}
```

---

## H-05  Comment Notification Recipients — Decision Doc

**File:** `04-APPFLOW.md` §13 — append to the bottom:

```markdown
### 13.1 Notification Recipients per Module (Audit H-05 resolution)

When a `new_comment` notification fires, the recipients are determined as
follows per module:

| Module | Recipients |
|--------|-----------|
| **shoot_planner** | Assigned freelancer (if `shoot_schedules.freelancer_id` is set) + all admins + all managers |
| **content_dropper** | All admins + all managers |
| **content_calendar** | All admins + all managers |

This means in a typical Skaly Group operation, every admin and manager
sees every new comment. This is intentional given small team size; a
team member's comment is rarely missed.

The comment's author is NEVER notified about their own comment.

When a comment is acknowledged via `[✓ Noted]`, the comment AUTHOR receives
a `new_comment` notification with payload type "acknowledgment" — distinct
from a new comment.

**Implementation note:** Use Socket.io broadcasts to `role:admin` and
`role:manager` rooms for the all-admins-and-managers recipient list. Use
direct user room for the assigned freelancer. The DB notification rows
fan out to each recipient individually so unread counts are accurate.
```

---

## H-07  Sentry Integration (Pre-Launch — Sprint 13)

**Backend** — `apps/api/src/server.ts`:

```typescript
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  release: process.env.RAILWAY_GIT_COMMIT_SHA,
  tracesSampleRate: 0.1, // 10% of requests for performance traces
  beforeSend(event) {
    // Strip sensitive fields
    if (event.request?.headers) {
      delete event.request.headers['authorization'];
      delete event.request.headers['cookie'];
      delete event.request.headers['x-internal-secret'];
    }
    return event;
  },
});

// Register with Fastify
app.setErrorHandler((error, request, reply) => {
  Sentry.captureException(error, {
    user: { id: request.user?.staffId },
    extra: { url: request.url, method: request.method },
  });
  // ... existing error handler from 09-ERROR-HANDLING §4
});
```

**Frontend** — `apps/web/sentry.client.config.ts`:

```typescript
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_ENV,
  tracesSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0.0,
  integrations: [
    Sentry.replayIntegration({
      maskAllText: false,
      blockAllMedia: true,
    }),
  ],
});
```

**Environment variables (add to INFRA §6):**

```bash
# Backend (Railway)
SENTRY_DSN=https://...@sentry.io/...

# Frontend (Vercel)
NEXT_PUBLIC_SENTRY_DSN=https://...@sentry.io/...
NEXT_PUBLIC_ENV=production
```

---

## H-08  Content Security Policy Header

**File:** `vercel.json`

```json
{
  "framework": "nextjs",
  "buildCommand": "pnpm --filter web build",
  "outputDirectory": "apps/web/.next",
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=()" },
        {
          "key": "Content-Security-Policy",
          "value": "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://api.skaly.in wss://api.skaly.in https://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self';"
        }
      ]
    }
  ]
}
```

**Tightening path** (post-launch, incremental):
1. Drop `'unsafe-eval'` — verify nothing breaks (modern Next.js doesn't need it)
2. Drop `'unsafe-inline'` for scripts — requires nonce-based CSP setup
3. Narrow `img-src` from `https:` to specific R2 domain
4. Add report-uri to a CSP violation reporting endpoint

---

## H-09  Connection Pool Monitoring

**File:** `apps/api/src/lib/db-monitor.ts`

```typescript
import { db } from '@/db';
import { logger } from '@/lib/logger';
import { metrics } from '@/lib/metrics'; // your monitoring lib

const POOL_USAGE_WARN_PCT = 80;

setInterval(async () => {
  try {
    const pool = (db as any).getExecutor().pool;  // Kysely pg pool
    const used = pool.totalCount - pool.idleCount;
    const max = pool.options.max;
    const usagePct = (used / max) * 100;

    metrics.gauge('db.pool.used', used);
    metrics.gauge('db.pool.idle', pool.idleCount);
    metrics.gauge('db.pool.waiting', pool.waitingCount);

    if (usagePct > POOL_USAGE_WARN_PCT) {
      logger.warn({
        used, max, usagePct,
        waiting: pool.waitingCount,
      }, 'DB pool usage above warning threshold');
    }
  } catch (err) {
    logger.error({ err }, 'Pool monitor error');
  }
}, 30_000); // every 30 seconds
```

Wire `metrics` into Railway dashboards or push to Sentry as breadcrumbs.

---

## CHECKLIST: Files to Create in Sprint 0

```
database/migrations/026_database_roles.ts                  [B-01]
apps/api/src/middleware/internal-auth.ts                   [B-03]
apps/api/src/routes/staff.ts        (add /me handler)      [C-04]
apps/api/src/socket/auth-refresh.ts                        [C-05]
apps/web/lib/socket.ts              (add refresh handler)  [C-05]
apps/api/src/jobs/rollover.service.ts (bootstrap edge)     [C-06]
apps/api/src/services/holiday.service.ts                   [H-01]
apps/api/src/lib/queries.ts                                [H-02]
apps/api/scripts/refresh-views.ts                          [H-03]
apps/api/src/bot/stream-handler.ts                         [H-04]
database/seeds/002_dev_data.ts                             [M-10]
README.md (repo root)                                      [M-11]
.github/PULL_REQUEST_TEMPLATE.md                           [H-02]

DOC PATCHES TO APPLY (in V2.1 source docs)
01-PRD.md §5  — Bot latency row                            [C-01]
01-PRD.md §6  — OoS table row for transactional email      [C-03]
04-APPFLOW.md §2.6 — Signup approval notification clarification [C-03]
04-APPFLOW.md §13 — Comment notification recipients        [H-05]
07-API-CONTRACT.md §1.1 — PATCH response envelope clause   [C-02]
07-API-CONTRACT.md §4 — GET /v1/staff/me endpoint          [C-04]
02-TRD.md §8 — JWT refresh during active WS connection     [C-05]
06-IMPLEMENTATION-PLAN.md §17 — Risk register updates      [Audit]
```

---

**END OF PATCHES — V2.2**
