'use client';

import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { format, parseISO } from 'date-fns';
import { memo, useEffect, useMemo, useRef } from 'react';

import {
  COLUMN_WIDTH,
  DATE_COL_WIDTH,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  STATUS_TOKEN,
  daysInPeriod,
  indexCells,
  todayIstIso,
  type CalendarCell,
  type CalendarGridResponse,
} from './types';

import type { MonthItem } from '../attendance/types';
import type { StaffMeResponse } from '@skaly/shared/schemas/auth';

import { api, ApiError } from '@/lib/api';
import { useMonthContext } from '@/lib/hooks/use-month-context';

const mono = { fontFamily: 'var(--font-mono)' } as const;

/**
 * One status chip. `Posted` cells set by Trigger 2 also carry a 6px gold dot at
 * the chip's top-right (APPFLOW §8) — the visible marker that the Content
 * Dropper wrote this cell, which disappears the moment a human edits it (the
 * server-side source auto-reset).
 */
function StatusChip({ cell }: { cell: CalendarCell }) {
  const color = `var(${STATUS_TOKEN[cell.status]})`;
  const fromTrigger = cell.source === 'pipeline_trigger';
  return (
    <span className="relative inline-flex">
      <span
        className="inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
        style={{
          color,
          background: `color-mix(in srgb, ${color} 15%, transparent)`,
          border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
        }}
      >
        {cell.status}
      </span>
      {fromTrigger ? (
        <span
          aria-label="Auto-updated from Content Dropper"
          title="Auto-updated from Content Dropper"
          data-testid={`trigger-dot-${cell.clientId}-${cell.date}`}
          className="absolute -right-0.5 -top-0.5 rounded-full"
          style={{ width: 6, height: 6, background: 'var(--accent-gold)' }}
        />
      ) : null}
    </span>
  );
}

/**
 * Memoised so a horizontal scroll tick re-renders only the columns that actually
 * entered or left the window — without this every visible cell re-renders on
 * every frame and the 60fps bar (NFR §1.4) is unreachable.
 */
const CalendarCellView = memo(function CalendarCellView({
  cell,
  clientId,
  date,
  interactive,
  colIndex,
}: {
  cell: CalendarCell | undefined;
  clientId: string;
  date: string;
  interactive: boolean;
  colIndex: number;
}) {
  // No cell for this client+date: an un-backfilled client, or a period whose
  // rows were never generated. Render an inert placeholder, never a fake cell.
  if (!cell) {
    return (
      <span
        role="gridcell"
        aria-colindex={colIndex}
        className="flex h-full w-full items-center justify-center text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        —
      </span>
    );
  }

  const inner = (
    <>
      <StatusChip cell={cell} />
      {cell.note ? (
        <span
          aria-label="Has a note"
          title={cell.note}
          data-testid={`note-dot-${clientId}-${date}`}
          className="ml-1 shrink-0 rounded-full"
          style={{ width: 4, height: 4, background: 'var(--text-muted)' }}
        />
      ) : null}
    </>
  );

  const testId = `calendar-cell-${clientId}-${date}`;
  const label = `${cell.status}${cell.note ? ', has a note' : ''}`;

  // A locked period or a read-only role renders inert spans — never a button
  // that looks actionable and then 403s.
  if (!interactive) {
    return (
      <span
        role="gridcell"
        aria-colindex={colIndex}
        aria-label={label}
        data-testid={testId}
        className="flex h-full w-full items-center justify-center gap-0.5 px-1"
      >
        {inner}
      </span>
    );
  }

  return (
    <button
      type="button"
      role="gridcell"
      aria-colindex={colIndex}
      aria-label={label}
      data-testid={testId}
      // 44×44 minimum target: the cell fills the 48px row and its 90px column.
      className="flex h-full w-full items-center justify-center gap-0.5 px-1"
    >
      {inner}
    </button>
  );
});

