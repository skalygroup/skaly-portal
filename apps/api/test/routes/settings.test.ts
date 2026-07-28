import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';
import { Redis } from 'ioredis';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { resetEmitter, setEmitter } from '../../src/lib/emit-after-commit.js';
import { AppError } from '../../src/lib/errors.js';
import { requireRole } from '../../src/middleware/auth.plugin.js';
import clientsRoutes from '../../src/routes/clients/index.js';
import holidaysRoutes from '../../src/routes/holidays/index.js';
import monthsRoutes from '../../src/routes/months/index.js';
import reportsRoutes from '../../src/routes/reports/index.js';
import settingsRoutes from '../../src/routes/settings/index.js';
import staffRoutes from '../../src/routes/staff/index.js';
import { currentIstPeriod } from '../../src/services/BaseService.js';

import type { AuthUser } from '../../src/lib/auth-verify.js';
import type { DB } from '@skaly/shared';
import type { Role } from '@skaly/shared/schemas/auth';
import type { FastifyError, FastifyInstance } from 'fastify';

/**
 * The settings API surface (Sprint 11 STEP 4).
 *
 * The load-bearing test in this file is the ROLE MATRIX: seven surfaces × four
 * roles, driven as data against Auth-Matrix §3/§4. Four of the seven panels are
 * admin-only, and that one table protects the entire sprint's access surface —
 * hand-written per-endpoint cases drift the moment someone adds an endpoint and
 * forgets the manager case.
 *
 * `requireRole` is the REAL implementation here, not a stub. reads.test.ts stubs
 * it, which is correct for testing reads and useless for testing a role matrix.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const DOMAIN = '@settings.itest';
const PERIOD = currentIstPeriod();
const LOCK_PERIOD = '2094-03';

const ids: Record<Role, string> = {
  admin: randomUUID(),
  manager: randomUUID(),
  team_member: randomUUID(),
  freelancer: randomUUID(),
};
const TARGET = randomUUID(); // the staff member panels act ON

let asUser: AuthUser;
let app: FastifyInstance;

function authUser(role: Role): AuthUser {
  return {
    id: ids[role],
    supabase_uid: randomUUID(),
    name: role,
    email: `${role}${DOMAIN}`,
    role,
    active: true,
    mfa_enrolled: false,
    avatar_url: null,
  };
}

async function cleanup() {
  const mine = db.selectFrom('staff').select('id').where('email', 'like', `%${DOMAIN}`);
  await db.deleteFrom('audit_log').where('staff_id', 'in', mine).execute();
  await db.deleteFrom('user_permissions').where('staff_id', 'in', mine).execute();
  await db.deleteFrom('notifications').where('staff_id', 'in', mine).execute();
  await db.deleteFrom('signup_requests').where('email', 'like', `%${DOMAIN}`).execute();
  // months BEFORE staff: months_locked_by_fk / months_unlocked_by_fk reference the
  // admin these tests lock with, so the reverse order fails on the constraint —
  // and the failure names `staff`, not the month row actually holding it.
  await db.deleteFrom('months').where('period', '=', LOCK_PERIOD).execute();
  await db.deleteFrom('staff').where('email', 'like', `%${DOMAIN}`).execute();
  await redis.del(...Object.values(ids).map((id) => `perms:${id}`), `perms:${TARGET}`);
}

beforeAll(async () => {
  await cleanup();
  await db
    .insertInto('staff')
    .values([
      ...(Object.keys(ids) as Role[]).map((role) => ({
        id: ids[role],
        name: `S ${role}`,
        email: `${role}${DOMAIN}`,
        role,
        active: true,
      })),
      { id: TARGET, name: 'Target', email: `target${DOMAIN}`, role: 'team_member', active: true },
    ])
    .execute();
  await db
    .insertInto('months')
    .values([
      { period: PERIOD, label: PERIOD, locked: false },
      { period: LOCK_PERIOD, label: 'March 2094', locked: false },
    ])
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();

  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error: FastifyError, _req, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply
        .status(400)
        .send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed.' } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  });
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('verifyJwt', async (req: { user?: AuthUser }) => {
    req.user = asUser;
  });
  app.decorate('requireRole', requireRole);
  await app.register(settingsRoutes, { prefix: '/v1' });
  await app.register(staffRoutes, { prefix: '/v1' });
  await app.register(monthsRoutes, { prefix: '/v1' });
  await app.register(clientsRoutes, { prefix: '/v1' });
  await app.register(holidaysRoutes, { prefix: '/v1' });
  await app.register(reportsRoutes, { prefix: '/v1' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await cleanup();
  await redis.quit();
  await db.destroy();
});

beforeEach(async () => {
  await db
    .updateTable('months')
    .set({ locked: false, unlock_reason: null })
    .where('period', '=', LOCK_PERIOD)
    .execute();
  await db.deleteFrom('user_permissions').where('staff_id', '=', TARGET).execute();
  await redis.del(`perms:${TARGET}`);
});

// ── The role matrix ────────────────────────────────────────────────────
/**
 * Auth-Matrix §4's "Settings & Admin" table, as data. `allowed` is the exact set
 * of roles that must NOT get a 403; every other role must.
 */
