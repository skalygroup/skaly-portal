import type { CalendarStatus } from '@skaly/shared';

/** One cell, exactly the GET /v1/content-calendar wire shape. */
export interface CalendarCell {
  id: string;
  clientId: string;
  date: string; // YYYY-MM-DD
  status: CalendarStatus;
  note: string | null;
  /** 'manual' | 'pipeline_trigger' | null — server-owned, never sent on a PATCH. */
  source: string | null;
  version: number;
  updatedAt: string | null;
  updatedBy: { staffId: string; name: string | null } | null;
}

export interface CalendarClient {
  id: string;
  name: string;
}

export interface CalendarGridResponse {
  cells: CalendarCell[];
  clients: CalendarClient[];
}

/** UIUX §11 geometry. Client columns are min 90px and grow to fill. */
export const DATE_COL_WIDTH = 80;
export const COLUMN_WIDTH = 90;
export const ROW_HEIGHT = 48;
export const HEADER_HEIGHT = 40;

/** Status → colour token (UIUX §4.3). All six, from the shared vocabulary. */
export const STATUS_TOKEN: Record<CalendarStatus, string> = {
  'No Activity': '--status-grey',
  'Under Progress': '--status-blue',
  Ready: '--status-teal',
  Posted: '--status-gold',
  Pending: '--status-amber',
  Rescheduled: '--status-grey',
};

/**
 * Every date in `period` as 'YYYY-MM-DD'. `new Date(y, m, 0)` is the last day of
 * month `m` (1-based), so the count is real — 28/29/30/31, never hardcoded. Built
 * from local-midnight Dates purely to read `getDate()`, so no timezone can shift it.
 */
export function daysInPeriod(period: string): string[] {
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return [];
  const count = new Date(y, m, 0).getDate();
  return Array.from({ length: count }, (_, i) => `${period}-${String(i + 1).padStart(2, '0')}`);
}

/**
 * Index cells by `clientId:date` for O(1) lookup during render. A 31×20 grid is
 * 620 cells; a `.find()` per cell would be 620 linear scans on every scroll tick,
 * which is the single biggest threat to the 60fps bar (NFR §1.4).
 */
export function indexCells(cells: CalendarCell[]): Map<string, CalendarCell> {
  const map = new Map<string, CalendarCell>();
  for (const c of cells) map.set(`${c.clientId}:${c.date}`, c);
  return map;
}

/** Today's IST calendar date as 'YYYY-MM-DD' — string-comparable with wire dates. */
export function todayIstIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
