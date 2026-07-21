/**
 * ContentCalendarService — the read/write core behind the Content Calendar grid
 * (04-APPFLOW §8, 07-API-CONTRACT §Content Calendar, 08-AUTH-MATRIX §3–§4).
 *
 *   - getGrid    — every cell for a period (+ the client columns). admin,
 *                  manager and team_member read; freelancer never reaches here
 *                  (route 403s, asserted again below).
 *   - updateCell — the version-checked single-cell write. content_calendar IS
 *                  versioned (C-02), so this goes through optimisticUpdate and
 *                  never a bare UPDATE.
 *
 * THE AUTO-RESET (04-APPFLOW §8 / 07-API-CONTRACT §Content Calendar): any user
 * PATCH sets `source = 'manual'` as part of the SAME UPDATE statement — not a
 * second write. Whatever the cell was (NULL, 'pipeline_trigger', already
 * 'manual'), a human write leaves it 'manual'. Sticky: there is no un-manual
 * path in the MVP. This is what removes the gold trigger dot in the UI, and it
 * is what Trigger 2's guard reads to know a human owns the cell.
 *
 * The frontend NEVER sends `source` — a `source` key in the patch is a 400, so
 * a client cannot forge provenance. (The Zod schema is `.strict()` too; this is
 * the layer-3 backstop.)
 */
import { CALENDAR_STATUSES, CALENDAR_NOTE_MAX, SYSTEM_ACTOR_UUID } from '@skaly/shared';
import { sql, type Kysely, type Selectable } from 'kysely';

import { AuditService } from './AuditService.js';
import { assertPeriodNotLocked, optimisticUpdate, type Executor } from './BaseService.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { softDeletable } from '../lib/queries.js';

import type { CurrentUser } from './AttendanceService.js';
import type { CalendarStatus, ContentCalendar, DB } from '@skaly/shared';

/** The fields a user PATCH may change. `source` and `version` are server-owned. */
export interface CellPatch {
  status?: CalendarStatus;
  note?: string | null;
}

/** One cell in the §Content Calendar wire shape (camelCase at the boundary). */
export interface CalendarCellDTO {
  id: string;
  clientId: string;
  date: string;
  status: string;
  note: string | null;
  source: string | null;
  version: number;
  updatedAt: string | null;
  updatedBy: { staffId: string; name: string | null } | null;
}

/**
 * What Trigger 2 broadcasts — and exactly the API-Contract §6
 * `content-calendar:updated` payload. `null` from applyPostedTrigger means
 * "skipped, do not broadcast".
 */
export interface CalendarTriggerResult {
  clientId: string;
  period: string;
  date: string;
}

export interface CalendarGrid {
  cells: CalendarCellDTO[];
  /** Active, non-internal, non-deleted clients — the column set, in column order. */
  clients: { id: string; name: string }[];
}

/** Raw joined row → wire shape. `date` arrives pre-formatted via to_char. */
interface JoinedCellRow {
  id: string;
  client_id: string;
  date: string;
  status: string;
  note: string | null;
  source: string | null;
  version: number;
  updated_at: Date | string | null;
  updated_by: string | null;
  updated_by_name: string | null;
}

export function cellToDTO(row: JoinedCellRow): CalendarCellDTO {
  return {
    id: row.id,
    clientId: row.client_id,
    date: row.date,
    status: row.status,
    note: row.note,
    source: row.source,
    version: row.version,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : (row.updated_at ?? null),
    updatedBy: row.updated_by ? { staffId: row.updated_by, name: row.updated_by_name } : null,
  };
}

export class ContentCalendarService {
  private readonly audit = new AuditService();

  /**
   * The full grid for `period`: every cell belonging to a currently-visible
   * client column, plus that column set.
   *
   * Membership is decided ONCE (the `clients` query) and the cell query filters
   * on those ids — so a client deactivated after its cells were generated drops
   * out of both together and can never leave orphan cells with no column.
   */
  async getGrid(period: string, currentUser: CurrentUser, trx: Executor): Promise<CalendarGrid> {
    // Layer-3 backstop; the route already 403s freelancers (AUTH-MATRIX §3–§4).
    if (currentUser.role === 'freelancer') {
      throw new AppError('PERMISSION_DENIED', 'Freelancers have no content calendar access.');
    }

    // Column order = alphabetical by client name.
    const clients = await softDeletable(trx.selectFrom('clients').select(['id', 'name']))
      .where('active', '=', true)
      .where('is_internal', '=', false)
      .orderBy('name')
      .execute();

    if (clients.length === 0) return { cells: [], clients: [] };

    // date via to_char so it is a stable 'YYYY-MM-DD' string, not a pg Date.
    // clients is joined only to sort by name — membership comes from the id list.
    const cellRows = await trx
      .selectFrom('content_calendar')
      .innerJoin('clients', 'clients.id', 'content_calendar.client_id')
      .leftJoin('staff', 'staff.id', 'content_calendar.updated_by')
      .select([
        'content_calendar.id',
        'content_calendar.client_id',
        sql<string>`to_char(content_calendar.date, 'YYYY-MM-DD')`.as('date'),
        'content_calendar.status',
        'content_calendar.note',
        'content_calendar.source',
        'content_calendar.version',
        'content_calendar.updated_at',
        'content_calendar.updated_by',
        'staff.name as updated_by_name',
      ])
      .where('content_calendar.period', '=', period)
      .where(
        'content_calendar.client_id',
        'in',
        clients.map((c) => c.id),
      )
      .orderBy('content_calendar.date')
      .orderBy('clients.name')
      .execute();

    return {
      cells: cellRows.map((r) => cellToDTO(r as JoinedCellRow)),
      clients: clients.map((c) => ({ id: c.id, name: c.name })),
    };
  }

