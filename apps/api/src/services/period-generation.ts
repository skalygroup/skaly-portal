/**
 * generatePeriodRows — the row-generation core for a single period.
 *
 * The dev seed (database/seeds/002_dev_data.ts) calls it now; the Sprint 12
 * month-rollover will call it inside its own single transaction (hence the
 * `trx` parameter — it composes, never opens its own txn). Writing it ONCE means
 * dev/staging data matches the production shape exactly and the rollover is
 * de-risked in advance (decision #3 / audit M-10).
 *
 * For `period` (a 'YYYY-MM' string) it generates, idempotently — every insert is
 * guarded with ON CONFLICT DO NOTHING on the table's natural unique key, so a
 * double call (seed re-run, or the rollover's own retry) never duplicates:
 *
 *   - attendance_logs   — one row per active, non-deleted staff × each date in
 *                         the month. day_type: Sunday → 'sunday', else 'working'.
 *                         NO holiday awareness (a freshly generated month has no
 *                         holidays; they are applied afterwards via
 *                         HolidayService — this matches the rollover). present:
 *                         false, version: 1.
 *   - content_pipelines — one row per active, non-deleted, NON-internal client.
 *   - shoot_schedules   — slot_index 1..shoot_slots_per_month per non-internal
 *                         client, slot_status 'Unset'. (No version column.)
 *   - content_calendar  — one row per non-internal client × each date,
 *                         status 'No Activity'.
 *
 * Internal clients (is_internal = true) are not client deliverables — they get
 * no pipeline / shoot / calendar rows and are skipped in every client loop.
 *
 * Day classification (Sunday/holiday/working) lives in lib/period-days.ts —
 * the same helper AttendanceService.backfillCurrentPeriod uses, so the logic is
 * never duplicated. A freshly generated month has no holidays, so we classify
 * against an empty holiday set (every non-Sunday is 'working').
 */
import { classifyDay, datesInPeriod } from '../lib/period-days.js';

import type { DB } from '@skaly/shared';
import type { Transaction } from 'kysely';

/** A fresh month has no holidays — they are applied afterwards via HolidayService. */
const NO_HOLIDAYS: ReadonlySet<string> = new Set();

/** The client fields slot generation needs — callers usually have them loaded. */
export interface ShootSlotClient {
  id: string;
  shoot_slots_per_month: number;
  pieces_per_visit: number;
}

/**
 * shoot_schedules rows slot_index 1..shoot_slots_per_month for ONE client,
 * slot_status 'Unset', pieces_expected = pieces_per_visit. Idempotent
 * (ON CONFLICT (period, client_id, slot_index) DO NOTHING) — safe to re-run and
 * safe over a partial set (fills only the gap). Shared by generatePeriodRows,
 * the mid-month client backfill, and adjustSlotCount's increase path.
 * Returns the number of rows actually inserted.
 */
export async function generateShootSlotsForClient(
  client: ShootSlotClient,
  period: string,
  trx: Transaction<DB>,
): Promise<number> {
  const rows = Array.from({ length: client.shoot_slots_per_month }, (_, i) => ({
    period,
    client_id: client.id,
    slot_index: i + 1,
    slot_status: 'Unset',
    pieces_expected: client.pieces_per_visit,
  }));
  const inserted = await trx
    .insertInto('shoot_schedules')
    .values(rows)
    .onConflict((oc) => oc.columns(['period', 'client_id', 'slot_index']).doNothing())
    .returning('id')
    .execute();
  return inserted.length;
}

/**
 * One content_pipelines row for ONE client — all stage timestamps NULL,
 * coming_shoot_source NULL, version 1 (status is derived on read). Idempotent
 * via ON CONFLICT (period, client_id). Returns rows actually inserted.
 */
export async function generatePipelineRowForClient(
  clientId: string,
  period: string,
  trx: Transaction<DB>,
): Promise<number> {
  const inserted = await trx
    .insertInto('content_pipelines')
    .values({ period, client_id: clientId, version: 1 })
    .onConflict((oc) => oc.columns(['period', 'client_id']).doNothing())
    .returning('id')
    .execute();
  return inserted.length;
}

