'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { format, parseISO } from 'date-fns';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { applyOptimisticCell, buildCellPatch, overlayRect, replaceCell } from './cell-actions';
import { CellPopover } from './cell-popover';
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
import type { CalendarStatus } from '@skaly/shared';
import type { StaffMeResponse } from '@skaly/shared/schemas/auth';

import { CommentTrigger } from '@/components/shared/comment-panel';
import { api, ApiError } from '@/lib/api';
import { useColumnHighlightStore } from '@/lib/hooks/use-column-highlight';
import { useMonthContext } from '@/lib/hooks/use-month-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { handleMutationError } from '@/lib/mutation-errors';

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
  staleName,
  onOpen,
  onRefreshRow,
}: {
  cell: CalendarCell | undefined;
  clientId: string;
  date: string;
  interactive: boolean;
  colIndex: number;
  /** Set after a 409 on this cell — drives the inline conflict (ERROR-HANDLING §5.1). */
  staleName: string | null;
  onOpen: (cell: CalendarCell) => void;
  onRefreshRow: () => void;
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

  // 409 STALE_DATA inline conflict — the message IS the UI, no toast (§5.1).
  if (staleName) {
    return (
      <span
        role="gridcell"
        aria-colindex={colIndex}
        className="flex h-full w-full flex-col justify-center px-1 text-[10px] leading-tight"
      >
        <span style={{ color: 'var(--status-amber)' }}>Updated by {staleName}</span>
        <button
          type="button"
          data-testid={`stale-refresh-${clientId}-${date}`}
          onClick={onRefreshRow}
          className="w-fit text-left font-semibold"
          style={{ color: 'var(--accent-gold)' }}
        >
          Refresh row →
        </button>
      </span>
    );
  }

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
      onClick={() => onOpen(cell)}
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
 * Real-time is LIVE (ADR-022). content-calendar:updated is the matrix's flagship
 * PATCH: the payload is a whole cell including its new `version`, so 50 people on
 * this grid see one edit without 50 refetches. Own-mutation refresh is still the
 * TanStack cache replace in onSuccess — the actor's own echo is excluded, so the two
 * never fight.
 */
const CALENDAR_EVENTS = ['content-calendar:updated', 'client:name_updated'] as const;

export function ContentCalendarGrid() {
  const { period } = useMonthContext();
  const queryClient = useQueryClient();
  const today = useMemo(() => todayIstIso(), []);
  const gridKey = useMemo(() => ['content-calendar', period] as const, [period]);
  /** Which cell's popover is open, as `clientId:date`. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  /** Cells that 409'd, `clientId:date` → the name of whoever won the race. */
  const [stale, setStale] = useState<Record<string, string>>({});
  const todayRowRef = useRef<HTMLDivElement>(null);
  // A plain useRef is enough even though the scroll container mounts only after
  // the query resolves (the loading branch returns before it) — TanStack Virtual
  // v3 picks up a late-arriving scroll element on its own. Verified in-browser:
  // columns cull identically with a ref and with a state-backed callback ref.
  const scrollRef = useRef<HTMLDivElement>(null);

  // `me` is resolved BEFORE the grid query: the reducer below needs `me.id` for
  // sender exclusion, and a reducer built from an undefined id would let the actor
  // apply their own echo on the first render after login.
  const { data: me } = useQuery({
    queryKey: ['staff-me'],
    queryFn: async () => api<StaffMeResponse>('/v1/staff/me'),
    staleTime: 5 * 60_000,
  });

  const { data: months } = useQuery({
    queryKey: ['months'],
    queryFn: async () => (await api<{ data: MonthItem[] }>('/v1/months')).data,
    staleTime: 60_000,
  });
  const month = months?.find((m) => m.period === period);
  const locked = month?.locked ?? false;
  const canEdit = (me?.role === 'admin' || me?.role === 'manager') && !locked;
  const readOnlyRole = me?.role === 'team_member';

  /**
   * ADR-025: the reducer below replaces this grid's `useRealtimeSync` call.
   *
   * The patch bodies are MOVED from the SYNC_MATRIX rows, not rewritten, so
   * ADR-022's behaviour carries over unchanged — including sender exclusion, which
   * now lives inside the reducer rather than beside it.
   */
  const applyEvent = useCallback(
    (prev: CalendarGridResponse, e: { name: string; payload: unknown }) => {
      const payload = e.payload as { actorStaffId?: string } & Record<string, unknown>;

      // SENDER EXCLUSION, client half (ADR-022 rule b). The server uses
      // socket.broadcast for socket-originated events, but a REST-originated one has
      // no originating socket to exclude, so the actor receives their own echo.
      // Applying it would double-apply the optimistic update the actor already made,
      // or fight a mutation still in flight.
      if (me?.id && payload.actorStaffId === me.id) return prev;

      if (e.name === 'content-calendar:updated') {
        const cell = payload as unknown as CalendarCell;
        const i = prev.cells.findIndex((c) => c.id === cell.id);
        if (i === -1) return prev;
        const next = prev.cells.slice();
        // ⚠️ The WHOLE cell, version included. Writing the fields and forgetting
        // `version` leaves the cache holding the OLD one, and the receiver's next
        // edit 409s against a value the server already moved past — which presents
        // as a backend bug and is not one (ADR-022 rule a).
        next[i] = { ...next[i], ...cell };
        return { ...prev, cells: next };
      }

      if (e.name === 'client:name_updated') {
        const { clientId, name } = payload as unknown as { clientId: string; name: string };
        return {
          ...prev,
          clients: prev.clients.map((c) => (c.id === clientId ? { ...c, name } : c)),
        };
      }

      return prev;
    },
    [me?.id],
  );

  const { data, isPending, isError, error, refetch } = useRealtimeQuery<CalendarGridResponse>({
    queryKey: gridKey,
    queryFn: async () =>
      (await api<{ data: CalendarGridResponse }>(`/v1/content-calendar?period=${period}`)).data,
    staleTime: 30_000,
    events: CALENDAR_EVENTS,
    applyEvent,
  });

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

  // ── Cell PATCH: optimistic, version-locked (C-02) ───────────────────────────
  const cellMutation = useMutation({
    mutationFn: async (vars: { cell: CalendarCell; change: { status?: CalendarStatus; note?: string | null } }) =>
      (
        await api<{ data: CalendarCell }>(`/v1/content-calendar/${vars.cell.id}`, {
          method: 'PATCH',
          // version from the cached cell; `source` is never sent (server-owned).
          body: JSON.stringify(buildCellPatch(vars.cell, vars.change)),
        })
      ).data,
    onMutate: (vars) => {
      useColumnHighlightStore.getState().markPending(vars.cell.clientId);
      const snapshot = queryClient.getQueryData<CalendarGridResponse>(gridKey);
      queryClient.setQueryData<CalendarGridResponse>(gridKey, (old) =>
        old ? applyOptimisticCell(old, vars.cell.id, vars.change) : old,
      );
      return { snapshot };
    },
    onSuccess: (returned, vars) => {
      // REPLACE, not merge: the returned row carries the new version and the
      // server's source='manual', which is what makes the gold dot disappear.
      queryClient.setQueryData<CalendarGridResponse>(gridKey, (old) => (old ? replaceCell(old, returned) : old));
      const store = useColumnHighlightStore.getState();
      store.clearPending(vars.cell.clientId);
      if (focusedColumnRef.current !== vars.cell.clientId) store.clearColumn(vars.cell.clientId);
    },
    onError: (err, vars, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(gridKey, ctx.snapshot); // revert
      const res = handleMutationError(err, 'Could not update the cell. Please try again.');
      if (res.code === 'STALE_DATA') {
        setStale((s) => ({
          ...s,
          [`${vars.cell.clientId}:${vars.cell.date}`]: res.staleData?.updatedBy?.name ?? 'someone else',
        }));
        setOpenKey(null); // the popover's version is stale; close it
      }
      // §4.4 rule 4: the highlight stays, then clears 1.5s after the toast.
      setTimeout(() => {
        const store = useColumnHighlightStore.getState();
        store.clearPending(vars.cell.clientId);
        if (store.activeColumnId === vars.cell.clientId) store.setActiveColumn(null);
      }, 1500);
    },
  });

  // ── Gold column highlight, keyed by clientId (§4.4) ─────────────────────────
  const focusedColumnRef = useRef<string | null>(null);
  const columnFocusFor = useCallback(
    (clientId: string) => ({
      onFocus: () => {
        focusedColumnRef.current = clientId;
        useColumnHighlightStore.getState().setActiveColumn(clientId);
      },
      onBlur: () => {
        if (focusedColumnRef.current === clientId) focusedColumnRef.current = null;
        useColumnHighlightStore.getState().clearColumn(clientId);
      },
    }),
    [],
  );

  const activeColumnId = useColumnHighlightStore((s) => s.activeColumnId);
  // Read the virtual item's own `start`; null when that column is not rendered.
  const overlay = overlayRect(activeColumnId, clients, virtualColumns);

  const mutateRef = useRef(cellMutation.mutate);
  mutateRef.current = cellMutation.mutate;

  const openCell = useCallback((cell: CalendarCell) => {
    setOpenKey(`${cell.clientId}:${cell.date}`);
    focusedColumnRef.current = cell.clientId;
    useColumnHighlightStore.getState().setActiveColumn(cell.clientId);
  }, []);

  const closePopover = useCallback(() => {
    setOpenKey(null);
    const store = useColumnHighlightStore.getState();
    if (focusedColumnRef.current) store.clearColumn(focusedColumnRef.current);
    focusedColumnRef.current = null;
  }, []);

  const refreshRow = useCallback(() => {
    setStale({});
    void queryClient.invalidateQueries({ queryKey: gridKey });
  }, [queryClient, gridKey]);

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

      {/* Outside-click backdrop for the popover — same approach as the Shoot
          Planner. Sits below the popover (z-50) and above the grid. */}
      {openKey ? (
        <div className="fixed inset-0 z-40" onClick={closePopover} data-testid="popover-backdrop" aria-hidden />
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
          {/* ── Gold column highlight (UIUX §4.4) ──
              ONE absolutely-positioned div inside the scrolling track, never a
              class on the cells: virtualised columns unmount as they leave the
              window and would take a class-based highlight with them. `left`
              comes from the virtual item's own `start` (see overlayRect), and
              when the active column is outside the window the overlay is not
              rendered at all rather than clamped to an edge — a clamped overlay
              would sit over the wrong client. pointer-events:none so it never
              eats a click; below the popover's z-50. */}
          {overlay ? (
            <div
              aria-hidden
              data-testid={`column-highlight-${activeColumnId}`}
              className="absolute"
              style={{
                left: overlay.left,
                width: overlay.width,
                top: 0,
                height: HEADER_HEIGHT + days.length * ROW_HEIGHT,
                background: 'var(--accent-gold-dim)',
                borderLeft: '1px solid var(--accent-gold-border)',
                borderRight: '1px solid var(--accent-gold-border)',
                pointerEvents: 'none',
                zIndex: 20,
              }}
            />
          ) : null}

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
                  {/* Icon only — the header is one virtualised column wide, and
                      the client name has first claim on it. */}
                  <CommentTrigger
                    compact
                    module="content_calendar"
                    recordId={client.id}
                    recordName={client.name}
                    period={period}
                    locked={locked}
                  />
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
                  const key = `${client.id}:${date}`;
                  const cell = cellIndex.get(key);
                  return (
                    <div
                      key={client.id}
                      className="absolute top-0"
                      style={{
                        left: DATE_COL_WIDTH + vc.start,
                        width: vc.size,
                        height: ROW_HEIGHT,
                        // Lift the open cell above its neighbours so the popover
                        // is not clipped by later-painted sibling columns.
                        ...(openKey === key ? { zIndex: 40 } : {}),
                      }}
                    >
                      <CalendarCellView
                        cell={cell}
                        clientId={client.id}
                        date={date}
                        interactive={canEdit}
                        colIndex={vc.index + 2}
                        staleName={stale[key] ?? null}
                        onOpen={openCell}
                        onRefreshRow={refreshRow}
                      />
                      {openKey === key && cell ? (
                        <CellPopover
                          cell={cell}
                          columnFocus={columnFocusFor(client.id)}
                          onClose={closePopover}
                          onPatch={(change) => mutateRef.current({ cell, change })}
                        />
                      ) : null}
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
