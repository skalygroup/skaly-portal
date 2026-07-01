/**
 * Base service utilities every write path composes with (06-IMPLEMENTATION-PLAN
 * §5). Each function runs inside the caller's transaction — none opens its own.
 *
 *   - assertPeriodNotLocked — month-lock gate for every mutation
 *   - optimisticUpdate      — the ONLY sanctioned write path for versioned rows
 *   - getCurrentPeriod      — the current IST month, computed (months has no
 *                             is_current column), with a latest-period fallback
 *
 * Soft-delete lives in lib/queries.ts.
 */
import { sql, type Kysely, type Transaction, type Selectable, type Updateable } from 'kysely';

import { AppError } from '../lib/errors.js';

import type { DB, Months } from '@skaly/shared';

/** Either a standalone connection or an open transaction. */
export type Executor = Kysely<DB> | Transaction<DB>;

/**
 * Tables carrying an optimistic-lock `version` column (audit C-02): exactly
 * attendance_logs, content_pipelines, content_calendar. Derived from the schema
 * so it stays correct if a new versioned table is added.
 */
export type VersionedTable = {
  [K in keyof DB]: 'version' extends keyof DB[K] ? K : never;
}[keyof DB];

/**
 * Versioned tables that ALSO have an `updated_at` column. content_pipelines is
 * deliberately excluded — migration 015 gives it no updated_at, so writing it
 * would raise "column does not exist". optimisticUpdate bumps updated_at only
 * for tables in this set.
 */
const VERSIONED_TABLES_WITH_UPDATED_AT: ReadonlySet<VersionedTable> = new Set([
  'attendance_logs',
  'content_calendar',
]);

// Kysely cannot statically type a table chosen at runtime, nor a computed
// `version = version + 1` SET. Callers always pass a concrete table literal, so
// we run the dynamic query on a loosely-typed builder and re-attach the row
// type on return. recommended eslint has the no-unsafe-* rules off, so member
// access past this boundary stays lint-clean; this is the one `any` we accept.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loose = (trx: Executor): Kysely<any> => trx as unknown as Kysely<any>;

/**
 * Guard: refuse any write against a locked (or non-existent) month.
 *   - no months row for `period` → PERIOD_NOT_FOUND (404)
 *   - months.locked = true       → PERIOD_LOCKED (423)
 */
export async function assertPeriodNotLocked(period: string, trx: Executor): Promise<void> {
  const row = await trx
    .selectFrom('months')
    .select('locked')
    .where('period', '=', period)
    .executeTakeFirst();

  if (!row) {
    throw new AppError('PERIOD_NOT_FOUND', `Period ${period} does not exist.`);
  }
  if (row.locked) {
    throw new AppError('PERIOD_LOCKED', `Period ${period} is locked.`);
  }
}

/**
 * The only sanctioned way to write a versioned row (audit C-02). Performs
 *   UPDATE {table} SET ...patch, version = version + 1 [, updated_at = now()]
 *   WHERE id = $id AND version = $expectedVersion RETURNING *
 * On a version mismatch (0 rows updated) it re-reads the current row + the name
 * of whoever last touched it and throws STALE_DATA (409) carrying
 * { currentVersion, updatedBy: { staffId, name } }. Returns the full updated row
 * on success (PATCH endpoints return the whole row, 07-API-CONTRACT §1.1).
 *
 * `patch` cannot include version/updated_at — those are managed here.
 */
export async function optimisticUpdate<T extends VersionedTable>(
  table: T,
  id: string,
  expectedVersion: number,
  patch: Omit<Updateable<DB[T]>, 'version' | 'updated_at' | 'id'>,
  trx: Executor,
): Promise<Selectable<DB[T]>> {
  // Collapse the generic table param to a plain string so Kysely resolves the
  // builder methods against concrete (any-column) signatures.
  const t = table as string;

  const setValues: Record<string, unknown> = {
    ...patch,
    version: sql`version + 1`,
  };
  if (VERSIONED_TABLES_WITH_UPDATED_AT.has(table)) {
    setValues.updated_at = sql`now()`;
  }

  const updated = await loose(trx)
    .updateTable(t)
    .set(setValues)
    .where('id', '=', id)
    .where('version', '=', expectedVersion)
    .returningAll()
    .executeTakeFirst();

  if (updated) {
    return updated as Selectable<DB[T]>;
  }

  // 0 rows updated: either the version moved (stale) or the row is gone.
  const current = await loose(trx)
    .selectFrom(t)
    .leftJoin('staff', 'staff.id', `${t}.updated_by`)
    .select([
      `${t}.version as version`,
      `${t}.updated_by as updated_by`,
      'staff.name as updated_by_name',
    ])
    .where(`${t}.id`, '=', id)
    .executeTakeFirst();

  if (!current) {
    throw new AppError('RESOURCE_NOT_FOUND', `${table} row ${id} does not exist.`);
  }

  const row = current as {
    version: number;
    updated_by: string | null;
    updated_by_name: string | null;
  };
  throw new AppError('STALE_DATA', 'This record was updated while you were editing. Please refresh.', {
    currentVersion: row.version,
    updatedBy: row.updated_by ? { staffId: row.updated_by, name: row.updated_by_name } : null,
  });
}

/**
 * The current period as an IST (Asia/Kolkata) `YYYY-MM` string. Computed via
 * Intl so it is correct regardless of the host's TZ — no dependency on the
 * process TZ env or on date-fns-tz (which isn't installed). Exposed for tests
 * and callers that only need the string.
 */
export function currentIstPeriod(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  }).format(now);
}

/**
 * The current month's row. months has no is_current/status column, so we match
 * on the computed IST period; if that row doesn't exist yet (e.g. before the
 * first rollover) we fall back to the most recent period. Throws
 * PERIOD_NOT_FOUND only if the table is empty.
 */
export async function getCurrentPeriod(trx: Executor): Promise<Selectable<Months>> {
  const period = currentIstPeriod();

  const current = await trx
    .selectFrom('months')
    .selectAll()
    .where('period', '=', period)
    .executeTakeFirst();
  if (current) return current;

  const latest = await trx
    .selectFrom('months')
    .selectAll()
    .orderBy('period', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (latest) return latest;

  throw new AppError('PERIOD_NOT_FOUND', 'No periods exist in the months table.');
}