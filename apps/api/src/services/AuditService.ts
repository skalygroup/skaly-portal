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
 *   - changed_by_source comes from the caller, else the ambient bot-execution
 *     source (ADR-016), else 'user'/'system' by whether there is an actor.
 */
import { SYSTEM_ACTOR_UUID } from '@skaly/shared';
import { sql } from 'kysely';

import { currentActorSource } from '../lib/bot/actor-context.js';
import { AppError } from '../lib/errors.js';

import type { Executor } from './BaseService.js';
import type { Role } from '@skaly/shared/schemas/auth';

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

/**
 * A read-side audit row (get_audit_log tool + the Sprint 11 /settings/audit-log
 * UI). Deliberately projected — id/who/table/record/action/when + a short human
 * `summary`. The raw old_value/new_value JSONB is NEVER included: it carries DOB,
 * mobile, CV keys, and signup rejection notes (NFR §4.2, never-transmitted), and
 * the bot tool result leaves our infrastructure into the model's context.
 */
export interface AuditEntry {
  id: string;
  staffId: string;
  staffName: string | null;
  tableName: string;
  action: string;
  recordId: string | null;
  source: string;
  createdAt: string;
  summary: string;
}

export interface AuditQuery {
  /** Caller's role — asserted admin HERE, not only at the bot tool gate. */
  callerRole: Role;
  limit?: number;
  offset?: number;
  tableName?: string;
  action?: string;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** True if more rows exist past this page (detected without a COUNT). */
  hasMore: boolean;
}

const AUDIT_VERBS: Record<string, string> = {
  INSERT: 'created',
  UPDATE: 'updated',
  DELETE: 'deleted',
  LOCK: 'locked',
  UNLOCK: 'unlocked',
  DEACTIVATE: 'deactivated',
};

export class AuditService {
  /**
   * Recent audit_log entries, newest first — admin only (asserted here). Paginated
   * (default 20, max 50) with optional table/action filters, sized for both the bot
   * tool and the Sprint 11 settings UI. Append-only table, read-only SELECT.
   */
  async query(opts: AuditQuery, db: Executor): Promise<AuditPage> {
    if (opts.callerRole !== 'admin') {
      throw new AppError('PERMISSION_DENIED', 'The audit log is available to admins only.');
    }
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const offset = Math.max(opts.offset ?? 0, 0);

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
      .limit(limit + 1) // +1 row detects hasMore without a COUNT
      .offset(offset);
    if (opts.tableName) q = q.where('audit_log.table_name', '=', opts.tableName);
    if (opts.action) q = q.where('audit_log.action', '=', opts.action);

    const rows = await q.execute();
    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit).map((r) => {
      const createdAt = r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt);
      const who = r.staffName ?? 'System';
      const verb = AUDIT_VERBS[r.action] ?? r.action.toLowerCase();
      const rec = r.recordId ? ` (${r.recordId})` : '';
      return { ...r, createdAt, summary: `${who} ${verb} ${r.tableName}${rec}` };
    });
    return { entries, hasMore };
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
    // Precedence: an explicit actorSource, then the ambient bot-execution source
    // (ADR-016 — set by withActorSource around a mutation tool's handler, so nested
    // writes inside the service are attributed too), then the default.
    //
    // A genuinely unattended write has no actorId and stays 'system' + the System
    // Actor regardless of ambient state; ADR-016 reserves that for rollover and
    // trigger recomputes, never for "the bot did it".
    const source: ChangedBySource =
      actorSource ?? (input.actorId ? currentActorSource() ?? 'user' : 'system');

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