  /**
   * Update one calendar cell. admin/manager only (route-gated; asserted here as
   * the third layer). Opens its own transaction so the write and its audit row
   * commit atomically. Returns the full updated cell (07-API-CONTRACT §1.1).
   */
  async updateCell(
    id: string,
    patch: CellPatch,
    currentUser: CurrentUser,
    expectedVersion: number,
    db: Kysely<DB>,
  ): Promise<CalendarCellDTO> {
    this.assertAdminOrManager(currentUser);

    // `source` is server-owned (the auto-reset). Reject rather than ignore, so a
    // client can never believe it set provenance. Runtime check: the typed
    // CellPatch cannot express it, but a route could forward an untrusted body.
    if ('source' in patch) {
      throw new AppError('VALIDATION_ERROR', 'source is managed by the server and cannot be sent.');
    }
    if (patch.status === undefined && patch.note === undefined) {
      throw new AppError('VALIDATION_ERROR', 'Provide at least one of status or note.');
    }
    if (patch.status !== undefined && !CALENDAR_STATUSES.includes(patch.status)) {
      throw new AppError('VALIDATION_ERROR', `Invalid status: ${String(patch.status)}.`, {
        allowed: CALENDAR_STATUSES,
      });
    }
    if (patch.note != null && patch.note.length > CALENDAR_NOTE_MAX) {
      throw new AppError('VALIDATION_ERROR', `note exceeds ${CALENDAR_NOTE_MAX} characters.`, {
        max: CALENDAR_NOTE_MAX,
      });
    }

    const updated = await db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom('content_calendar')
        .select(['period', 'status', 'note', 'source'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (!before) {
        throw new AppError('RESOURCE_NOT_FOUND', `content_calendar row ${id} does not exist.`);
      }

      await assertPeriodNotLocked(before.period, trx); // 423 PERIOD_LOCKED

      // THE AUTO-RESET: source: 'manual' rides along in the SAME statement as the
      // user's change — one UPDATE, one version bump, never a follow-up write.
      const changes: Record<string, unknown> = {
        source: 'manual',
        updated_by: currentUser.staffId,
      };
      if (patch.status !== undefined) changes.status = patch.status;
      if (patch.note !== undefined) changes.note = patch.note;

      // Versioned table → optimisticUpdate only. Throws 409 STALE_DATA carrying
      // { currentVersion, updatedBy } on a version mismatch (C-02).
      const row = await optimisticUpdate('content_calendar', id, expectedVersion, changes, trx);

      await this.audit.log({
        actorId: currentUser.staffId,
        action: 'UPDATE',
        entity: 'content_calendar',
        entityId: id,
        before: { status: before.status, note: before.note, source: before.source },
        after: { status: row.status, note: row.note, source: row.source },
        trx,
      });

      return row;
    });

    return this.rowToDTO(updated, currentUser.staffId, db);
  }