const MATRIX: Array<{
  panel: string;
  method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';
  url: () => string;
  body?: unknown;
  allowed: Role[];
}> = [
  { panel: 'staff', method: 'GET', url: () => '/v1/settings/staff', allowed: ['admin', 'manager'] },
  { panel: 'staff', method: 'PUT', url: () => `/v1/staff/${TARGET}/deactivate`, allowed: ['admin'] },
  { panel: 'staff', method: 'PUT', url: () => `/v1/staff/${TARGET}/reactivate`, allowed: ['admin'] },
  { panel: 'staff', method: 'PUT', url: () => `/v1/staff/${TARGET}/mfa/reset`, allowed: ['admin'] },
  {
    panel: 'permissions',
    method: 'PUT',
    url: () => `/v1/staff/${TARGET}/permissions/chat.access`,
    body: { value: true },
    allowed: ['admin'],
  },
  {
    panel: 'permissions',
    method: 'DELETE',
    url: () => `/v1/staff/${TARGET}/permissions/chat.access`,
    allowed: ['admin'],
  },
  {
    panel: 'signup-requests',
    method: 'GET',
    url: () => '/v1/settings/signup-requests',
    allowed: ['admin'],
  },
  {
    panel: 'months',
    method: 'POST',
    url: () => `/v1/months/${LOCK_PERIOD}/lock`,
    allowed: ['admin'],
  },
  {
    panel: 'months',
    method: 'DELETE',
    url: () => `/v1/months/${LOCK_PERIOD}/lock`,
    body: { reason: 'matrix probe' },
    allowed: ['admin'],
  },
  // The three manager-admitting panels. Every route in each file shares ONE
  // `requireRole(...)` object, so one probe per guard covers the file — and the
  // probes are reads or a DELETE of a nonexistent id, never a write, so a role
  // that IS allowed answers 404 rather than mutating this suite's fixtures.
  // NOT `GET /v1/clients` — the bare list is a shared lookup every grid's client
  // filter needs, so it is open to all four roles by design. Auth-Matrix §3's
  // `/settings/clients` row is about the PANEL, and the panel is the admin view
  // (includeInactive) plus the mutations. Probing the bare list here would assert
  // a 403 the product does not want and cannot give.
  {
    panel: 'clients',
    method: 'GET',
    url: () => '/v1/clients?includeInactive=true',
    allowed: ['admin'],
  },
  {
    panel: 'clients',
    method: 'PATCH',
    url: () => `/v1/clients/${randomUUID()}`,
    body: { name: 'matrix probe' },
    allowed: ['admin', 'manager'],
  },
  {
    panel: 'clients',
    method: 'DELETE',
    url: () => `/v1/clients/${randomUUID()}`,
    allowed: ['admin'],
  },
  {
    panel: 'holidays',
    method: 'GET',
    url: () => `/v1/holidays?period=${PERIOD}`,
    allowed: ['admin', 'manager'],
  },
  {
    panel: 'holidays',
    method: 'DELETE',
    url: () => `/v1/holidays/${randomUUID()}`,
    allowed: ['admin', 'manager'],
  },
  // POST /reports/generate shares `staffOnly` with these, and is probed by GET
  // instead: a route-level preHandler runs AFTER schema validation, so a probe
  // with a throwaway body 400s for every role and asserts nothing about the gate.
  { panel: 'reports', method: 'GET', url: () => '/v1/reports', allowed: ['admin', 'manager'] },
  {
    panel: 'reports',
    method: 'GET',
    url: () => `/v1/reports/${randomUUID()}`,
    allowed: ['admin', 'manager'],
  },
];

