/**
 * Soft-delete helpers (audit H-02).
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 * Soft-deletable tables (staff, clients, tasks, messages) are NEVER hard
 * deleted. A row is retired by stamping `deleted_at`, and EVERY read against
 * these tables must exclude tombstoned rows by passing the query through
 * `softDeletable(qb)`. A bare SELECT that forgets this will leak deleted rows.
 *
 *   - softDelete(table, id, deletedBy, trx) — stamp deleted_at, return the row.
 *     The CALLER writes the audit_log row (action: 'DELETE') using its actor;
 *     softDelete only flips the timestamp (these tables have no deleted_by
 *     column, so `deletedBy` is not persisted here).
 *   - softDeletable(qb) — append `WHERE deleted_at IS NULL` to a SELECT.
 *
 * Both run inside the caller's transaction — neither opens its own.
 */
import { sql, type Kysely, type Selectable, type SelectQueryBuilder } from 'kysely';

import { AppError } from './errors.js';

import type { Executor } from '../services/BaseService.js';
import type { DB } from '@skaly/shared';

/**
 * Tables carrying a `deleted_at` column: exactly staff, clients, tasks,
 * messages. Derived from the schema so it stays correct as tables are added.
 */
export type SoftDeletableTable = {
  [K in keyof DB]: 'deleted_at' extends keyof DB[K] ? K : never;
}[keyof DB];

// See BaseService.ts for why the dynamic-table query runs on a loose builder.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loose = (trx: Executor): Kysely<any> => trx as unknown as Kysely<any>;

/**
 * Retire a row by stamping `deleted_at = now()`; returns the updated row.
 * Actor attribution (audit_log with action 'DELETE') is the caller's job.
 */
export async function softDelete<T extends SoftDeletableTable>(
  table: T,
  id: string,
  _deletedBy: string,
  trx: Executor,
): Promise<Selectable<DB[T]>> {
  // Collapse the generic table param to a plain string (see BaseService.ts) and
  // build the SET from a Record var so it isn't excess-property-checked.
  const t = table as string;
  const setValues: Record<string, unknown> = { deleted_at: sql`now()` };

  const row = await loose(trx)
    .updateTable(t)
    .set(setValues)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();

  if (!row) {
    throw new AppError('RESOURCE_NOT_FOUND', `${table} row ${id} does not exist.`);
  }
  return row as Selectable<DB[T]>;
}

/**
 * Append `WHERE deleted_at IS NULL` to a SELECT on a soft-deletable table.
 * Every read of staff/clients/tasks/messages must go through this. Generic over
 * the builder type so the caller's row shape flows straight through.
 */
export function softDeletable<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  QB extends SelectQueryBuilder<any, any, any>,
>(qb: QB): QB {
  return qb.where('deleted_at', 'is', null) as QB;
}