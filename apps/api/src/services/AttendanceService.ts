import { sql, type Transaction } from 'kysely';

import type { DB } from '@skaly/shared';

/**
 * Sprint 1 stub — only the slice M-02 needs: backfill attendance for the
 * current period when a staff member is created mid-month. Sprint 3 expands
 * this into the full grid + update logic.
 *
 * NOTE: the schema differs from early design notes. The real tables key on
 * `period` (CHAR(7) 'YYYY-MM', PK of `months`) — there is no period_id /
 * is_current / status / end_date. attendance_logs uses `day_type` + `present`,
 * not a `status` column. This stub is written against the real schema.
 *
 * Dates are handled as UTC calendar dates ('YYYY-MM-DD') to stay deterministic
 * and free of process-timezone drift. Sprint 3 should revisit IST handling.
 */

/** Format a Date as a UTC 'YYYY-MM-DD' calendar date. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Last calendar day of a 'YYYY-MM' period, as a UTC date. */
function lastDayOfPeriod(period: string): Date {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7)); // 1-12
  // Day 0 of the next month (monthIndex === `month`) === last day of this month.
  return new Date(Date.UTC(year, month, 0));
}

/**
 * Every working day from `from` through `to` inclusive, excluding Sundays.
 * Returned as UTC-midnight Date objects. Public holidays are filtered by the
 * caller (it owns the DB lookup).
 */
export function generateWorkingDays(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cursor.getTime() <= end.getTime()) {
    if (cursor.getUTCDay() !== 0) {
      // 0 === Sunday
      days.push(new Date(cursor.getTime()));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export class AttendanceService {
  /**
   * M-02: insert 'working' attendance rows for `staffId` from today through the
   * end of the current period, skipping Sundays and active holidays. Runs in
   * the caller's transaction so it commits/rolls back atomically with the staff
   * insert. Returns the number of rows created.
   */
  async backfillCurrentPeriod(staffId: string, trx: Transaction<DB>): Promise<number> {
    const today = new Date();
    const period = isoDate(today).slice(0, 7); // 'YYYY-MM'

    // The period must exist (attendance_logs.period FKs months.period).
    await trx
      .selectFrom('months')
      .select('period')
      .where('period', '=', period)
      .executeTakeFirstOrThrow();

    const days = generateWorkingDays(today, lastDayOfPeriod(period));

    const holidayRows = await trx
      .selectFrom('holidays')
      .select(sql<string>`to_char(date, 'YYYY-MM-DD')`.as('d'))
      .where('period', '=', period)
      .where('active', '=', true)
      .where('removed_at', 'is', null)
      .execute();
    const holidaySet = new Set(holidayRows.map((h) => h.d));

    const rows = days
      .filter((d) => !holidaySet.has(isoDate(d)))
      .map((d) => ({
        period,
        staff_id: staffId,
        date: isoDate(d),
        day_type: 'working',
        present: false,
        work_log: null,
        version: 1,
      }));

    if (rows.length) {
      await trx.insertInto('attendance_logs').values(rows).execute();
    }
    return rows.length;
  }
}