const ROLES: Role[] = ['admin', 'manager', 'team_member', 'freelancer'];

describe('⭐ the role matrix — Auth-Matrix §4, as data', () => {
  test.each(
    MATRIX.flatMap((entry) => ROLES.map((role) => ({ ...entry, role }))),
  )('$panel $method $panel → $role', async ({ method, url, body, allowed, role }) => {
    asUser = authUser(role);
    const res = await app.inject({ method, url: url(), payload: body as never });

    if (allowed.includes(role)) {
      // Anything but 403. A 404/409 is a business answer; only 403 is the gate.
      expect(res.statusCode, `${role} must reach ${url()}`).not.toBe(403);
    } else {
      expect(res.statusCode, `${role} must NOT reach ${url()}`).toBe(403);
      expect(JSON.parse(res.payload).error.code).toBe('PERMISSION_DENIED');
    }
  });

  test('all seven panels are probed, and the manager reaches exactly four', () => {
    // Auth-Matrix §3's settings rows, minus audit-log, which has its own suite
    // (STEP 5) because its export is a stream rather than a JSON body.
    expect([...new Set(MATRIX.map((m) => m.panel))].sort()).toEqual([
      'clients',
      'holidays',
      'months',
      'permissions',
      'reports',
      'signup-requests',
      'staff',
    ]);

    // Manager: Staff read-only, Clients, Holidays, Reports.
    const managerPanels = new Set(
      MATRIX.filter((m) => m.allowed.includes('manager')).map((m) => m.panel),
    );
    expect([...managerPanels].sort()).toEqual(['clients', 'holidays', 'reports', 'staff']);

    // `staff` and `clients` appear on BOTH sides — their list admits a manager
    // while their mutations do not. That is the 👁 limited row, and collapsing a
    // panel to one verdict is what loses it. The next describe holds it.
    const adminOnlyPanels = new Set(
      MATRIX.filter((m) => m.allowed.length === 1 && m.allowed[0] === 'admin').map((m) => m.panel),
    );
    expect([...adminOnlyPanels].sort()).toEqual([
      'clients',
      'months',
      'permissions',
      'signup-requests',
      'staff',
    ]);
  });
});

