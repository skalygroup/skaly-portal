import { describe, test, expect, afterEach, vi } from 'vitest';

import { periodDates } from './period-dates';

/**
 * A6 — the helper is only worth having if it holds at the edges of a month, which is
 * exactly where the pinned `${PERIOD}-15` fixtures stopped working.
 *
 * The clock is faked to the 1st, the 15th and the 28th, per the patch guide's
 * verification step, rather than trusting whatever day the suite happens to run on.
 */
function atIst(iso: string): void {
  // Midday IST, so the UTC↔IST shift cannot roll the date either way.
  vi.setSystemTime(new Date(`${iso}T06:30:00.000Z`));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('periodDates — derived, never pinned', () => {
  test('on the 1st there is no safePast, and safeFuture is the 2nd', () => {
    vi.useFakeTimers();
    atIst('2026-07-01');
    const d = periodDates('2026-07');
    expect(d.safePast).toBeNull();
    expect(d.safeFuture).toBe('2026-07-02');
    expect(d.early).toBe('2026-07-01');
    expect(d.late).toBe('2026-07-31');
  });

  test('mid-month both directions exist', () => {
    vi.useFakeTimers();
    atIst('2026-07-15');
    const d = periodDates('2026-07');
    expect(d.safePast).toBe('2026-07-14');
    expect(d.safeFuture).toBe('2026-07-16');
    // `mid` must not BE today, or a test mutating it collides with today's fixtures.
    expect(d.mid).not.toBe('2026-07-15');
  });

  test('on the LAST day there is no safeFuture — and it returns null rather than lying', () => {
    // The case that matters. A helper that quietly handed back a past date here
    // would reproduce the exact bug it exists to prevent, and the failure would
    // surface as a validation error somewhere unrelated.
    vi.useFakeTimers();
    atIst('2026-07-31');
    const d = periodDates('2026-07');
    expect(d.safeFuture).toBeNull();
    expect(d.safePast).toBe('2026-07-30');
  });

  test('on the 28th of a 31-day month a future date still exists', () => {
    vi.useFakeTimers();
    atIst('2026-07-28');
    expect(periodDates('2026-07').safeFuture).toBe('2026-07-29');
  });

  test('month length is computed, not assumed — February and a leap February', () => {
    vi.useFakeTimers();
    atIst('2026-07-15');
    expect(periodDates('2026-02').late).toBe('2026-02-28');
    expect(periodDates('2024-02').late).toBe('2024-02-29');
    expect(periodDates('2026-04').late).toBe('2026-04-30');
  });

  test('a period that is not the current one has no "today" — every date is past-safe', () => {
    vi.useFakeTimers();
    atIst('2026-07-15');
    const d = periodDates('2026-03');
    expect(d.safePast).toBe('2026-03-01');
    expect(d.safeFuture).toBe('2026-03-31');
    expect(d.all).toHaveLength(31);
  });
});
