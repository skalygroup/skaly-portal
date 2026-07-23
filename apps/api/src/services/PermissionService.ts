/**
 * PermissionService — the behavioural permission resolver (AUTH-MATRIX §6),
 * deferred since Sprint 3 and built here against its first consumer, the bot
 * tool filter (Sprint 8 STEP 2/3).
 *
 * Three-layer precedence (pre-Sprint-8 ruling, AUTH-MATRIX §6.1):
 *   explicit override (Redis perms:{staffId} → DB read-through on a miss)
 *     BEATS
 *   ROLE_DEFAULTS[key][role]  — the SAFE FLOOR, applied last, never the reverse.
 *
 * Two rules make this correct rather than merely cached:
 *   1. "Not in the cached array" ≠ "not overridden". The cache is treated as
 *      possibly-incomplete: a key absent from a loaded cache reads THROUGH to
 *      user_permissions before falling to the floor. Only a DB with no row means
 *      no override.
 *   2. Never fail-open. A Redis error is logged and degrades to DB → floor; it is
 *      never allowed to grant (or throw). An unknown key floors to `false`.
 *
 * The role default itself lives in ONE place — ROLE_DEFAULTS (packages/shared).
 * 🔐 own-data scoping and the ADR-011 freelancer predicate are NOT here — they
 * live in the isolating service methods the tools call.
 */
import { ROLE_DEFAULTS } from '@skaly/shared';

import { AuditService } from './AuditService.js';
import { logger } from '../lib/logger.js';


import type { Executor } from './BaseService.js';
import type { DB } from '@skaly/shared';
import type { Role } from '@skaly/shared/schemas/auth';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';

/** The 11 read-only bot tools this sprint ships (AUTH-MATRIX §5). Mutation tools
 *  (Sprint 9) are gated by the same resolver but not filtered here. */
export const BOT_QUERY_TOOL_NAMES = [
  'get_project_status',
  'list_tasks',
  'list_overdue_tasks',
  'get_user_workload',
  'get_attendance',
  'get_shoot_schedule',
  'get_content_pipeline',
  'get_content_calendar',
  'get_audit_log',
  'get_holiday_list',
  'get_client_summary',
] as const;

/** perms:{staffId} — the per-staff override set, JSON array of { permissionKey, value }. */
const permsKey = (staffId: string): string => `perms:${staffId}`;
/** AUTH-MATRIX §6.3: 5-minute TTL. An override write busts the key so a change
 *  takes effect immediately and a stale grant can never outlive the window. */
const PERMS_TTL_SECONDS = 5 * 60;

interface OverrideEntry {
  permissionKey: string;
  value: boolean;
}

export interface PermissionOverride {
  staffId: string;
  permissionKey: string;
  value: boolean;
}

export class PermissionService {
  constructor(private readonly redis: Redis) {}

  /**
   * Resolve one permission for a caller. `role` is the JWT role (no DB lookup for
   * the floor). Precedence: override (cache → DB read-through) → ROLE_DEFAULTS floor.
   */
  async resolvePermission(
    staffId: string,
    role: Role,
    permissionKey: string,
    db: Executor,
  ): Promise<boolean> {
    const { cached, redisUp } = await this.readCache(staffId);

    // 1. Cache HIT for this key is authoritative.
    if (cached) {
      const hit = cached.find((o) => o.permissionKey === permissionKey);
      if (hit) return hit.value;
      // Key absent from a loaded cache is NOT authoritative — read through (rule 1).
    }

    // 2. DB read-through.
    const row = await db
      .selectFrom('user_permissions')
      .select('value')
      .where('staff_id', '=', staffId)
      .where('permission_key', '=', permissionKey)
      .executeTakeFirst();
    if (row) {
      // Populate/refresh the cache when Redis is reachable (best-effort).
      if (redisUp) await this.loadCache(staffId, db).catch(() => undefined);
      return row.value;
    }

    // 3. Safe floor (unknown key → false). Never fail-open.
    return ROLE_DEFAULTS[permissionKey]?.[role] ?? false;
  }

