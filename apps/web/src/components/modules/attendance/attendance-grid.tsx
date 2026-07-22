'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { format, parseISO } from 'date-fns';
import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { AttendanceCell, type SaveState } from './attendance-cell';

import type { AttendanceGridData, AttendanceLog, MonthItem } from './types';

import { api, ApiError } from '@/lib/api';
import { useColumnHighlightStore } from '@/lib/hooks/use-column-highlight';
import { useMonthContext } from '@/lib/hooks/use-month-context';


/** One table row: a date plus that date's log per staff column. */
interface GridRow {
  date: string;
  holidayName: string | null;
  logs: Record<string, AttendanceLog>;
}

const columnHelper = createColumnHelper<GridRow>();

/**
 * The Staff Attendance grid (04-APPFLOW §4, UIUX §7) — the reference module
 * grid Sprints 4–7 copy. Columns = staff (alphabetical = staffList order),
 * rows = dates. TanStack Table v8, not virtualised (≤31 rows).
 */
export function AttendanceGrid() {
  const { period } = useMonthContext();
  const queryClient = useQueryClient();

  // TODO(Sprint 10): subscribe to attendance:holiday_added/removed on /ws/notify
  // (cross-user live grid refresh + holiday bell notifications land there).
  const gridKey = useMemo(() => ['attendance', period] as const, [period]);

  const {
    data: grid,
    isPending,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: gridKey,
    queryFn: async () =>
      (await api<{ data: AttendanceGridData }>(`/v1/attendance?period=${period}`)).data,
    staleTime: 30_000,
  });

  const { data: months } = useQuery({
    queryKey: ['months'],
    queryFn: async () => (await api<{ data: MonthItem[] }>('/v1/months')).data,
    staleTime: 60_000,
  });
  const month = months?.find((m) => m.period === period);
  const locked = month?.locked ?? false;

  // ── Per-cell UI state ──────────────────────────────────────────────────────
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [staleNames, setStaleNames] = useState<Record<string, string>>({});
  const [expandedCellId, setExpandedCellId] = useState<string | null>(null);

  const setSave = useCallback((logId: string, state: SaveState) => {
    setSaveStates((prev) => ({ ...prev, [logId]: state }));
  }, []);

  // ── Gold column highlight (Amendment 2 / UIUX §4.4) ───────────────────────
  const focusedColumnRef = useRef<string | null>(null);
  const focusHandlers = useCallback((staffId: string) => {
    const store = useColumnHighlightStore;
    return {
      onFocus: () => {
        focusedColumnRef.current = staffId;
        store.getState().setActiveColumn(staffId);
      },
      onBlur: () => {
        if (focusedColumnRef.current === staffId) focusedColumnRef.current = null;
        store.getState().clearColumn(staffId);
      },
    };
  }, []);

  // ── The one PATCH mutation (toggle + work-log both go through it) ─────────
  const patchMutation = useMutation({
    mutationFn: async (vars: { log: AttendanceLog; patch: { present?: boolean; workLog?: string } }) =>
      (
        await api<{ data: AttendanceLog }>(`/v1/attendance/${vars.log.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ ...vars.patch, version: vars.log.version }),
        })
      ).data,
    onMutate: (vars) => {
      const { log, patch } = vars;
      useColumnHighlightStore.getState().markPending(log.staffId);
      setSave(log.id, 'saving');

      // Present toggle is instant/optimistic; the work-log textarea already
      // shows the draft, so it needs no cache flip.
      let snapshot: AttendanceGridData | undefined;
      if (patch.present !== undefined) {
        snapshot = queryClient.getQueryData<AttendanceGridData>(gridKey);
        queryClient.setQueryData<AttendanceGridData>(gridKey, (old) =>
          old
            ? {
                ...old,
                attendanceLogs: old.attendanceLogs.map((l) =>
                  l.id === log.id ? { ...l, present: patch.present! } : l,
                ),
              }
            : old,
        );
      }
      return { snapshot };
    },
    onSuccess: (row, vars) => {
      // Replace the cached row with the returned full row so the NEXT edit
      // sends the fresh version (prevents self-inflicted 409s).
      queryClient.setQueryData<AttendanceGridData>(gridKey, (old) =>
        old
          ? { ...old, attendanceLogs: old.attendanceLogs.map((l) => (l.id === row.id ? row : l)) }
          : old,
      );
      setSave(vars.log.id, undefined);
      const store = useColumnHighlightStore.getState();
      store.clearPending(vars.log.staffId);
      // §4.4 rule 3: fade on success — unless the user is still editing there.
      if (focusedColumnRef.current !== vars.log.staffId) {
        store.clearColumn(vars.log.staffId);
      }
    },
    onError: (err, vars, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(gridKey, ctx.snapshot); // revert
      setSave(vars.log.id, 'error');

      if (err instanceof ApiError && err.code === 'STALE_DATA') {
        const updatedBy = err.details?.updatedBy as { name?: string } | null | undefined;
        setStaleNames((prev) => ({ ...prev, [vars.log.id]: updatedBy?.name ?? 'someone else' }));
        toast.error('This cell was updated by someone else. Refresh the row to continue.');
      } else {
        toast.error(err instanceof ApiError ? err.message : 'Save failed. Please try again.');
      }

      // §4.4 rule 4: highlight stays, dot is red, clears 1.5s after the toast.
      setTimeout(() => {
        const store = useColumnHighlightStore.getState();
        store.clearPending(vars.log.staffId);
        if (store.activeColumnId === vars.log.staffId) store.setActiveColumn(null);
        setSaveStates((prev) =>
          prev[vars.log.id] === 'error' ? { ...prev, [vars.log.id]: undefined } : prev,
        );
      }, 1500);
    },
  });

  // Depend on .mutate, never on the mutation object: useMutation returns a NEW
  // result object on every render, so `[patchMutation]` makes these callbacks —
  // and the column defs built from them — change every render. TanStack Table
  // then treats each render as new columns, the cell components remount, and
  // any state they hold locally is thrown away. That is why the grid's FIRST
  // click did nothing: it landed on a cell that was replaced before it could
  // act. `.mutate` is referentially stable, so the memo actually holds.
  const patch = patchMutation.mutate;
  const togglePresent = useCallback(
    (log: AttendanceLog) => patch({ log, patch: { present: !log.present } }),
    [patch],
  );
  const saveWorkLog = useCallback(
    (log: AttendanceLog, workLog: string) => {
      if (workLog === (log.workLog ?? '')) return; // nothing changed
      patch({ log, patch: { workLog } });
    },
    [patch],
  );
  const refreshRow = useCallback(() => {
    setStaleNames({});
    setSaveStates({});
    void queryClient.invalidateQueries({ queryKey: gridKey });
  }, [queryClient, gridKey]);
  const toggleExpand = useCallback(
    (logId: string) => setExpandedCellId((cur) => (cur === logId ? null : logId)),
    [],
  );

  // ── Row model: rows = dates, cells keyed by staffId ───────────────────────
  const rows = useMemo<GridRow[]>(() => {
    if (!grid) return [];
    const holidayByDate = new Map(grid.holidays.map((h) => [h.date, h.name]));
    const byDate = new Map<string, Record<string, AttendanceLog>>();
    for (const log of grid.attendanceLogs) {
      let bucket = byDate.get(log.date);
      if (!bucket) {
        bucket = {};
        byDate.set(log.date, bucket);
      }
      bucket[log.staffId] = log;
    }
    return [...byDate.keys()].sort().map((date) => ({
      date,
      holidayName: holidayByDate.get(date) ?? null,
      logs: byDate.get(date)!,
    }));
  }, [grid]);

  // Footer: per-column total days present — derived on the client from the
  // fetched rows (derived-not-stored; no extra endpoint).
  const presentTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const log of grid?.attendanceLogs ?? []) {
      if (log.present) totals[log.staffId] = (totals[log.staffId] ?? 0) + 1;
    }
    return totals;
  }, [grid?.attendanceLogs]);

  const editableSet = useMemo(
    () => new Set(grid?.editableStaffIds ?? []),
    [grid?.editableStaffIds],
  );

  const columns = useMemo(() => {
    const staffCols = (grid?.staffList ?? []).map((staff) =>
      columnHelper.display({
        id: staff.id,
        header: () => (
          <div className="flex flex-col items-start">
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {staff.name}
            </span>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {staff.role.replace('_', ' ')}
            </span>
          </div>
        ),
        cell: ({ row }) => {
          const log = row.original.logs[staff.id];
          const handlers = focusHandlers(staff.id);
          return (
            <AttendanceCell
              log={log}
              staffName={staff.name}
              editable={editableSet.has(staff.id)}
              locked={locked}
              holidayName={row.original.holidayName}
              expanded={expandedCellId !== null && log?.id === expandedCellId}
              saveState={log ? saveStates[log.id] : undefined}
              staleName={log ? (staleNames[log.id] ?? null) : null}
              columnId={staff.id}
              onFocus={handlers.onFocus}
              onBlur={handlers.onBlur}
              onTogglePresent={togglePresent}
              onSaveWorkLog={saveWorkLog}
              onToggleExpand={toggleExpand}
              onRefreshRow={refreshRow}
            />
          );
        },
        footer: () => (
          <span className="font-mono text-[13px]" style={{ color: 'var(--accent-gold)' }}>
            {presentTotals[staff.id] ?? 0}
          </span>
        ),
      }),
    );

    return [
      columnHelper.accessor('date', {
        id: 'date',
        header: () => (
          <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
            Date
          </span>
        ),
        cell: ({ getValue }) => (
          <span className="font-mono text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            {format(parseISO(getValue()), 'EEE d')}
          </span>
        ),
        footer: () => (
          <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
            Total present
          </span>
        ),
      }),
      ...staffCols,
    ];
  }, [
    grid?.staffList,
    editableSet,
    locked,
    expandedCellId,
    saveStates,
    staleNames,
    // activeColumnId is deliberately NOT here — the cells subscribe to the
    // highlight store themselves. Listing it rebuilt every column on focus,
    // remounting the grid between focus and click and swallowing the click.
    presentTotals,
    focusHandlers,
    togglePresent,
    saveWorkLog,
    toggleExpand,
    refreshRow,
  ]);

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  // ── Render ─────────────────────────────────────────────────────────────────
  if (isPending) {
    return (
      <p className="py-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading attendance…
      </p>
    );
  }
  if (isError) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm" style={{ color: 'var(--status-red)' }}>
          {error instanceof ApiError && error.code === 'PERMISSION_DENIED'
            ? 'You do not have access to attendance.'
            : 'Could not load attendance.'}
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

      <div
        className="overflow-auto rounded-lg"
        style={{ border: '1px solid var(--border-subtle)', maxHeight: 'calc(100vh - 200px)' }}
      >
        <table role="grid" aria-label={`Attendance for ${month?.label ?? period}`} className="border-separate border-spacing-0">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} aria-rowindex={1}>
                {hg.headers.map((header, colIdx) => (
                  <th
                    key={header.id}
                    aria-colindex={colIdx + 1}
                    className="sticky top-0 px-3 py-2 text-left"
                    style={{
                      background: 'var(--bg-surface)',
                      borderBottom: '1px solid var(--border-default)',
                      width: colIdx === 0 ? 120 : 140,
                      minWidth: colIdx === 0 ? 120 : 140,
                      zIndex: colIdx === 0 ? 30 : 20,
                      ...(colIdx === 0 ? { left: 0, position: 'sticky' } : {}),
                    }}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row, rowIdx) => {
              const rowLogs = Object.values(row.original.logs);
              const expanded =
                expandedCellId !== null && rowLogs.some((l) => l.id === expandedCellId);
              return (
                <tr key={row.id} aria-rowindex={rowIdx + 2} style={{ height: expanded ? 56 : 48 }}>
                  {row.getVisibleCells().map((cell, colIdx) => (
                    <td
                      key={cell.id}
                      role="gridcell"
                      aria-colindex={colIdx + 1}
                      className={colIdx === 0 ? 'sticky left-0 px-3' : 'p-0'}
                      style={{
                        borderBottom: '1px solid var(--border-subtle)',
                        ...(colIdx === 0
                          ? { background: 'var(--bg-surface)', zIndex: 10 }
                          : {}),
                      }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            {table.getFooterGroups().map((fg) => (
              <tr key={fg.id} aria-rowindex={rows.length + 2}>
                {fg.headers.map((footer, colIdx) => (
                  <th
                    key={footer.id}
                    aria-colindex={colIdx + 1}
                    className="sticky bottom-0 px-3 py-2 text-left"
                    style={{
                      background: 'var(--bg-surface)',
                      borderTop: '1px solid var(--border-default)',
                      zIndex: colIdx === 0 ? 30 : 20,
                      ...(colIdx === 0 ? { left: 0, position: 'sticky' } : {}),
                    }}
                  >
                    {flexRender(footer.column.columnDef.footer, footer.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </tfoot>
        </table>
      </div>
    </div>
  );
}
