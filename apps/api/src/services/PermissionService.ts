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
import { emitAfterCommit, transactionWithEmits } from '../lib/emit-after-commit.js';
import { logger } from '../lib/logger.js';


import type { Executor } from './BaseService.js';
import type { DB } from '@skaly/shared';
import type { Role } from '@skaly/shared/schemas/auth';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';

/** The 11 read-only bot tools (AUTH-MATRIX §5). */
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

/** The 11 mutation bot tools (Sprint 9, AUTH-MATRIX §5). Their ROLE_DEFAULTS keys
 *  have existed since Sprint 8; this is the list that makes them resolvable. */
export const BOT_MUTATION_TOOL_NAMES = [
  'update_task_status',
  'create_task',
  'assign_task',
  'set_deadline',
  'update_pipeline_stage',
  'update_shoot_slot',
  'update_calendar_cell',
  'add_holiday',
  'remove_holiday',
  'add_client',
  'deactivate_client',
  'reactivate_client',
] as const;

/** All 23. The resolver treats reads and writes identically — one gate, one
 *  default map, no second code path for the dangerous half. */
export const BOT_TOOL_NAMES = [...BOT_QUERY_TOOL_NAMES, ...BOT_MUTATION_TOOL_NAMES] as const;

/**
 * Is this a permission key the system knows about?
 *
 * Lives here so the override endpoint can validate its `:key` param without
 * importing ROLE_DEFAULTS directly — that import is lint-restricted to this file
 * precisely because reading the defaults elsewhere is how the second, override-
 * blind implementation arose (Sprint 8.1 Defect 1).
 */
export function isPermissionKey(key: string): boolean {
  return key in ROLE_DEFAULTS;
}

/** perms:{staffId} — the per-staff override set, JSON array of { permissionKey, value }. */
const permsKey = (staffId: string): string => `perms:${staffId}`;
/** Same namespace the bell uses — one socket connection per client, not two. */
const NOTIFY_NAMESPACE = '/ws/notify';
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
  /** null = inherit — no row, so ROLE_DEFAULTS applies (AUTH-MATRIX §6.1). */
  value: boolean | null;
}

export class PermissionService {
  constructor(private readonly redis: Redis) {}

  /**
   * THE override loader — the only place user_permissions is read for a resolve.
   * Everything below merges on top of this; nothing else queries the table.
   *
   * `keys` narrows the DB read-through to the keys the caller actually needs (the
   * single-key path passes one, the batch path passes none = all). It never
   * narrows correctness: a cache that is loaded but missing a key still reads
   * through, because "absent from the cache" ≠ "not overridden" (rule 1).
   *
   * One Redis read + at most one DB query. Redis failures degrade to DB → floor
   * and are never thrown or allowed to grant.
   */
  private async loadOverrides(
    staffId: string,
    db: Executor,
    keys?: readonly string[],
  ): Promise<Map<string, boolean>> {
    const { cached, redisUp } = await this.readCache(staffId);

    // A loaded cache is authoritative ONLY for the keys present in it.
    const merged = new Map((cached ?? []).map((o) => [o.permissionKey, o.value]));
    const missing = keys ? keys.filter((k) => !merged.has(k)) : undefined;
    // Nothing left to look up: every requested key was already cached.
    if (missing && missing.length === 0) return merged;

    let query = db
      .selectFrom('user_permissions')
      .select(['permission_key', 'value'])
      .where('staff_id', '=', staffId);
    if (missing) query = query.where('permission_key', 'in', missing);
    const rows = await query.execute();
    for (const r of rows) merged.set(r.permission_key, r.value);

    // Refresh the cache when the DB actually had overrides and Redis is up —
    // best-effort, and never on the path that decides the answer.
    if (redisUp && rows.length > 0) await this.loadCache(staffId, db).catch(() => undefined);
    return merged;
  }

  /**
   * THE precedence merge (AUTH-MATRIX §6.1), implemented exactly once: an explicit
   * override wins; otherwise ROLE_DEFAULTS[key][role] is the floor; an unknown key
   * is `false`. Every other entry point delegates here or to loadOverrides.
   *
   * Covers ALL permission families — module.*, chat.*, report.*, months.* as well
   * as bot.tool.* — because /v1/staff/me hands the whole map to the frontend.
   */
  async getEffectivePermissions(
    staffId: string,
    role: Role,
    db: Executor,
  ): Promise<Record<string, boolean>> {
    const overrides = await this.loadOverrides(staffId, db);
    const out: Record<string, boolean> = {};
    for (const key in ROLE_DEFAULTS) {
      out[key] = overrides.get(key) ?? ROLE_DEFAULTS[key]![role];
    }
    return out;
  }