describe('GET /v1/settings/staff — 👁 limited means fields are absent, not null', () => {
  test('admin sees email, MFA state, and former staff', async () => {
    asUser = authUser('admin');
    const res = await app.inject({ method: 'GET', url: '/v1/settings/staff' });
    expect(res.statusCode).toBe(200);
    const row = JSON.parse(res.payload).data.find((s: { id: string }) => s.id === TARGET);
    expect(row.email).toBe(`target${DOMAIN}`);
    expect(row.mfaEnrolled).toBe(false);
    expect(row).toHaveProperty('deactivatedAt');
  });

  test('manager sees the UIUX §15 columns and nothing more', async () => {
    asUser = authUser('manager');
    const res = await app.inject({ method: 'GET', url: '/v1/settings/staff' });
    expect(res.statusCode).toBe(200);
    const row = JSON.parse(res.payload).data.find((s: { id: string }) => s.id === TARGET);
    expect(Object.keys(row).sort()).toEqual([
      'active',
      'avatarUrl',
      'id',
      'joinedAt',
      'name',
      'role',
    ]);
    // Absent, not null — a null would claim this person has no email address.
    expect(row).not.toHaveProperty('email');
    expect(row).not.toHaveProperty('mfaEnrolled');
  });

  test('a soft-deleted staffer appears for an admin and not for a manager', async () => {
    await db.updateTable('staff').set({ deleted_at: sql`now()`, active: false }).where('id', '=', TARGET).execute();
    try {
      asUser = authUser('admin');
      const adminRows = JSON.parse(
        (await app.inject({ method: 'GET', url: '/v1/settings/staff' })).payload,
      ).data;
      // This row IS the "Former staff" section — the surface that makes A4's fix
      // reachable at all (ADR-026 §4).
      expect(adminRows.find((s: { id: string }) => s.id === TARGET).deactivatedAt).toBeTruthy();

      asUser = authUser('manager');
      const managerRows = JSON.parse(
        (await app.inject({ method: 'GET', url: '/v1/settings/staff' })).payload,
      ).data;
      expect(managerRows.find((s: { id: string }) => s.id === TARGET)).toBeUndefined();
    } finally {
      await db.updateTable('staff').set({ deleted_at: null, active: true }).where('id', '=', TARGET).execute();
    }
  });
});