  /**
   * The permitted subset of the 11 query tools for a caller — one Redis read plus
   * a single DB query for the keys not already in the cache, not 11 round-trips.
   */
  async getPermittedBotTools(staffId: string, role: Role, db: Executor): Promise<string[]> {
    const { cached } = await this.readCache(staffId);
    const cachedMap = new Map((cached ?? []).map((o) => [o.permissionKey, o.value]));

    const resolved = new Map<string, boolean>();
    const missing: string[] = [];
    for (const name of BOT_QUERY_TOOL_NAMES) {
      const key = `bot.tool.${name}`;
      if (cachedMap.has(key)) resolved.set(key, cachedMap.get(key)!);
      else missing.push(key);
    }

    if (missing.length > 0) {
      const rows = await db
        .selectFrom('user_permissions')
        .select(['permission_key', 'value'])
        .where('staff_id', '=', staffId)
        .where('permission_key', 'in', missing)
        .execute();
      const dbMap = new Map(rows.map((r) => [r.permission_key, r.value]));
      for (const key of missing) {
        resolved.set(key, dbMap.get(key) ?? ROLE_DEFAULTS[key]?.[role] ?? false);
      }
    }

    return BOT_QUERY_TOOL_NAMES.filter((name) => resolved.get(`bot.tool.${name}`) === true);
  }

  /**
   * Admin override write: upsert user_permissions + audit in one transaction,
   * then DEL perms:{staffId} so the next resolve re-reads. The cache-bust always
   * accompanies the write — that is the whole point of the endpoint.
   */
  async setOverride(
    staffId: string,
    permissionKey: string,
    value: boolean,
    actorId: string,
    db: Kysely<DB>,
  ): Promise<PermissionOverride> {
    const audit = new AuditService();
    const updated = await db.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom('user_permissions')
          .select(['id', 'value'])
          .where('staff_id', '=', staffId)
          .where('permission_key', '=', permissionKey)
          .executeTakeFirst();

        const row = await trx
          .insertInto('user_permissions')
          .values({ staff_id: staffId, permission_key: permissionKey, value, set_by: actorId })
          .onConflict((oc) =>
            oc.columns(['staff_id', 'permission_key']).doUpdateSet({ value, set_by: actorId }),
          )
          .returning(['id', 'staff_id', 'permission_key', 'value'])
          .executeTakeFirstOrThrow();

        await audit.log({
          actorId,
          actorSource: 'user',
          entity: 'user_permissions',
          entityId: row.id,
          action: existing ? 'UPDATE' : 'INSERT',
          before: existing ? { value: existing.value } : null,
          after: { value },
          trx,
        });

        return row;
      });

    await this.bustCache(staffId);
    return { staffId: updated.staff_id, permissionKey: updated.permission_key, value: updated.value };
  }

  /** Build the full override array from user_permissions and cache it (5-min TTL).
   *  Best-effort: a Redis failure is logged, never thrown. */
  async loadCache(staffId: string, db: Executor): Promise<OverrideEntry[]> {
    const rows = await db
      .selectFrom('user_permissions')
      .select(['permission_key', 'value'])
      .where('staff_id', '=', staffId)
      .execute();
    const entries: OverrideEntry[] = rows.map((r) => ({ permissionKey: r.permission_key, value: r.value }));
    try {
      await this.redis.set(permsKey(staffId), JSON.stringify(entries), 'EX', PERMS_TTL_SECONDS);
    } catch (err) {
      logger.warn({ err, staffId }, 'perms cache write failed');
    }
    return entries;
  }

  /** DEL perms:{staffId}. Never throws — a failed bust falls back to the 5-min TTL. */
  private async bustCache(staffId: string): Promise<void> {
    try {
      await this.redis.del(permsKey(staffId));
    } catch (err) {
      logger.warn({ err, staffId }, 'perms cache bust failed');
    }
  }

  /** Read + parse perms:{staffId}. A miss or a Redis error yields cached=null
   *  (redisUp flags which, only to decide whether a refresh is worth attempting). */
  private async readCache(staffId: string): Promise<{ cached: OverrideEntry[] | null; redisUp: boolean }> {
    try {
      const raw = await this.redis.get(permsKey(staffId));
      return { cached: raw ? (JSON.parse(raw) as OverrideEntry[]) : null, redisUp: true };
    } catch (err) {
      logger.warn({ err, staffId }, 'perms cache read failed; falling through to DB');
      return { cached: null, redisUp: false };
    }
  }
}