  /**
   * Resolve one permission for a caller. `role` is the JWT role (no DB lookup for
   * the floor). Single-key fast path — same loader, same precedence, narrowed to
   * one key so a per-tool check stays one round trip.
   */
  async resolvePermission(
    staffId: string,
    role: Role,
    permissionKey: string,
    db: Executor,
  ): Promise<boolean> {
    const overrides = await this.loadOverrides(staffId, db, [permissionKey]);
    // Safe floor (unknown key → false). Never fail-open.
    return overrides.get(permissionKey) ?? ROLE_DEFAULTS[permissionKey]?.[role] ?? false;
  }

  /**
   * Split the 11 query tools into what this caller may and may not use.
   *
   * Both halves are returned from one computation: Sprint 8.1 needs `denied` to
   * build the system prompt's TOOL ACCESS section, and deriving the complement
   * anywhere else would be a second source of truth for the same split.
   */
  async getPermittedBotTools(
    staffId: string,
    role: Role,
    db: Executor,
  ): Promise<{ permitted: string[]; denied: string[] }> {
    const keys = BOT_TOOL_NAMES.map((n) => `bot.tool.${n}`);
    const overrides = await this.loadOverrides(staffId, db, keys);

    const permitted: string[] = [];
    const denied: string[] = [];
    for (const name of BOT_TOOL_NAMES) {
      const key = `bot.tool.${name}`;
      const allowed = overrides.get(key) ?? ROLE_DEFAULTS[key]?.[role] ?? false;
      (allowed ? permitted : denied).push(name);
    }
    return { permitted, denied };
  }

  /**
   * THE admin override write — all three states through one seam (AUTH-MATRIX §6.1).
   *
   *   value === true   → ALLOW  (row with value = true)
   *   value === false  → DENY   (row with value = false)
   *   value === null   → INHERIT (row DELETED, so the role default applies again)
   *
   * Inherit has to be a delete, not a third column value: §6.1's precedence rule is
   * "no row found → fall through to role default", so any row at all is an override.
   * A UI that can only write true/false can never restore inheritance — once an
   * admin sets Deny on something the role grants, the role default becomes
   * unreachable forever.
   *
   * ONE seam, because the four steps are one operation: write, audit, bust
   * `perms:{staffId}`, emit `permission_changed`. Split across call sites, the
   * inherit path is exactly the one that would quietly lose the bust or the emit —
   * it is the path nobody remembers to wire.
   *
   * The BUST is the enforcement boundary (§6.3): the key is deleted, so the user's
   * next request re-resolves from the database. The EMIT is UX only (ADR-029) — if
   * it is dropped the user stays visually stale until their next request, which
   * then corrects them. Fail-safe by construction.
   */
  async setOverride(
    staffId: string,
    permissionKey: string,
    value: boolean | null,
    actorId: string,
    db: Kysely<DB>,
  ): Promise<PermissionOverride> {
    const audit = new AuditService();

    await transactionWithEmits(db, async (trx) => {
      const existing = await trx
        .selectFrom('user_permissions')
        .select(['id', 'value'])
        .where('staff_id', '=', staffId)
        .where('permission_key', '=', permissionKey)
        .executeTakeFirst();

      if (value === null) {
        // Inherit. Deleting nothing is not an error — the state the caller asked
        // for is the state we are already in.
        if (existing) {
          await trx.deleteFrom('user_permissions').where('id', '=', existing.id).execute();
          await audit.log({
            actorId,
            actorSource: 'user',
            entity: 'user_permissions',
            entityId: existing.id,
            action: 'DELETE',
            before: { permissionKey, value: existing.value },
            after: { permissionKey, value: null, resolvesTo: 'role default' },
            trx,
          });
        }
        return;
      }

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
        before: existing ? { permissionKey, value: existing.value } : null,
        after: { permissionKey, value },
        trx,
      });
    });

    await this.bustCache(staffId);

    // ADR-029. Payload-free by design: the effective set is the resolver's answer,
    // and the resolver lives here on the server (Sprint 8.1 — one resolver, not
    // two). ADR-022's matrix calls this an INVALIDATE, so the client refetches
    // /v1/staff/me rather than patching a set it would have to re-derive itself.
    emitAfterCommit(NOTIFY_NAMESPACE, `user:${staffId}`, 'permission_changed', {
      staffId,
      permissionKey,
    });

    return { staffId, permissionKey, value };
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
