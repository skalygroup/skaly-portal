/**
 * AuditQueryService — the Settings → Audit Log panel's read side (ADR-028).
 *
 * Separate from `AuditService`, which owns the WRITE path plus the bot's
 * deliberately narrower `query`. The bot's projection excludes `old_value` /
 * `new_value` on purpose (it feeds the model human summaries, never raw JSONB),
 * and merging the two would put one careless `selectAll` between the model and
 * every diff in the product.
 *
 * THERE ARE NO MUTATIONS HERE, AND THERE CANNOT BE. Migration 026 revokes UPDATE
 * and DELETE on `audit_log` from `skaly_app`, so the table is append-only at the
 * role level. That is also what makes the export safe to stream: rows are
 * immutable, so a cursor held open for 50k rows cannot observe one changing
 * underneath it.
 */
import { SYSTEM_ACTOR_UUID } from '@skaly/shared';

import { AppError } from '../lib/errors.js';

import type { Executor } from './BaseService.js';
import type { DB } from '@skaly/shared';
import type { Role } from '@skaly/shared/schemas/auth';
import type { SelectQueryBuilder } from 'kysely';

/** NFR §5.3's filter set. Every field optional; they compose with AND. */
export interface AuditFilters {
  /** Inclusive, IST calendar date `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive, IST calendar date `YYYY-MM-DD` — the whole day is included. */
  to?: string;
  staffId?: string;
  tableName?: string;
  action?: string;
  recordId?: string;
  changedBySource?: string;
}

export interface AuditEntry {
  id: string;
  createdAt: string;
  actorId: string;
  actorName: string;
  actorRole: string | null;
  source: string;
  tableName: string;
  action: string;
  recordId: string | null;
  oldValue: unknown;
  newValue: unknown;
  ipAddress: string | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Opaque; pass back as `cursor` for the next page. Null when exhausted. */
  nextCursor: string | null;
}

/** The row shape both sinks read. Named so the CSV mapper cannot drift from it. */
interface AuditRow {
  id: string;
  created_at: Date;
  staff_id: string;
  actorName: string | null;
  actorRole: string | null;
  changed_by_source: string;
  table_name: string;
  action: string;
  record_id: string | null;
  old_value: unknown;
  new_value: unknown;
  ip_address: string | null;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/** IST, to the second. The panel and the CSV must agree on what "when" means. */
const IST = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function istTimestamp(d: Date): string {
  // en-CA gives `YYYY-MM-DD, HH:mm:ss`; the comma is the only thing to drop.
  return IST.format(d).replace(', ', ' ');
}

/**
 * The System Actor is a real `staff` row (audit C-04: `staff_id` is never null),
 * so it JOINs to a name — but that name is an implementation detail nobody
 * reading an audit log should have to recognise. Rendered as "System" in one
 * place, so the panel and the export cannot disagree about who did it.
 */
function actorName(row: AuditRow): string {
  return row.staff_id === SYSTEM_ACTOR_UUID ? 'System' : (row.actorName ?? 'Unknown');
}

/**
 * ⭐ THE shared predicate — ADR-028 §3.
 *
 * ONE `WHERE` clause feeds both sinks: the paginated JSON the panel renders, and
 * the streamed CSV the [Export] button downloads. An export that quietly
 * disagrees with the table it was exported from is worse than no export, and it
 * is exactly what two hand-maintained filter chains produce after the third
 * filter is added to one of them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilters<T extends SelectQueryBuilder<DB, 'audit_log' | any, any>>(
  qb: T,
  f: AuditFilters,
): T {
  let q = qb;
  // Half-open on the upper bound so the whole `to` day is included without
  // depending on how Postgres compares a bare date to a timestamptz.
  if (f.from) q = q.where('audit_log.created_at', '>=', new Date(`${f.from}T00:00:00+05:30`)) as T;
  if (f.to) q = q.where('audit_log.created_at', '<', new Date(`${f.to}T00:00:00+05:30`)) as T;
  if (f.staffId) q = q.where('audit_log.staff_id', '=', f.staffId) as T;
  if (f.tableName) q = q.where('audit_log.table_name', '=', f.tableName) as T;
  if (f.action) q = q.where('audit_log.action', '=', f.action) as T;
  if (f.recordId) q = q.where('audit_log.record_id', '=', f.recordId) as T;
  if (f.changedBySource) q = q.where('audit_log.changed_by_source', '=', f.changedBySource) as T;
  return q;
}

export class AuditQueryService {
  /** Auth-Matrix §4: admin only, and it stays that way. The role-filtered
   *  `/v1/activity-feed` (Sprint 9) is the surface for everyone else — they are
   *  not the same query with a different gate, and merging them is what would
   *  turn one missed branch into a leak. */
  private assertAdmin(callerRole: Role): void {
    if (callerRole !== 'admin') {
      throw new AppError('PERMISSION_DENIED', 'The audit log is available to admins only.');
    }
  }

