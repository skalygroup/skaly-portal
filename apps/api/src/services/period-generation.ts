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

  // content_pipelines — one per client, mostly nulls (status is derived on read).
  await trx
    .insertInto('content_pipelines')
    .values(clients.map((c) => ({ period, client_id: c.id, version: 1 })))
    .onConflict((oc) => oc.columns(['period', 'client_id']).doNothing())
    .execute();

  // shoot_schedules — slot_index 1..shoot_slots_per_month.
  const shootRows = clients.flatMap((c) =>
    Array.from({ length: c.shoot_slots_per_month }, (_, i) => ({
      period,
      client_id: c.id,
      slot_index: i + 1,
      slot_status: 'Unset',
      pieces_expected: c.pieces_per_visit,
    })),
  );
  await trx
    .insertInto('shoot_schedules')
    .values(shootRows)
    .onConflict((oc) => oc.columns(['period', 'client_id', 'slot_index']).doNothing())
    .execute();

  // content_calendar — one per client × each date.
  const calendarRows = clients.flatMap((c) =>
    dates.map((date) => ({ period, client_id: c.id, date, status: 'No Activity', version: 1 })),
  );
  await trx
    .insertInto('content_calendar')
    .values(calendarRows)
    .onConflict((oc) => oc.columns(['period', 'client_id', 'date']).doNothing())
    .execute();
}
