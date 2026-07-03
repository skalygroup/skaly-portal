/**
 * period-days — the ONE source of truth for "what kind of day is this?".
 *
 * Shared by generatePeriodRows (STEP 3, no holiday awareness) and
 * AttendanceService.backfillCurrentPeriod (STEP 4), so the Sunday/holiday
 * classification is never duplicated.
 *
 * Calendar dates are 'YYYY-MM-DD' strings; the weekday is computed on a
 * UTC-constructed Date — a pure calendar date has exactly one weekday
 * regardless of the host TZ, so this needs no date-fns-tz (which isn't
 * installed; see BaseService.currentIstPeriod).
 */

export type DayType = 'working' | 'sunday' | 'holiday';

/** Every calendar date in `period` ('YYYY-MM') as a 'YYYY-MM-DD' string. */
export function datesInPeriod(period: string): string[] {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7)); // 1-based
  // Day 0 of the next month = the last day of this month.
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => `${period}-${String(i + 1).padStart(2, '0')}`);
}

/** True when the calendar date ('YYYY-MM-DD') falls on a Sunday. */
export function isSunday(date: string): boolean {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)); // 1-based
  const day = Number(date.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0;
}

/**
 * Classify a calendar date. Sundays are checked FIRST and are never holidays —
 * holiday logic only ever touches working days (reconciliation #4), so a holiday
 * that happens to fall on a Sunday leaves the Sunday a Sunday.
 */
export function classifyDay(date: string, activeHolidayDates: Set<string>): DayType {
  if (isSunday(date)) return 'sunday';
  if (activeHolidayDates.has(date)) return 'holiday';
  return 'working';
}

/** The working dates in `period` (excludes Sundays and the given holidays). */
export function workingDatesInPeriod(period: string, activeHolidayDates: Set<string>): string[] {
  return datesInPeriod(period).filter((d) => classifyDay(d, activeHolidayDates) === 'working');
}