describe('permissions — three states, one seam (AUTH-MATRIX §6.1, ADR-029)', () => {
  const KEY = 'bot.tool.create_task';
  const url = `/v1/staff/${TARGET}/permissions/${KEY}`;

  async function overrideRow() {
    return db
      .selectFrom('user_permissions')
      .select('value')
      .where('staff_id', '=', TARGET)
      .where('permission_key', '=', KEY)
      .executeTakeFirst();
  }

  test('allow → deny → INHERIT round-trips, and inherit deletes the row', async () => {
    asUser = authUser('admin');

    for (const value of [true, false]) {
      const res = await app.inject({ method: 'PUT', url, payload: { value } });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data.value).toBe(value);
      expect((await overrideRow())?.value).toBe(value);
    }

    // The third state. Without it, Deny on a role-granted key is a one-way door:
    // §6.1 resolves "no row" to the role default, so only a DELETE restores it.
    const res = await app.inject({ method: 'DELETE', url });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.value).toBeNull();
    expect(await overrideRow(), 'inherit is the ABSENCE of a row').toBeUndefined();
  });

  test('inherit restores the role default, verified through the resolver', async () => {
    asUser = authUser('admin');
    // create_task defaults FALSE for team_member. Grant it, then inherit it back.
    await app.inject({ method: 'PUT', url, payload: { value: true } });
    await app.inject({ method: 'DELETE', url });

    const { PermissionService } = await import('../../src/services/PermissionService.js');
    const resolved = await new PermissionService(redis).resolvePermission(
      TARGET,
      'team_member',
      KEY,
      db,
    );
    expect(resolved, 'back to the ROLE_DEFAULTS floor').toBe(false);
  });

  test('perms:{staffId} is busted on ALL THREE paths', async () => {
    asUser = authUser('admin');
    const cacheKey = `perms:${TARGET}`;

    for (const call of [
      () => app.inject({ method: 'PUT', url, payload: { value: true } }),
      () => app.inject({ method: 'PUT', url, payload: { value: false } }),
      () => app.inject({ method: 'DELETE', url }),
    ]) {
      await redis.set(cacheKey, JSON.stringify([{ permissionKey: KEY, value: true }]), 'EX', 300);
      await call();
      // The bust is the ENFORCEMENT boundary (§6.3). The socket push is UX.
      expect(await redis.get(cacheKey), 'a surviving key serves a stale grant').toBeNull();
    }
  });

  test('⭐ permission_changed reaches that staffId alone, on all three paths (ADR-029)', async () => {
    asUser = authUser('admin');
    const seen: Array<{ namespace: string; room: string; event: string; payload: unknown }> = [];
    setEmitter((namespace, room, event, payload) => seen.push({ namespace, room, event, payload }));

    try {
      for (const call of [
        () => app.inject({ method: 'PUT', url, payload: { value: true } }),
        () => app.inject({ method: 'PUT', url, payload: { value: false } }),
        () => app.inject({ method: 'DELETE', url }),
      ]) {
        seen.length = 0;
        await call();
        const pushes = seen.filter((e) => e.event === 'permission_changed');
        expect(pushes).toHaveLength(1);
        // The affected user's room, never org:all — a permission change is nobody
        // else's business, and a broadcast would make fifty clients refetch
        // /v1/staff/me for one person's grant.
        expect(pushes[0]!.room).toBe(`user:${TARGET}`);
        expect(pushes[0]!.namespace).toBe('/ws/notify');
        expect(pushes[0]!.payload).toMatchObject({ staffId: TARGET, permissionKey: KEY });
      }
    } finally {
      resetEmitter();
    }
  });

  test('the push carries NO effective permission set — the resolver owns that', async () => {
    asUser = authUser('admin');
    const seen: unknown[] = [];
    setEmitter((_ns, _room, event, payload) => {
      if (event === 'permission_changed') seen.push(payload);
    });
    try {
      await app.inject({ method: 'PUT', url, payload: { value: true } });
      // ADR-022 calls this an INVALIDATE, not a patch: the effective set is the
      // server-side resolver's answer (Sprint 8.1 — one resolver, not two), so the
      // client refetches /v1/staff/me rather than re-deriving it from a payload.
      expect(Object.keys(seen[0] as object).sort()).toEqual(['permissionKey', 'staffId']);
    } finally {
      resetEmitter();
    }
  });

  test('deleting an override that was never set is a no-op, not a 404', async () => {
    asUser = authUser('admin');
    const res = await app.inject({ method: 'DELETE', url });
    // The state the caller asked for is the state we are already in.
    expect(res.statusCode).toBe(200);
  });

  test('a free-text key is rejected before anything is written (§6.2)', async () => {
    asUser = authUser('admin');
    for (const bad of ['bot.tool.definitely_not_a_tool', 'module.nope.read', 'admin', 'chat.acess']) {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/staff/${TARGET}/permissions/${bad}`,
        payload: { value: true },
      });
      expect(res.statusCode, bad).toBe(400);
    }
    const leaked = await db
      .selectFrom('user_permissions')
      .select('permission_key')
      .where('staff_id', '=', TARGET)
      .execute();
    expect(leaked, 'an unknown key stored as an override resolves to nothing, forever').toEqual([]);
  });

  test('every family in the §6.2 convention is accepted', async () => {
    asUser = authUser('admin');
    for (const key of [
      'bot.tool.create_task',
      'module.tasks.read',
      'module.tasks.write',
      'chat.access',
      'report.generate',
      'months.unlock',
    ]) {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/staff/${TARGET}/permissions/${key}`,
        payload: { value: true },
      });
      expect(res.statusCode, key).toBe(200);
    }
  });
});

