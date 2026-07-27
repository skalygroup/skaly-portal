/**
 * Fixture dates DERIVED from the period, never pinned to a day number (audit A6).
 *
 * The class is proven, not hypothetical. `AttendanceService`'s backfill test failed
 * during the Sprint 10 close-out because its window (today → end-of-period) no longer
 * contained a seeded holiday once the date rolled past the 15th. A `${PERIOD}-15`
 * fixture is fine for two weeks a month and then silently isn't — which is the worst
 * shape of failure, because the code did not change on the day it started failing.
 *
 * `content-calendar.spec.ts` had already worked this out locally
 * (`TODAY.endsWith('-01') ? -02 : -01`). This is that idea, generalised, so there is
 * one implementation instead of one per spec.
 *
 * ⚠️ Every value here is a real date INSIDE the period. Nothing returns a date in
 * another month, because a period-scoped API rejects those and the resulting failure
 * reads as a permissions or validation bug rather than a fixture bug.
 */
export interface PeriodDates {
  /** First day of the period. */
  early: string;
  /** Mid-period, adjusted so it is never today. */
  mid: string;
  /** Last day of the period. */
  late: string;
  /**
   * A date strictly AFTER today within the period — or `null` near month end, when
   * no such date exists. Callers must handle null rather than receive a lie: a
   * "future" date that is actually in the past is exactly how these fixtures fail.
   */
  safeFuture: string | null;
  /** A date strictly BEFORE today within the period, or `null` on the 1st. */
  safePast: string | null;
  /** Every date in the period, ascending — for callers that want to pick their own. */
  all: string[];
}

/** Today in IST as `YYYY-MM-DD`, matching how the API resolves "today". */
export function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** The current IST period as `YYYY-MM`. */
export function currentIstPeriod(): string {
  return todayIst().slice(0, 7);
}

export function periodDates(period: string = currentIstPeriod()): PeriodDates {
  const [year, month] = period.split('-').map(Number);
  // Day 0 of the NEXT month is the last day of this one — no leap-year special case.
  const lastDay = new Date(Date.UTC(year!, month!, 0)).getUTCDate();

  const day = (n: number) => `${period}-${String(n).padStart(2, '0')}`;
  const all = Array.from({ length: lastDay }, (_, i) => day(i + 1));

  const today = todayIst();
  const isCurrentPeriod = today.startsWith(period);
  const todayDay = isCurrentPeriod ? Number(today.slice(8, 10)) : null;

  // A past period has no "today", so every date in it is safely in the past.
  const safeFuture =
    todayDay === null ? all[all.length - 1]! : todayDay < lastDay ? day(todayDay + 1) : null;
  const safePast = todayDay === null ? all[0]! : todayDay > 1 ? day(todayDay - 1) : null;

  // Mid-period, nudged off today so a test that mutates it cannot collide with
  // whatever "today" fixtures the same run creates.
  const midDay = Math.min(Math.max(Math.floor(lastDay / 2), 1), lastDay);
  const mid = midDay === todayDay ? day(midDay === lastDay ? midDay - 1 : midDay + 1) : day(midDay);

  return { early: all[0]!, mid, late: all[all.length - 1]!, safeFuture, safePast, all };
}