  /**
   * TRIGGER 2 consumer (ADR-013 case 2). `pipeline:posted` → set that client's
   * cell for the posted DATE to Posted/pipeline_trigger. Returns the broadcast
   * payload on a real write, or null when skipped — the caller broadcasts only
   * on non-null. Never throws for expected conditions; a system trigger that
   * throws would take out the listener.
   *
   * Three non-obvious rules, each of which silently kills the trigger if missed:
   *
   *   1. NULL-SAFE GUARD. `source` is nullable and untouched cells are NULL, so
   *      `source != 'manual'` in SQL evaluates to NULL — not TRUE — and would
   *      skip nearly every cell. We load the row and compare in JS, where
   *      `null !== 'manual'` is correctly true. (Same shape as Trigger 1's guard
   *      in ContentDropperService; equivalent to SQL `IS DISTINCT FROM 'manual'`.)
   *   2. PERIOD DERIVED FROM THE DATE, not from the event's `period`. A July
   *      pipeline posted on Aug 2 targets the AUGUST cell; UNIQUE(period,
   *      client_id, date) means the event's period would match nothing.
   *   3. MISSING CELL → NO-OP + WARN, never create. `period` FKs months(period),
   *      so a cell cannot exist for an un-rolled month. A miss means the period
   *      has not rolled over yet, or a mid-month client was never backfilled.
   *
   * Idempotent by short-circuit: a cell already Posted/pipeline_trigger is left
   * alone, so a replayed event cannot inflate `version` (and cannot re-broadcast).
   */
  async applyPostedTrigger(
    clientId: string,
    postedAt: string,
    db: Kysely<DB>,
  ): Promise<CalendarTriggerResult | null> {
    // Rule 2 — postedAt is 'YYYY-MM-DD' (server IST, BaseService.currentIstDate).
    const targetPeriod = postedAt.slice(0, 7);

    // The cell plus its month's lock state in one round trip.
    const cell = await db
      .selectFrom('content_calendar')
      .innerJoin('months', 'months.period', 'content_calendar.period')
      .select([
        'content_calendar.id',
        'content_calendar.status',
        'content_calendar.source',
        'months.locked',
      ])
      .where('content_calendar.client_id', '=', clientId)
      .where('content_calendar.period', '=', targetPeriod)
      // Explicit ::date cast — postedAt is a 'YYYY-MM-DD' string and the column
      // is DATE; never build a JS Date here, that would reintroduce a timezone.
      .where('content_calendar.date', '=', sql<Date>`${postedAt}::date`)
      .executeTakeFirst();

    // Rule 3.
    if (!cell) {
      logger.warn(
        { clientId, postedAt, targetPeriod },
        'Trigger 2: no calendar cell for date — skipping',
      );
      return null;
    }

    // A system trigger must not write through a locked period.
    if (cell.locked) {
      logger.warn({ clientId, postedAt, targetPeriod }, 'Trigger 2: period locked — skipping');
      return null;
    }

    // Rule 1 — a human owns this cell. Must precede the idempotency check, or a
    // manually-Posted cell would fall through to it and read as "already done".
    if (cell.source === 'manual') {
      logger.debug({ clientId, postedAt }, 'Trigger 2: cell is manual — skipping');
      return null;
    }

    if (cell.status === 'Posted' && cell.source === 'pipeline_trigger') {
      logger.debug({ clientId, postedAt }, 'Trigger 2: cell already set — skipping');
      return null;
    }

    const wrote = await db.transaction().execute(async (trx) => {
      // ADR-013 case 2 — same-column system write, version IS bumped. `status` is
      // the column users edit, so a user holding a stale version SHOULD get a 409;
      // that is optimistic locking working, not a false conflict. (Contrast
      // Trigger 1, whose orthogonal write must NOT bump — ADR-012.)
      //
      // The manual guard is repeated here as a WHERE predicate, and this is the
      // copy that is actually authoritative. The JS check above is the early
      // return + the log line; between that SELECT and this UPDATE a user could
      // set the cell to 'manual', and READ COMMITTED would not stop us clobbering
      // it. Re-asserting it in the statement makes the guard atomic. Here it must
      // be SQL, so it must be IS DISTINCT FROM — plain `!= 'manual'` is NULL for
      // the NULL-source cells that are the overwhelming majority.
      const res = await trx
        .updateTable('content_calendar')
        .set({
          status: 'Posted',
          source: 'pipeline_trigger',
          updated_by: SYSTEM_ACTOR_UUID,
          updated_at: sql`now()`,
          version: sql`version + 1`,
        })
        .where('id', '=', cell.id)
        .where(sql<boolean>`source IS DISTINCT FROM 'manual'`)
        .executeTakeFirst();

      if (Number(res.numUpdatedRows) === 0) return false;

      // Automated write → System Actor + changed_by_source 'system' (C-04).
      await this.audit.log({
        actorId: null,
        action: 'UPDATE',
        entity: 'content_calendar',
        entityId: cell.id,
        before: { status: cell.status, source: cell.source },
        after: { status: 'Posted', source: 'pipeline_trigger' },
        trx,
      });
      return true;
    });

    if (!wrote) {
      // Lost the race: the cell went manual between the SELECT and the UPDATE.
      logger.warn({ clientId, postedAt }, 'Trigger 2: cell became manual mid-write — skipping');
      return null;
    }

    return { clientId, period: targetPeriod, date: postedAt };
  }

  /**
   * Re-shape a raw updated row for the wire. The updater is the current user by
   * definition, so their name is the only lookup needed.
   */
  private async rowToDTO(
    row: Selectable<ContentCalendar>,
    actorId: string,
    trx: Executor,
  ): Promise<CalendarCellDTO> {
    const actor = await trx
      .selectFrom('staff')
      .select('name')
      .where('id', '=', actorId)
      .executeTakeFirst();

    return cellToDTO({
      id: row.id,
      client_id: row.client_id,
      // The RETURNING row carries a pg Date; the wire wants 'YYYY-MM-DD'.
      date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date),
      status: row.status,
      note: row.note,
      source: row.source,
      version: row.version,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
      updated_by_name: actor?.name ?? null,
    });
  }

  /** Defensive layer-3 assert — the route already gates (AUTH-MATRIX §3–§4). */
  private assertAdminOrManager(currentUser: CurrentUser): void {
    if (currentUser.role !== 'admin' && currentUser.role !== 'manager') {
      throw new AppError('PERMISSION_DENIED', 'You do not have permission to edit the content calendar.');
    }
  }
}
