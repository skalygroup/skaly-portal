import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  applyOptimisticCell,
  buildCellPatch,
  createDebouncer,
  overlayRect,
  replaceCell,
} from './cell-actions';

import type { CalendarCell, CalendarGridResponse } from './types';

function cell(over: Partial<CalendarCell> = {}): CalendarCell {
  return {
    id: 'cell-1',
    clientId: 'c1',
    date: '2026-07-21',
    status: 'No Activity',
    note: null,
    source: null,
    version: 3,
    updatedAt: null,
    updatedBy: null,
    ...over,
  };
}

function grid(cells: CalendarCell[]): CalendarGridResponse {
  return { cells, clients: [{ id: 'c1', name: 'One' }, { id: 'c2', name: 'Two' }] };
}

describe('buildCellPatch', () => {
  test('sends the CACHED version and never a source field', () => {
    const body = buildCellPatch(cell({ version: 7, source: 'pipeline_trigger' }), { status: 'Ready' });

    expect(body).toEqual({ status: 'Ready', version: 7 });
    // The server owns provenance; .strict() would 400 this, and forging it would
    // let a client fake or erase the gold trigger dot.
    expect(body).not.toHaveProperty('source');
  });

  test('carries a null note through (clearing a note is a real edit)', () => {
    expect(buildCellPatch(cell(), { note: null })).toEqual({ note: null, version: 3 });
  });
});

describe('applyOptimisticCell / replaceCell', () => {
  test('optimistic change touches only the target cell', () => {
    const g = grid([cell({ id: 'a' }), cell({ id: 'b', clientId: 'c2' })]);
    const next = applyOptimisticCell(g, 'a', { status: 'Ready' });

    expect(next.cells[0]!.status).toBe('Ready');
    expect(next.cells[1]!.status).toBe('No Activity');
    expect(g.cells[0]!.status).toBe('No Activity'); // input not mutated
  });

  test('replaceCell REPLACES rather than merges — the stale source must not survive', () => {
    // The cell was written by Trigger 2; the user has just edited it, so the
    // server reset source to 'manual' and bumped version.
    const g = grid([cell({ id: 'a', source: 'pipeline_trigger', version: 3, note: 'old' })]);
    const returned = cell({ id: 'a', source: 'manual', version: 4, status: 'Ready', note: null });

    const next = replaceCell(g, returned);

    // A merge would have kept source='pipeline_trigger' and the gold dot with it.
    expect(next.cells[0]!.source).toBe('manual');
    expect(next.cells[0]!.version).toBe(4);
    expect(next.cells[0]!.note).toBeNull();
    // And the next edit therefore sends version 4, keeping the chain intact.
    expect(buildCellPatch(next.cells[0]!, { status: 'Pending' }).version).toBe(4);
  });
});

describe('overlayRect — the virtualisation-specific highlight rules', () => {
  const clients = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }];
  // Deliberately NOT index × 90: a uniform stride would hide an index-based bug.
  const virtualColumns = [
    { index: 1, start: 90, size: 90 },
    { index: 2, start: 180, size: 120 },
  ];

  test('reads the virtual item’s own start and size, not index × width', () => {
    // c3 is index 2 → start 180, size 120. index × 90 would give 180 too, so
    // assert the SIZE as well, which only the virtual item can supply.
    expect(overlayRect('c3', clients, virtualColumns)).toEqual({ left: 80 + 180, width: 120 });
    expect(overlayRect('c2', clients, virtualColumns)).toEqual({ left: 80 + 90, width: 90 });
  });

  test('HIDES when the active column is scrolled out of the virtual window', () => {
    // c1 (index 0) exists but is not rendered — clamping it to the edge would
    // draw the highlight over the wrong client.
    expect(overlayRect('c1', clients, virtualColumns)).toBeNull();
  });

  test('null when nothing is active, or the client is unknown', () => {
    expect(overlayRect(null, clients, virtualColumns)).toBeNull();
    expect(overlayRect('ghost', clients, virtualColumns)).toBeNull();
  });
});

describe('createDebouncer — one PATCH per typing burst', () => {
  afterEach(() => vi.useRealTimers());

  test('a burst of keystrokes fires exactly once, after the delay', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createDebouncer(800);

    for (let i = 0; i < 10; i++) {
      d.schedule(fn);
      vi.advanceTimersByTime(100); // typing faster than the delay
    }
    expect(fn).not.toHaveBeenCalled(); // still mid-burst

    vi.advanceTimersByTime(800);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('two separated bursts fire twice', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createDebouncer(800);

    d.schedule(fn);
    vi.advanceTimersByTime(900);
    d.schedule(fn);
    vi.advanceTimersByTime(900);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('cancel prevents the pending call, and `pending` reports state', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createDebouncer(800);

    d.schedule(fn);
    expect(d.pending).toBe(true); // the popover flushes on close when pending
    d.cancel();
    expect(d.pending).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
  });
});
