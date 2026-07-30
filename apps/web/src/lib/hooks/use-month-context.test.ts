import { describe, expect, test } from 'vitest';

import { currentIstDate, currentIstPeriod } from './use-month-context';

/**
 * The IST calendar-date helper, and the two bugs it replaced.
 *
 * Both shipped in all three signup forms as
 * `const today = new Date().toISOString().slice(0, 10)` at module scope, and
 * both present identically: the date picker's [Today] button does nothing and
 * its click-outside overlay stays over the form, making the next field
 * unclickable. Its guard is `if (t <= maxDate) pick(t)` — a failed comparison
 * skips the close as well as the pick.
 */
describe('currentIstDate', () => {
  test('⭐ is the IST date, not the UTC one — the 00:00–05:30 IST window', () => {
    // 2026-07-29T19:22Z is 2026-07-30T00:52 IST. `toISOString().slice(0,10)`
    // answers "2026-07-29" here, a day behind the date picker — which compares
    // in local time — so the last selectable day is silently unreachable.
    const justAfterIstMidnight = new Date('2026-07-29T19:22:00.000Z');
    expect(justAfterIstMidnight.toISOString().slice(0, 10)).toBe('2026-07-29');
    expect(currentIstDate(justAfterIstMidnight)).toBe('2026-07-30');
  });

  test('agrees with UTC outside that window', () => {
    // 12:00Z is 17:30 IST the same day — nothing to disagree about.
    expect(currentIstDate(new Date('2026-07-30T12:00:00.000Z'))).toBe('2026-07-30');
  });

  test('rolls over at IST midnight, not UTC midnight', () => {
    // 18:29Z is 23:59 IST — still the 29th.
    expect(currentIstDate(new Date('2026-07-29T18:29:00.000Z'))).toBe('2026-07-29');
    // 18:30Z is 00:00 IST — the 30th.
    expect(currentIstDate(new Date('2026-07-29T18:30:00.000Z'))).toBe('2026-07-30');
  });

  test('zero-pads, so it parses as YYYY-MM-DD', () => {
    expect(currentIstDate(new Date('2026-01-05T12:00:00.000Z'))).toBe('2026-01-05');
    expect(currentIstDate(new Date('2026-12-31T12:00:00.000Z'))).toBe('2026-12-31');
  });

  test('⭐ a fresh call answers a fresh day — the module-scope trap', () => {
    // The second half of the defect: evaluated once at module load, a
    // production `next start` that has been up since yesterday serves a
    // `today` frozen at yesterday, and the dead button reappears at every
    // midnight and never clears until a redeploy. Taking `now` as a parameter
    // is what makes that expressible at all.
    const before = currentIstDate(new Date('2026-07-29T12:00:00.000Z'));
    const after = currentIstDate(new Date('2026-07-30T12:00:00.000Z'));
    expect(before).not.toBe(after);
  });

  test('shares its month with currentIstPeriod', () => {
    // They feed the same screens; a disagreement would put a date outside the
    // period the grid is showing.
    const now = new Date('2026-07-29T19:22:00.000Z');
    expect(currentIstDate(now).startsWith(currentIstPeriod(now))).toBe(true);
  });
});