  /**
   * The base SELECT, shared by both sinks. Columns are listed EXPLICITLY: a
   * future column added to `audit_log` must not silently widen an export that
   * someone downloads and mails around.
   */
  private baseQuery(f: AuditFilters, db: Executor) {
    return applyFilters(
      db
        .selectFrom('audit_log')
        .leftJoin('staff', 'staff.id', 'audit_log.staff_id')
        .select([
          'audit_log.id',
          'audit_log.created_at',
          'audit_log.staff_id',
          'staff.name as actorName',
          'staff.role as actorRole',
          'audit_log.changed_by_source',
          'audit_log.table_name',
          'audit_log.action',
          'audit_log.record_id',
          'audit_log.old_value',
          'audit_log.new_value',
          'audit_log.ip_address',
        ]),
      f,
    ).orderBy('audit_log.created_at', 'desc');
  }

  /**
   * Keyset pagination on `(created_at DESC, id DESC)`.
   *
   * Keyset rather than OFFSET because `audit_log` is append-only and written to
   * constantly: with OFFSET, a row inserted while an admin reads page 3 shifts
   * every later page by one, so they see a row twice and never see another. The
   * `id` tiebreak matters — `created_at` alone is not unique, and two rows in the
   * same transaction share it to the microsecond.
   */
  async list(
    filters: AuditFilters,
    cursor: string | undefined,
    limit: number | undefined,
    callerRole: Role,
    db: Executor,
  ): Promise<AuditPage> {
    this.assertAdmin(callerRole);
    const take = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    let q = this.baseQuery(filters, db).orderBy('audit_log.id', 'desc');

    const decoded = decodeCursor(cursor);
    if (decoded) {
      // Row-value comparison: the tuple form is what lets one index seek do the
      // work. Written out per column it becomes an OR that Postgres will not
      // use the (created_at DESC) index for.
      q = q.where(({ eb, refTuple, tuple }) =>
        eb(
          refTuple('audit_log.created_at', 'audit_log.id'),
          '<',
          tuple(decoded.createdAt, decoded.id),
        ),
      );
    }

    const rows = (await q.limit(take + 1).execute()) as unknown as AuditRow[];
    const hasMore = rows.length > take;
    const page = rows.slice(0, take);
    const last = page.at(-1);

    return {
      entries: page.map(toEntry),
      nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  /**
   * The export's row source — a real Postgres cursor via `pg-query-stream`.
   *
   * Same `baseQuery`, so the export can only ever contain what the panel showed.
   * No `limit`: the whole point is that the response size is a function of the
   * data, and nothing buffers it.
   */
  streamRows(filters: AuditFilters, callerRole: Role, db: Executor): AsyncIterable<AuditRow> {
    this.assertAdmin(callerRole);
    // `.stream()` throws at RUNTIME without pg-query-stream installed — there is
    // no type error to catch it, which is why it is a direct dependency and not
    // something inherited transitively.
    return this.baseQuery(filters, db).orderBy('audit_log.id', 'desc').stream() as AsyncIterable<AuditRow>;
  }

  /**
   * ⭐ The CSV column table — ADR-028 §4, and the answer to "where do nulls,
   * JSONB, the System Actor and the timezone get handled?". Here, once, as data.
   * A stack of conditionals inside a row loop is how the export and the panel
   * end up formatting the same value two ways.
   *
   * `old_value` / `new_value` are stringified JSON containing commas, quotes and
   * newlines BY CONSTRUCTION. Nothing here escapes them — `csv-stringify` does,
   * which is the entire reason it is a dependency.
   */
  static readonly CSV_COLUMNS: ReadonlyArray<{
    key: string;
    header: string;
    value: (r: AuditRow) => string;
  }> = [
    { key: 'timestamp', header: 'Timestamp (IST)', value: (r) => istTimestamp(r.created_at) },
    { key: 'actor', header: 'Actor', value: actorName },
    { key: 'actorRole', header: 'Actor role', value: (r) => r.actorRole ?? '' },
    { key: 'source', header: 'Source', value: (r) => r.changed_by_source },
    { key: 'table', header: 'Table', value: (r) => r.table_name },
    { key: 'action', header: 'Action', value: (r) => r.action },
    { key: 'recordId', header: 'Record id', value: (r) => r.record_id ?? '' },
    { key: 'oldValue', header: 'Old value', value: (r) => jsonCell(r.old_value) },
    { key: 'newValue', header: 'New value', value: (r) => jsonCell(r.new_value) },
    { key: 'ip', header: 'IP address', value: (r) => r.ip_address ?? '' },
  ];

  /** One row, mapped through the column table — never hand-assembled. */
  static toCsvRecord(row: AuditRow): Record<string, string> {
    return Object.fromEntries(AuditQueryService.CSV_COLUMNS.map((c) => [c.key, c.value(row)]));
  }
}

/** JSONB → a cell. Empty for null so the column reads as blank, not "null". */
function jsonCell(v: unknown): string {
  return v === null || v === undefined ? '' : JSON.stringify(v);
}

function toEntry(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    createdAt: r.created_at.toISOString(),
    actorId: r.staff_id,
    actorName: actorName(r),
    actorRole: r.actorRole,
    source: r.changed_by_source,
    tableName: r.table_name,
    action: r.action,
    recordId: r.record_id,
    oldValue: r.old_value,
    newValue: r.new_value,
    ipAddress: r.ip_address,
  };
}

/** `<iso>|<uuid>`, base64url'd so it reads as opaque and survives a query string. */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor?: string): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = iso ? new Date(iso) : new Date(NaN);
  if (!id || Number.isNaN(createdAt.getTime())) {
    throw new AppError('VALIDATION_ERROR', 'That page cursor is not valid.');
  }
  return { createdAt, id };
}