describe('months lock / unlock', () => {
  const lockUrl = `/v1/months/${LOCK_PERIOD}/lock`;

  test('lock, then unlock WITH a reason — the reason is stored and returned', async () => {
    asUser = authUser('admin');

    const locked = await app.inject({ method: 'POST', url: lockUrl });
    expect(locked.statusCode, locked.payload).toBe(200);
    const lockedBody = JSON.parse(locked.payload).data;
    expect(lockedBody.locked).toBe(true);
    expect(lockedBody.lockedByName, 'a uuid is not an accountability record').toBe('S admin');

    const unlocked = await app.inject({
      method: 'DELETE',
      url: lockUrl,
      payload: { reason: 'Payroll correction for March' },
    });
    expect(unlocked.statusCode).toBe(200);
    const body = JSON.parse(unlocked.payload).data;
    expect(body.locked).toBe(false);
    expect(body.unlockReason).toBe('Payroll correction for March');
    expect(body.unlockedByName).toBe('S admin');
  });

  test('⭐ unlock WITHOUT a reason → 400 UNLOCK_REASON_REQUIRED, and stays locked', async () => {
    asUser = authUser('admin');
    await app.inject({ method: 'POST', url: lockUrl });

    for (const payload of [undefined, {}, { reason: '' }, { reason: '   ' }]) {
      const res = await app.inject({ method: 'DELETE', url: lockUrl, payload: payload as never });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('UNLOCK_REASON_REQUIRED');
    }

    const row = await db
      .selectFrom('months')
      .select('locked')
      .where('period', '=', LOCK_PERIOD)
      .executeTakeFirstOrThrow();
    expect(row.locked, 'a refused unlock must not half-apply').toBe(true);
  });

  test('an unknown period → 404 PERIOD_NOT_FOUND', async () => {
    asUser = authUser('admin');
    const res = await app.inject({ method: 'POST', url: '/v1/months/1999-01/lock' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error.code).toBe('PERIOD_NOT_FOUND');
  });

  test('re-locking a locked period → 409, so locked_by is never rewritten', async () => {
    asUser = authUser('admin');
    await app.inject({ method: 'POST', url: lockUrl });
    const again = await app.inject({ method: 'POST', url: lockUrl });
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.payload).error.code).toBe('ALREADY_PROCESSED');
  });

  test('a malformed period is rejected by the schema', async () => {
    asUser = authUser('admin');
    const res = await app.inject({ method: 'POST', url: '/v1/months/march/lock' });
    expect(res.statusCode).toBe(400);
  });

  test('locking is what assertPeriodNotLocked has been reading since Sprint 3', async () => {
    asUser = authUser('admin');
    await app.inject({ method: 'POST', url: lockUrl });

    const { assertPeriodNotLocked } = await import('../../src/services/BaseService.js');
    await expect(assertPeriodNotLocked(LOCK_PERIOD, db)).rejects.toMatchObject({
      code: 'PERIOD_LOCKED',
    });
  });
});

describe('⭐ rejection_note never reaches the rejected user (NFR §4.2)', () => {
  async function makeRejected() {
    const req = await db
      .insertInto('signup_requests')
      .values({
        name: 'Rejected Person',
        email: `rejected${DOMAIN}`,
        date_of_birth: '1995-06-15',
        mobile_number: '+11234567890',
        role_requested: 'team_member',
        status: 'rejected',
        rejection_note: 'INTERNAL-ONLY-CANARY',
        public_rejection_message: 'We are not hiring right now.',
        reviewed_by: ids.admin,
        reviewed_at: sql`now()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return req.id;
  }

  test('the admin panel DOES show it — that is the whole point of storing it', async () => {
    await makeRejected();
    asUser = authUser('admin');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/settings/signup-requests?status=rejected',
    });
    expect(res.payload).toContain('INTERNAL-ONLY-CANARY');
  });

  test('the applicant-facing status endpoint carries only the PUBLIC message', async () => {
    await makeRejected();
    // Asserted against the SERIALISED body, not the DTO: a field that leaks does
    // so in the bytes on the wire, and a shape assertion cannot see a stray spread.
    const { signupStatusRoutes } = await import('../../src/routes/auth/signup-status.js');
    const pub = Fastify();
    pub.setValidatorCompiler(validatorCompiler);
    pub.setSerializerCompiler(serializerCompiler);
    pub.decorate('db', db);
    await pub.register(signupStatusRoutes, { prefix: '/v1' });
    await pub.ready();

    const res = await pub.inject({
      method: 'GET',
      url: `/v1/auth/signup-requests/me/status?email=rejected${DOMAIN}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('INTERNAL-ONLY-CANARY');
    expect(res.payload).not.toContain('rejectionNote');
    expect(res.payload).toContain('We are not hiring right now.');
    await pub.close();
  });
});