/**
 * content_calendar cells for ONE client — one per calendar day of `period`,
 * status 'No Activity', source NULL, version 1. The day count comes from
 * datesInPeriod (28/29/30/31, never hardcoded). Idempotent via
 * ON CONFLICT (period, client_id, date). Returns rows actually inserted.
 *
 * FULL MONTH, deliberately — not "from today", the way Sprint 3's attendance
 * backfill works. An attendance row asserts a person's working day, so
 * generating one before their start date would state something false; a
 * 'No Activity' calendar cell for a pre-join day is simply true. It also matches
 * Sprint 5's shoot slots (all slot_index 1..N regardless of join date) and keeps
 * the frontend's `clientId:date` Map hole-free, which the grid render depends on.
 */
export async function generateCalendarCellsForClient(
  clientId: string,
  period: string,
  trx: Transaction<DB>,
): Promise<number> {
  const rows = datesInPeriod(period).map((date) => ({
    period,
    client_id: clientId,
    date,
    status: 'No Activity',
    version: 1,
  }));
  const inserted = await trx
    .insertInto('content_calendar')
    .values(rows)
    .onConflict((oc) => oc.columns(['period', 'client_id', 'date']).doNothing())
    .returning('id')
    .execute();
  return inserted.length;
}

export async function generatePeriodRows(period: string, trx: Transaction<DB>): Promise<void> {
  const dates = datesInPeriod(period);

  // ── active, non-deleted staff → the attendance grid ──────────────────────
  const staff = await trx
    .selectFrom('staff')
    .select('id')
    .where('active', '=', true)
    .where('deleted_at', 'is', null)
    .execute();

  if (staff.length > 0) {
    const attendanceRows = staff.flatMap((s) =>
      dates.map((date) => ({
        period,
        staff_id: s.id,
        date,
        day_type: classifyDay(date, NO_HOLIDAYS as Set<string>),
        present: false,
        version: 1,
      })),
    );
    await trx
      .insertInto('attendance_logs')
      .values(attendanceRows)
      .onConflict((oc) => oc.columns(['period', 'staff_id', 'date']).doNothing())
      .execute();
  }

  // ── active, non-deleted, NON-internal clients → pipeline / shoot / calendar ─
  const clients = await trx
    .selectFrom('clients')
    .select(['id', 'shoot_slots_per_month', 'pieces_per_visit'])
    .where('active', '=', true)
    .where('deleted_at', 'is', null)
    .where('is_internal', '=', false)
    .execute();

  if (clients.length === 0) return;

  // pipeline / shoot / calendar all go through the shared per-client generators,
  // which the mid-month backfill also calls — one definition of "what a client's
  // rows are for a period", so the seed, the rollover and the backfill can't drift.
  for (const c of clients) {
    await generatePipelineRowForClient(c.id, period, trx);
    await generateShootSlotsForClient(c, period, trx);
    await generateCalendarCellsForClient(c.id, period, trx);
  }
}

/**
 * Mid-month backfill for ONE client: shoot slots + pipeline row + calendar cells
 * for `period`, in the CALLER's transaction so it commits atomically with the
 * client insert. Idempotent, and a no-op (returns zeroes) for an inactive or
 * internal client — the same guard ShootPlannerService.backfillClientSlots
 * applies, evaluated once here instead of three times.
 *
 * This closes the Sprint 5/6 carried debt: without the calendar cells, a client
 * created mid-period is invisible to Trigger 2 — marking its pipeline Posted
 * hits ContentCalendarService.applyPostedTrigger's missing-cell no-op and the
 * post is silently never recorded on the calendar.
 */
export async function backfillClientPeriodRows(
  clientId: string,
  period: string,
  trx: Transaction<DB>,
): Promise<{ slots: number; pipelines: number; cells: number }> {
  const client = await trx
    .selectFrom('clients')
    .select(['id', 'shoot_slots_per_month', 'pieces_per_visit', 'active', 'is_internal'])
    .where('id', '=', clientId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();

  if (!client || !client.active || client.is_internal) {
    return { slots: 0, pipelines: 0, cells: 0 };
  }

  return {
    slots: await generateShootSlotsForClient(client, period, trx),
    pipelines: await generatePipelineRowForClient(clientId, period, trx),
    cells: await generateCalendarCellsForClient(clientId, period, trx),
  };
}