/**
 * Content Calendar grid (04-APPFLOW §8, UIUX §11). STEP 7 = rendering only:
 * no popover, no mutations, no highlight overlay yet.
 *
 * COLUMN virtualisation, not row (Impl-Plan §10). Clients are the unbounded axis
 * — days are capped at 31 — so rows render normally, which also keeps
 * today-scroll a plain DOM scrollIntoView rather than a virtualizer index seek.
 *
 * Layout: one scroll container holds the sticky 80px date column and an
 * absolutely-positioned virtual track, so the two can never drift out of
 * alignment the way two synchronised scrollers would.
 *
 * TODO(Sprint 10): subscribe to content-calendar:updated on /ws/notify →
 * invalidateQueries(['content-calendar', payload.period]).
 */
export function ContentCalendarGrid() {
  const { period } = useMonthContext();
  const today = useMemo(() => todayIstIso(), []);
  const todayRowRef = useRef<HTMLDivElement>(null);
  // A plain useRef is enough even though the scroll container mounts only after
  // the query resolves (the loading branch returns before it) — TanStack Virtual
  // v3 picks up a late-arriving scroll element on its own. Verified in-browser:
  // columns cull identically with a ref and with a state-backed callback ref.
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['content-calendar', period],
    queryFn: async () =>
      (await api<{ data: CalendarGridResponse }>(`/v1/content-calendar?period=${period}`)).data,
    staleTime: 30_000,
  });

  const { data: months } = useQuery({
    queryKey: ['months'],
    queryFn: async () => (await api<{ data: MonthItem[] }>('/v1/months')).data,
    staleTime: 60_000,
  });
  const month = months?.find((m) => m.period === period);
  const locked = month?.locked ?? false;

  const { data: me } = useQuery({
    queryKey: ['staff-me'],
    queryFn: async () => api<StaffMeResponse>('/v1/staff/me'),
    staleTime: 5 * 60_000,
  });
  const canEdit = (me?.role === 'admin' || me?.role === 'manager') && !locked;
  const readOnlyRole = me?.role === 'team_member';

  const days = useMemo(() => daysInPeriod(period), [period]);
  const clients = useMemo(() => data?.clients ?? [], [data]);
  // O(1) cell lookup — see indexCells. Rebuilt only when the payload changes.
  const cellIndex = useMemo(() => indexCells(data?.cells ?? []), [data]);

  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: clients.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => COLUMN_WIDTH,
    overscan: 3,
  });

  const virtualColumns = colVirtualizer.getVirtualItems();
  const trackWidth = colVirtualizer.getTotalSize();

  // Today into view — a plain DOM scroll, because rows are not virtualised.
  // Runs on `data`, not on mount: on first mount the grid is empty and there is
  // no row to scroll to. `inline: 'nearest'` keeps it from also jumping sideways.
  useEffect(() => {
    if (!data) return;
    todayRowRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [data]);

  if (isPending) {
    return (
      <p className="py-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading content calendar…
      </p>
    );
  }
  if (isError) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm" style={{ color: 'var(--status-red)' }}>
          {error instanceof ApiError && error.code === 'PERMISSION_DENIED'
            ? 'You do not have access to the Content Calendar.'
            : 'Could not load the Content Calendar.'}
        </p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="mt-3 rounded px-4 py-2 text-sm font-semibold"
          style={{ background: 'var(--bg-elevated)', color: 'var(--accent-gold)' }}
        >
          Retry
        </button>
      </div>
    );
  }
  if (clients.length === 0) {
    return (
      <p
        className="py-16 text-center text-xl"
        style={{ fontFamily: 'var(--font-display)', color: 'var(--text-muted)' }}
      >
        No active clients yet
      </p>
    );
  }

  return (
    <div>
      {locked ? (
        <div
          className="mb-4 rounded px-4 py-3 text-sm font-semibold"
          role="status"
          style={{
            background: 'var(--accent-gold-dim)',
            border: '1px solid var(--accent-gold-border)',
            color: 'var(--accent-gold)',
          }}
        >
          This period is locked. Read-only.
        </div>
      ) : null}

      {/* team_member sees the whole grid but cannot interact with it (Impl-Plan
          §10). The API is the real gate — PATCH is 403 for them regardless. */}
      <div
        className="overflow-auto rounded-lg"
        ref={scrollRef}
        style={{
          border: '1px solid var(--border-subtle)',
          maxHeight: 'calc(100vh - 200px)',
          ...(readOnlyRole ? { pointerEvents: 'none' as const } : {}),
        }}
      >
        <div
          role="grid"
          aria-label={`Content calendar for ${month?.label ?? period}`}
          aria-rowcount={days.length}
          aria-colcount={clients.length + 1}
          style={{ width: DATE_COL_WIDTH + trackWidth, position: 'relative' }}
        >
          {/* ── Header ── */}
          <div
            role="row"
            className="sticky top-0"
            style={{
              height: HEADER_HEIGHT,
              zIndex: 30,
              background: 'var(--bg-surface)',
              borderBottom: '1px solid var(--border-default)',
            }}
          >
            <div
              role="columnheader"
              aria-colindex={1}
              className="sticky left-0 flex h-full items-center px-2 text-xs font-semibold"
              style={{
                width: DATE_COL_WIDTH,
                zIndex: 2,
                background: 'var(--bg-surface)',
                color: 'var(--text-secondary)',
              }}
            >
              Date
            </div>
            {virtualColumns.map((vc) => {
              const client = clients[vc.index]!;
              return (
                <div
                  key={client.id}
                  role="columnheader"
                  aria-colindex={vc.index + 2}
                  title={client.name}
                  className="absolute top-0 flex h-full items-center truncate px-2 text-xs font-semibold"
                  style={{
                    left: DATE_COL_WIDTH + vc.start,
                    width: vc.size,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span className="truncate">{client.name}</span>
                </div>
              );
            })}
          </div>

          {/* ── Rows: every day of the period, not virtualised (≤31) ── */}
          {days.map((date, rowIdx) => {
            const isToday = date === today;
            return (
              <div
                key={date}
                role="row"
                aria-rowindex={rowIdx + 1}
                ref={isToday ? todayRowRef : undefined}
                data-testid={`calendar-row-${date}`}
                style={{
                  height: ROW_HEIGHT,
                  position: 'relative',
                  borderBottom: '1px solid var(--border-subtle)',
                  ...(isToday ? { background: 'var(--accent-gold-06)' } : {}),
                }}
              >
                <div
                  role="rowheader"
                  aria-colindex={1}
                  className="sticky left-0 flex h-full flex-col justify-center px-2"
                  style={{
                    width: DATE_COL_WIDTH,
                    zIndex: 2,
                    // The sticky column must be opaque (cells scroll under it),
                    // so the translucent today tint is composited ON TOP of the
                    // surface rather than replacing it — otherwise the gold row
                    // appears to stop at the date column.
                    background: isToday
                      ? 'linear-gradient(var(--accent-gold-06), var(--accent-gold-06)), var(--bg-surface)'
                      : 'var(--bg-surface)',
                    ...mono,
                  }}
                >
                  <span className="text-xs" style={{ color: 'var(--text-primary)' }}>
                    {format(parseISO(date), 'dd MMM')}
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {format(parseISO(date), 'EEE')}
                  </span>
                </div>

                {virtualColumns.map((vc) => {
                  const client = clients[vc.index]!;
                  return (
                    <div
                      key={client.id}
                      className="absolute top-0"
                      style={{ left: DATE_COL_WIDTH + vc.start, width: vc.size, height: ROW_HEIGHT }}
                    >
                      <CalendarCellView
                        cell={cellIndex.get(`${client.id}:${date}`)}
                        clientId={client.id}
                        date={date}
                        interactive={canEdit}
                        colIndex={vc.index + 2}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Outside the pointer-events:none container on purpose — Impl-Plan §10
          says a team_member's comment box stays interactive. Comments are a
          later sprint, so this is a labelled placeholder, not a build. */}
      <div
        className="mt-4 rounded px-4 py-3 text-sm"
        style={{
          border: '1px dashed var(--border-subtle)',
          color: 'var(--text-muted)',
        }}
      >
        Comments — coming soon
      </div>
    </div>
  );
}
