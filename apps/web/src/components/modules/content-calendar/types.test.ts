import { CALENDAR_STATUSES } from '@skaly/shared';
import { describe, expect, test } from 'vitest';

import { daysInPeriod, indexCells, STATUS_TOKEN, type CalendarCell } from './types';

function cell(over: Partial<CalendarCell>): CalendarCell {
  return {
    id: 'id',
    clientId: 'c1',
    date: '2026-07-01',
    status: 'No Activity',
    note: null,
    source: null,
    version: 1,
    updatedAt: null,
    updatedBy: null,
    ...over,
  };
}

describe('daysInPeriod — real day counts', () => {
  test.each([
    ['2026-01', 31],
    ['2026-04', 30],
    ['2026-02', 28],
    ['2024-02', 29], // leap — a hardcoded 28 breaks here
    ['2026-12', 31],
  ])('%s has %i days', (period, count) => {
    const days = daysInPeriod(period);
    expect(days).toHaveLength(count);
    expect(days[0]).toBe(`${period}-01`);
    expect(days[count - 1]).toBe(`${period}-${String(count).padStart(2, '0')}`);
  });

  test('every day is zero-padded, so the strings match the wire dates exactly', () => {
    // The cell Map is keyed on these strings — an unpadded '2026-07-1' would
    // silently miss every cell for the first nine days of the month.
    expect(daysInPeriod('2026-07').slice(0, 9)).toEqual([
      '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05',
      '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09',
    ]);
  });

  test('a malformed period yields no rows rather than throwing', () => {
    expect(daysInPeriod('nonsense')).toEqual([]);
  });
});

describe('indexCells — the O(1) lookup the 60fps bar depends on', () => {
  test('keys by clientId:date and round-trips every cell', () => {
    const cells = [
      cell({ id: 'a', clientId: 'c1', date: '2026-07-01' }),
      cell({ id: 'b', clientId: 'c2', date: '2026-07-01' }),
      cell({ id: 'c', clientId: 'c1', date: '2026-07-02' }),
    ];
    const index = indexCells(cells);

    expect(index.size).toBe(3);
    expect(index.get('c1:2026-07-01')?.id).toBe('a');
    expect(index.get('c2:2026-07-01')?.id).toBe('b');
    expect(index.get('c1:2026-07-02')?.id).toBe('c');
    // A gap (un-backfilled client) is a miss, not a throw — the grid renders '—'.
    expect(index.get('c9:2026-07-01')).toBeUndefined();
  });
});

describe('STATUS_TOKEN', () => {
  test('covers all six shared statuses — no status can render with an undefined colour', () => {
    for (const status of CALENDAR_STATUSES) {
      expect(STATUS_TOKEN[status]).toMatch(/^--status-/);
    }
    expect(Object.keys(STATUS_TOKEN)).toHaveLength(CALENDAR_STATUSES.length);
  });
});
