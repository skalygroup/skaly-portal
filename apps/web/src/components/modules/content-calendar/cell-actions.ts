import { DATE_COL_WIDTH, type CalendarCell, type CalendarGridResponse } from './types';

import type { CalendarStatus } from '@skaly/shared';

/** What a cell PATCH may carry. `source` is absent BY TYPE — the server owns it. */
export interface CellPatchBody {
  status?: CalendarStatus;
  note?: string | null;
  version: number;
}

/**
 * The request body for one cell edit. `version` always comes from the cached
 * cell so the optimistic-lock chain stays intact (C-02), and `source` is never
 * included — the server flips it to 'manual' itself (the auto-reset). Sending it
 * would be a 400 from the .strict() Zod schema anyway.
 */
export function buildCellPatch(cell: CalendarCell, change: { status?: CalendarStatus; note?: string | null }): CellPatchBody {
  return { ...change, version: cell.version };
}

/** Optimistically apply a change to one cell in the cached grid. */
export function applyOptimisticCell(
  grid: CalendarGridResponse,
  cellId: string,
  change: { status?: CalendarStatus; note?: string | null },
): CalendarGridResponse {
  return {
    ...grid,
    cells: grid.cells.map((c) => (c.id === cellId ? { ...c, ...change } : c)),
  };
}

/**
 * REPLACE (not merge) the cell with the server's row. Merging would keep a stale
 * `source`, so the gold trigger dot would survive an edit that actually reset it
 * to 'manual' — and the next edit would send a stale `version` and 409.
 */
export function replaceCell(grid: CalendarGridResponse, updated: CalendarCell): CalendarGridResponse {
  return {
    ...grid,
    cells: grid.cells.map((c) => (c.id === updated.id ? updated : c)),
  };
}

/** A virtual column, narrowed to what the overlay needs. */
export interface VirtualCol {
  index: number;
  start: number;
  size: number;
}

export interface OverlayRect {
  left: number;
  width: number;
}

/**
 * Where to draw the gold column highlight, or null to hide it.
 *
 * `left` is read from the virtual item's own `start` — never `index × width`,
 * which drifts the moment any column is not exactly the estimated size. When the
 * active column is outside the virtual window it is not in the DOM at all, so
 * the overlay HIDES rather than clamping to an edge and pointing at the wrong
 * client. This is the whole reason the highlight is an overlay here and not the
 * class-based variant every non-virtualised grid uses: recycled columns would
 * take a class-based highlight with them.
 */
export function overlayRect(
  activeClientId: string | null,
  clients: { id: string }[],
  virtualColumns: VirtualCol[],
): OverlayRect | null {
  if (!activeClientId) return null;
  const index = clients.findIndex((c) => c.id === activeClientId);
  if (index === -1) return null;
  const item = virtualColumns.find((v) => v.index === index);
  if (!item) return null; // scrolled out of range — hide, do not clamp
  return { left: DATE_COL_WIDTH + item.start, width: item.size };
}

/**
 * Trailing debounce for the note textarea: one PATCH per typing burst, not one
 * per keystroke (APPFLOW §8 — 800ms). Extracted from the component so the timing
 * is directly testable with fake timers; a PATCH storm across a 620-cell grid is
 * exactly the kind of regression that never shows up in a screenshot.
 */
export function createDebouncer(delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(fn: () => void) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, delayMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get pending() {
      return timer !== null;
    },
  };
}
