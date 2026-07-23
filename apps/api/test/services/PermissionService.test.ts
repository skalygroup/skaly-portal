import { Redis } from 'ioredis';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterEach, afterAll } from 'vitest';

import { PermissionService } from '../../src/services/PermissionService.js';

import type { DB } from '@skaly/shared';

// Integration test: real local Postgres + real Redis (docker), matching the
// house harness. resolvePermission takes the JWT role directly, so no staff
// lookup is needed for the floor — but setOverride writes user_permissions
// (staff_id + set_by FK staff), so the actor + subjects are persistent fixtures.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const svc = new PermissionService(redis);

const permsKey = (staffId: string): string => `perms:${staffId}`;

// Persistent fixture staff — setOverride audits (FK staff), and audit_log has no
// DELETE grant, so these are upserted and NEVER deleted.
const ADMIN = 'e0000000-0000-4000-8000-00000000e001';
const MEMBER = 'e0000000-0000-4000-8000-00000000e002';
const FREELANCER = 'e0000000-0000-4000-8000-00000000e003';
const DOMAIN = '@perm.itest';

async function clearOverrides(): Promise<void> {
  await db.deleteFrom('user_permissions').where('staff_id', 'in', [ADMIN, MEMBER, FREELANCER]).execute();
  await redis.del(permsKey(ADMIN), permsKey(MEMBER), permsKey(FREELANCER));
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN, name: 'Perm Admin', email: `admin-${ADMIN}${DOMAIN}`, role: 'admin', active: true },
      { id: MEMBER, name: 'Perm Member', email: `member-${MEMBER}${DOMAIN}`, role: 'team_member', active: true },
      { id: FREELANCER, name: 'Perm Freelancer', email: `free-${FREELANCER}${DOMAIN}`, role: 'freelancer', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await clearOverrides();
});

afterEach(clearOverrides);

afterAll(async () => {
  await clearOverrides();
  await redis.quit();
  await db.destroy();
});

describe('resolvePermission — ROLE_DEFAULTS floor (no override)', () => {
  test('returns the role default for a granted key', async () => {
    // team_member get_attendance is 🔐-own → true by default (AUTH-MATRIX §5).
    expect(await svc.resolvePermission(MEMBER, 'team_member', 'bot.tool.get_attendance', db)).toBe(true);
  });

  test('returns the role default for a denied key', async () => {
    expect(await svc.resolvePermission(MEMBER, 'team_member', 'bot.tool.get_content_pipeline', db)).toBe(false);
  });

  test('an unknown key floors to false (never fail-open)', async () => {
    expect(await svc.resolvePermission(MEMBER, 'team_member', 'bot.tool.does_not_exist', db)).toBe(false);
  });
});

describe('resolvePermission — explicit override beats the default', () => {
  test('override true on a default-false key grants it', async () => {
    // update_task_status defaults false for team_member; the admin turns it on.
    await svc.setOverride(MEMBER, 'bot.tool.update_task_status', true, ADMIN, db);
    expect(await svc.resolvePermission(MEMBER, 'team_member', 'bot.tool.update_task_status', db)).toBe(true);
  });

  test('override false on a default-true key revokes it', async () => {
    await svc.setOverride(MEMBER, 'bot.tool.list_tasks', false, ADMIN, db);
    expect(await svc.resolvePermission(MEMBER, 'team_member', 'bot.tool.list_tasks', db)).toBe(false);
  });
});

describe('resolvePermission — precedence safety', () => {
  test('a cache MISS reads through to the DB, not straight to the floor', async () => {
    // Seed the override directly (bypassing setOverride's cache-bust) and ensure
    // no perms cache exists — a naive resolver would floor to false here.
    await db
      .insertInto('user_permissions')
      .values({ staff_id: MEMBER, permission_key: 'bot.tool.get_content_pipeline', value: true, set_by: ADMIN })
      .execute();
    await redis.del(permsKey(MEMBER));

    expect(await svc.resolvePermission(MEMBER, 'team_member', 'bot.tool.get_content_pipeline', db)).toBe(true);
  });

  test('Redis unreachable falls back to DB → floor without throwing', async () => {
    const brokenRedis = {
      get: async () => {
        throw new Error('redis down');
      },
      set: async () => undefined,
      del: async () => 0,
    } as unknown as Redis;
    const degraded = new PermissionService(brokenRedis);

    // A seeded override still resolves from the DB…
    await db
      .insertInto('user_permissions')
      .values({ staff_id: MEMBER, permission_key: 'bot.tool.update_task_status', value: true, set_by: ADMIN })
      .execute();
    expect(await degraded.resolvePermission(MEMBER, 'team_member', 'bot.tool.update_task_status', db)).toBe(true);

    // …and a key with no override still floors correctly, never throwing.
    expect(await degraded.resolvePermission(MEMBER, 'team_member', 'bot.tool.get_content_pipeline', db)).toBe(false);
  });
});

describe('setOverride — busts perms:{staffId} on write', () => {
  test('DELetes the cache so the next resolve re-reads', async () => {
    // Warm the cache, prove it is present, then write and prove it is gone.
    await svc.loadCache(MEMBER, db);
    expect(await redis.exists(permsKey(MEMBER))).toBe(1);

    await svc.setOverride(MEMBER, 'bot.tool.get_content_pipeline', true, ADMIN, db);

    expect(await redis.exists(permsKey(MEMBER))).toBe(0);
    expect(await svc.resolvePermission(MEMBER, 'team_member', 'bot.tool.get_content_pipeline', db)).toBe(true);
  });
});

describe('getPermittedBotTools — per-role subset', () => {
  test('a freelancer gets only get_shoot_schedule', async () => {
    expect(await svc.getPermittedBotTools(FREELANCER, 'freelancer', db)).toEqual(['get_shoot_schedule']);
  });

  test('an override is reflected in the permitted subset', async () => {
    // team_member normally has no attendance? — it does (🔐 own). Revoke it and
    // confirm the batch helper drops it while keeping the rest.
    const before = await svc.getPermittedBotTools(MEMBER, 'team_member', db);
    expect(before).toContain('get_attendance');

    await svc.setOverride(MEMBER, 'bot.tool.get_attendance', false, ADMIN, db);
    const after = await svc.getPermittedBotTools(MEMBER, 'team_member', db);
    expect(after).not.toContain('get_attendance');
    expect(after).toContain('list_tasks');
  });
});
