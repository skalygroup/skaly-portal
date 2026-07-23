/**
 * AuditService — the ONE sanctioned write path into audit_log (05-BACKEND-SCHEMA
 * §6, audit B-01/C-02/C-04).
 *
 * Lockdown style (B): skaly_app has INSERT revoked on audit_log; the only way
 * in is the SECURITY DEFINER function audit_log_insert(...) (migration 027). So
 * log() calls that function — never insertInto('audit_log') — and NEVER updates
 * or deletes (the table is append-only).
 *
 * Invariants:
 *   - staff_id is NEVER null. A missing actor falls back to SYSTEM_ACTOR_UUID
 *     and the source becomes 'system' (audit C-04).
 *   - action must be one of the six enum values; a stale dotted string (e.g.
 *     'invite.create') is rejected before it can hit the DB CHECK.
 */
import { SYSTEM_ACTOR_UUID } from '@skaly/shared';
import { sql } from 'kysely';

import { AppError } from '../lib/errors.js';

import type { Executor } from './BaseService.js';

/** The audit_log.action CHECK enum (05-BACKEND-SCHEMA §6). */
export const AUDIT_ACTIONS = ['INSERT', 'UPDATE', 'DELETE', 'LOCK', 'UNLOCK', 'DEACTIVATE'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** audit_log.changed_by_source enum. */
export type ChangedBySource = 'user' | 'system' | 'bot';

export interface AuditLogInput {
  /** → staff_id. Null/undefined ⇒ SYSTEM_ACTOR_UUID + source 'system'. */
  actorId?: string | null;
  /** → changed_by_source. Defaults to 'user' (or 'system' when actorId is absent). */
  actorSource?: ChangedBySource;
  /** → table_name: the literal table string, e.g. 'invite_links', 'staff'. */
  entity: string;
  /** → record_id (UUID). */
  entityId?: string | null;
  /** → action. One of AUDIT_ACTIONS. */
  action: AuditAction;
  /** → old_value (JSONB). */
  before?: unknown;
  /** → new_value (JSONB). */
  after?: unknown;
  /** → ip_address (INET), nullable. */
  ip?: string | null;
  /** The caller's transaction (or the base db when no txn is open). */
  trx: Executor;
}

/** A read-side audit row (get_audit_log tool / settings audit view). */
export interface AuditEntry {
  id: string;
  staffId: string;
  staffName: string | null;
  tableName: string;
  action: string;
  recordId: string | null;
  source: string;
  createdAt: string;
}

export class AuditService {
  /**
   * Recent audit_log entries, newest first (get_audit_log — admin only; the bot
   * tool filter already excludes it for others and the handler asserts too).
   * Read-only SELECT with the actor name joined; append-only table, no writes.
   */
  async query(opts: { limit?: number; tableName?: string }, db: Executor): Promise<AuditEntry[]> {
    let q = db
      .selectFrom('audit_log')
      .leftJoin('staff', 'staff.id', 'audit_log.staff_id')
      .select([
        'audit_log.id as id',
        'audit_log.staff_id as staffId',
        'staff.name as staffName',
        'audit_log.table_name as tableName',
        'audit_log.action as action',
        'audit_log.record_id as recordId',
        'audit_log.changed_by_source as source',
        'audit_log.created_at as createdAt',
      ])
      .orderBy('audit_log.created_at', 'desc')
      .limit(Math.min(Math.max(opts.limit ?? 20, 1), 100));
    if (opts.tableName) q = q.where('audit_log.table_name', '=', opts.tableName);

    const rows = await q.execute();
    return rows.map((r) => ({
      ...r,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    }));
  }

  /**
   * Append one audit_log row via the SECURITY DEFINER function. Returns the new
   * row's id. Runs inside the caller's transaction — never opens its own.
   */
  async log(input: AuditLogInput): Promise<string> {
    const { actorSource, entity, entityId, action, before, after, ip, trx } = input;

    // Fail fast on a non-enum action (catches Sprint 1's dotted strings) before
    // the DB CHECK would, with a typed error instead of a raw PG exception.
    if (!AUDIT_ACTIONS.includes(action)) {
      throw new AppError('VALIDATION_ERROR', `Invalid audit action: ${String(action)}`, {
        allowed: AUDIT_ACTIONS,
      });
    }

    // Audit C-04: staff_id is never null. No actor ⇒ System Actor + 'system'.
    const staffId = input.actorId ?? SYSTEM_ACTOR_UUID;
    const source: ChangedBySource = actorSource ?? (input.actorId ? 'user' : 'system');

    const oldValue = before === undefined ? null : JSON.stringify(before);
    const newValue = after === undefined ? null : JSON.stringify(after);

    // Positional args match audit_log_insert(p_staff_id, p_table_name, p_action,
    // p_record_id, p_old_value, p_new_value, p_changed_by_source, p_ip_address).
    const result = await sql<{ id: string }>`
      SELECT audit_log_insert(
        ${staffId}::uuid,
        ${entity},
        ${action},
        ${entityId ?? null}::uuid,
        ${oldValue}::jsonb,
        ${newValue}::jsonb,
        ${source},
        ${ip ?? null}::inet
      ) AS id
    `.execute(trx);

    const id = result.rows[0]?.id;
    if (!id) {
      throw new AppError('INTERNAL_ERROR', 'audit_log_insert returned no id.');
    }
    return id;
  }
}