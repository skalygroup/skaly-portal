'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { format, getWeekOfMonth, parseISO } from 'date-fns';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { applyPatchToSlots, replaceSlot, type SlotPatch } from './slot-actions';
import { SlotPopover } from './slot-popover';

import type { ShootClient, ShootGridData, Slot } from './types';
import type { MonthItem } from '../attendance/types';
import type { StaffMeResponse } from '@skaly/shared/schemas/auth';

import { api, ApiError } from '@/lib/api';
import { useColumnHighlightStore } from '@/lib/hooks/use-column-highlight';
import { useMonthContext } from '@/lib/hooks/use-month-context';
import { INVALIDATE, useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { handleMutationError } from '@/lib/mutation-errors';

const mono = { fontFamily: 'var(--font-mono)' } as const;

// slot_status → colour token (UIUX §4.3: Scheduled blue · Confirmed gold ·
// Completed green · Unset renders no chip).
const STATUS_TOKEN: Record<string, string> = {
  Scheduled: '--status-blue',
  Confirmed: '--status-gold',
  Completed: '--status-green',
};

/** One table row = one client; cells look up `${clientId}:${slotIndex}`. */
interface GridRow {
  client: ShootClient;
}

const columnHelper = createColumnHelper<GridRow>();

/**
 * A filled slot cell: status chip + slot_date (DM Mono) + ×N pieces badge +
 * assigned freelancer, with the week-of-month tag computed at render from
 * slot_date (date-fns — never stored; there is no week_number column).
 */
/**
 * The gold column tint, subscribing to the highlight store itself.
 *
 * Deliberately a component rather than `activeColumnId === colId` inline in the
 * cell renderer: reading the store in the grid put activeColumnId in the
 * column-definition memo, so focusing a cell rebuilt every column and TanStack
 * Table remounted the grid — between the browser's focus event and its click
 * event. The click landed on a detached node and never reached a handler, which
 * is why the grid's first click did nothing. Subscribing here also limits the
 * re-render to the column that actually changed.
 */
function ColumnHighlight({ columnId, children }: { columnId: string; children: ReactNode }) {
  const active = useColumnHighlightStore((s) => s.activeColumnId === columnId);
  return (
    <div
      className="relative"
      style={
        active
          ? {
              background: 'var(--accent-gold-dim)',
              borderLeft: '1px solid var(--accent-gold-border)',
              borderRight: '1px solid var(--accent-gold-border)',
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}

function SlotCellContent({ slot, readOnly }: { slot: Slot; readOnly: boolean }) {
  if (slot.slotStatus === 'Unset') {
    return (
      <div
        className="m-1 flex min-h-11 items-center justify-center rounded px-2 text-xs"
        data-testid="slot-unset"
        style={{ border: '1px dashed var(--border-default)', color: 'var(--text-muted)' }}
      >
        {readOnly ? '—' : 'Click to schedule'}
      </div>
    );
  }

  const color = `var(${STATUS_TOKEN[slot.slotStatus] ?? '--status-grey'})`;
  const date = slot.slotDate ? parseISO(slot.slotDate) : null;
  return (
    <div
      className="m-1 flex min-h-11 flex-col gap-0.5 rounded px-2 py-1.5"
      data-testid={`slot-${slot.slotStatus.toLowerCase()}`}
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap"
          style={{
            color,
            background: `color-mix(in srgb, ${color} 15%, transparent)`,
            border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
          }}
        >
          {slot.slotStatus}
        </span>
        <span className="text-[11px] font-semibold" style={{ ...mono, color: 'var(--text-secondary)' }}>
          ×{slot.piecesExpected}
        </span>
      </div>
      {date ? (
        <div className="flex items-center gap-1.5 text-xs" style={mono}>
          {/* Week-of-month tag, derived from slot_date (Monday weeks). */}
          <span style={{ color: 'var(--accent-gold)' }}>Wk {getWeekOfMonth(date, { weekStartsOn: 1 })}</span>
          <span style={{ color: 'var(--text-secondary)' }}>{format(date, 'EEE d MMM')}</span>
        </div>
      ) : null}
      {slot.freelancerName ? (
        <span className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {slot.freelancerName}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The Shoot Planner grid (04-APPFLOW §6, UIUX §9): client rows × dynamic slot
 * columns; the full slot lifecycle via the popover (admin/manager), reset via
 * the ⋯ menu, gold column highlight keyed by slot_index (§4.4), optimistic
 * updates with NO version (last-write-wins — no STALE_DATA branch exists).
 * Freelancers see only their own rows (API-filtered, ADR-011), read-only.
 *
 * Real-time is INVALIDATE-only (ADR-022), and it invalidates the DROPPER too: Trigger 1
 * recomputes coming_shoot_date on the pipeline when a slot moves (ADR-012), so the
 * dropper goes stale in a way the slot's own fields never describe. Patching the slot
 * and leaving the pipeline alone is exactly the "stale derived data" the ADR forbids.
 */
const SHOOT_EVENTS = ['shoot:slot_updated'] as const;

export function ShootPlannerGrid() {
  const { period } = useMonthContext();
  const queryClient = useQueryClient();
  const gridKey = useMemo(() => ['shoot-planner', period] as const, [period]);

  const { data: grid, isPending, isError, error, refetch } = useRealtimeQuery<ShootGridData>({
    queryKey: gridKey,
    queryFn: async () =>
      (await api<{ data: ShootGridData }>(`/v1/shoot-planner?period=${period}`)).data,
    staleTime: 30_000,
    events: SHOOT_EVENTS,
    // Invalidate-only, unchanged from ADR-022: Trigger 1 recomputes
    // coming_shoot_date on the PIPELINE when a slot moves, so the grid goes stale
    // in a way the slot's own fields do not describe (ADR-012).
    applyEvent: () => INVALIDATE,
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

  // Freelancer dropdown options — only fetched for editors.
  const { data: staff = [] } = useQuery({
    queryKey: ['staff'],
    queryFn: async () =>
      (await api<{ data: { id: string; name: string; role: string }[] }>('/v1/staff')).data,
    staleTime: 5 * 60_000,
    enabled: canEdit,
  });
  const freelancers = useMemo(() => staff.filter((s) => s.role === 'freelancer'), [staff]);

  // ── Transient UI state ──────────────────────────────────────────────────────
  const [openSlotId, setOpenSlotId] = useState<string | null>(null);
  const [menuSlotId, setMenuSlotId] = useState<string | null>(null);
  const [resetSlot, setResetSlot] = useState<Slot | null>(null);
  const [errorSlotIds, setErrorSlotIds] = useState<Set<string>>(new Set());

  // ── Gold column highlight, keyed by slot_index (UIUX §4.4) ─────────────────
  // activeColumnId is NOT read here — see ColumnHighlight.
  const focusedColumnRef = useRef<string | null>(null);
  const focusHandlers = useCallback((col: string) => {
    const store = useColumnHighlightStore;
    return {
      onFocus: () => {
        focusedColumnRef.current = col;
        store.getState().setActiveColumn(col);
      },
      onBlur: () => {
        if (focusedColumnRef.current === col) focusedColumnRef.current = null;
        store.getState().clearColumn(col);
      },
    };
  }, []);

  // §4.4 rule 4: on failure the highlight stays, then clears 1.5s after the toast.
  const failColumn = useCallback((col: string, slotId: string) => {
    setErrorSlotIds((prev) => new Set(prev).add(slotId));
    setTimeout(() => {
      const store = useColumnHighlightStore.getState();
      store.clearPending(col);
      if (store.activeColumnId === col) store.setActiveColumn(null);
      setErrorSlotIds((prev) => {
        const next = new Set(prev);
        next.delete(slotId);
        return next;
      });
    }, 1500);
  }, []);

  // ── PATCH mutation (schedule / confirm / complete / reschedule) ─────────────
  const patchMutation = useMutation({
    mutationFn: async (vars: { slot: Slot; patch: SlotPatch }) =>
      (
        await api<{ data: Slot }>(`/v1/shoot-planner/${vars.slot.id}`, {
          method: 'PATCH',
          body: JSON.stringify(vars.patch), // no version — slots are unversioned
        })
      ).data,
    onMutate: (vars) => {
      const col = `slot-${vars.slot.slotIndex}`;
      useColumnHighlightStore.getState().markPending(col);
      const snapshot = queryClient.getQueryData<ShootGridData>(gridKey);
      queryClient.setQueryData<ShootGridData>(gridKey, (old) =>
        old ? { ...old, slots: applyPatchToSlots(old.slots, vars.slot.id, vars.patch) } : old,
      );
      return { snapshot };
    },
    onSuccess: (row, vars) => {
      queryClient.setQueryData<ShootGridData>(gridKey, (old) =>
        old ? { ...old, slots: replaceSlot(old.slots, row) } : old,
      );
      if (vars.patch.slotStatus === 'Confirmed') {
        toast.success('Shoot confirmed. Content Dropper updated.');
      }
      const col = `slot-${vars.slot.slotIndex}`;
      const store = useColumnHighlightStore.getState();
      store.clearPending(col);
      if (focusedColumnRef.current !== col) store.clearColumn(col);
      setOpenSlotId(null);
    },
    onError: (err, vars, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(gridKey, ctx.snapshot); // revert
      handleMutationError(err, 'Could not save the slot. Please try again.');
      failColumn(`slot-${vars.slot.slotIndex}`, vars.slot.id);
    },
  });
  const { mutate: patchSlot, isPending: patchPending } = patchMutation;

  // ── Reset mutation (⋯ → dialog → POST reset { confirm: true }) ─────────────
  const resetMutation = useMutation({
    mutationFn: async (slot: Slot) =>
      api(`/v1/shoot-planner/${slot.id}/reset`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: () => {
      setResetSlot(null);
      void queryClient.invalidateQueries({ queryKey: gridKey });
    },
    onError: (err) => {
      setResetSlot(null);
      // SHOOT_RESET_CONFIRMATION_REQUIRED shouldn't happen (the UI always sends
      // confirm: true) — handleMutationError's default branch toasts its message.
      handleMutationError(err, 'Could not reset the slot. Please try again.');
    },
  });

  // ── Row model ───────────────────────────────────────────────────────────────
  const slotMap = useMemo(() => {
    const map = new Map<string, Slot>();
    for (const s of grid?.slots ?? []) map.set(`${s.clientId}:${s.slotIndex}`, s);
    return map;
  }, [grid?.slots]);

  const rows = useMemo<GridRow[]>(
    () => (grid?.clients ?? []).map((client) => ({ client })),
    [grid?.clients],
  );

  const slotColumnCount = useMemo(
    () => Math.max(0, ...(grid?.clients ?? []).map((c) => c.shootSlotsPerMonth)),
    [grid?.clients],
  );

  const columns = useMemo(() => {
    const slotCols = Array.from({ length: slotColumnCount }, (_, i) => {
      const slotIndex = i + 1;
      const colId = `slot-${slotIndex}`;
      return columnHelper.display({
        id: colId,
        header: () => (
          <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
            Slot {slotIndex}
          </span>
        ),
        cell: ({ row }) => {
          const { client } = row.original;
          const slot = slotMap.get(`${client.id}:${slotIndex}`);

          // Structurally absent: the client has fewer slots than the grid (§4.2 N/A).
          if (slotIndex > client.shootSlotsPerMonth) {
            return (
              <div
                aria-hidden
                data-testid="slot-na"
                className="m-1 flex min-h-11 items-center justify-center rounded text-xs"
                style={{
                  background: 'var(--bg-base)',
                  border: '1px dashed var(--border-subtle)',
                  opacity: 0.15,
                  pointerEvents: 'none',
                  cursor: 'not-allowed',
                }}
              >
                —
              </div>
            );
          }
          // Within range but no row — a freelancer's non-owned slot (ADR-011).
          if (!slot) return <div className="min-h-11" />;

          const hasError = errorSlotIds.has(slot.id);
          const editable = canEdit;

          return (
            <ColumnHighlight columnId={colId}>
              {editable ? (
                <button
                  type="button"
                  data-testid={`slot-cell-${client.id}-${slotIndex}`}
                  className="block w-full text-left"
                  onClick={() => {
                    setMenuSlotId(null);
                    setOpenSlotId((cur) => (cur === slot.id ? null : slot.id));
                  }}
                  {...focusHandlers(colId)}
                >
                  <SlotCellContent slot={slot} readOnly={false} />
                </button>
              ) : (
                <SlotCellContent slot={slot} readOnly />
              )}

              {/* §4.4 rule 4: red status dot on a failed save. */}
              {hasError ? (
                <span
                  aria-hidden
                  className="absolute right-2 top-2 h-2 w-2 rounded-full"
                  style={{ background: 'var(--status-red)' }}
                />
              ) : null}

              {/* ⋯ menu — reset lives here (non-Unset slots, editors only). */}
              {editable && slot.slotStatus !== 'Unset' ? (
                <button
                  type="button"
                  aria-label={`Slot ${slotIndex} menu`}
                  data-testid={`slot-menu-${client.id}-${slotIndex}`}
                  className="absolute bottom-1.5 right-2 rounded px-1 text-sm leading-none"
                  style={{ color: 'var(--text-muted)' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenSlotId(null);
                    setMenuSlotId((cur) => (cur === slot.id ? null : slot.id));
                  }}
                >
                  ⋯
                </button>
              ) : null}
              {menuSlotId === slot.id ? (
                <div
                  className="absolute right-0 top-full z-50 mt-1 rounded-lg p-1"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
                >
                  <button
                    type="button"
                    data-testid="slot-reset"
                    className="block w-full rounded px-3 py-2 text-left text-sm whitespace-nowrap"
                    style={{ color: 'var(--status-red)' }}
                    onClick={() => {
                      setMenuSlotId(null);
                      setResetSlot(slot);
                    }}
                  >
                    Reset slot
                  </button>
                </div>
              ) : null}

              {openSlotId === slot.id ? (
                <SlotPopover
                  slot={slot}
                  period={period}
                  piecesDefault={client.piecesPerVisit}
                  freelancers={freelancers}
                  busy={patchPending}
                  columnFocus={focusHandlers(colId)}
                  onPatch={(patch) => patchSlot({ slot, patch })}
                  onClose={() => setOpenSlotId(null)}
                />
              ) : null}
            </ColumnHighlight>
          );
        },
      });
    });

    return [
      columnHelper.display({
        id: 'client',
        header: () => (
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Client
          </span>
        ),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {row.original.client.name}
            </span>
            <span className="text-xs" style={{ ...mono, color: 'var(--text-muted)' }}>
              {row.original.client.shootSlotsPerMonth} slots · ×{row.original.client.piecesPerVisit}/visit
            </span>
          </div>
        ),
      }),
      ...slotCols,
    ];
  }, [
    slotColumnCount,
    slotMap,
    canEdit,
    errorSlotIds,
    openSlotId,
    menuSlotId,
    period,
    freelancers,
    // .mutate + .isPending, never the mutation object: useMutation hands back a
    // NEW result object every render, so `patchMutation` in this list rebuilt the
    // column defs on every single render. TanStack Table then remounts every
    // cell, which discards the state cells hold locally — the grid's first click
    // vanished because the cell it hit had already been replaced.
    patchSlot,
    patchPending,
    focusHandlers,
  ]);

  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });

  // ── Render ──────────────────────────────────────────────────────────────────
  if (isPending) {
    return (
      <p className="py-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading shoot planner…
      </p>
    );
  }
  if (isError) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm" style={{ color: 'var(--status-red)' }}>
          {error instanceof ApiError && error.code === 'PERMISSION_DENIED'
            ? 'You do not have access to the shoot planner.'
            : 'Could not load the shoot planner.'}
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
  if (rows.length === 0) {
    return (
      <p
        className="py-16 text-center text-xl"
        style={{ fontFamily: 'var(--font-display)', color: 'var(--text-muted)' }}
      >
        No shoots scheduled yet
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

      {/* Backdrop: outside-click closes the popover / menu. */}
      {openSlotId ?? menuSlotId ? (
        <div
          aria-hidden
          className="fixed inset-0 z-40"
          onClick={() => {
            setOpenSlotId(null);
            setMenuSlotId(null);
          }}
        />
      ) : null}

      <div
        className="overflow-auto rounded-lg"
        style={{ border: '1px solid var(--border-subtle)', maxHeight: 'calc(100vh - 200px)' }}
      >
        <table
          role="grid"
          aria-label={`Shoot planner for ${month?.label ?? period}`}
          className="w-full border-separate border-spacing-0"
        >
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header, colIdx) => (
                  <th
                    key={header.id}
                    className="sticky top-0 px-3 py-2 text-left"
                    style={{
                      background: 'var(--bg-surface)',
                      borderBottom: '1px solid var(--border-default)',
                      width: colIdx === 0 ? 200 : 160,
                      minWidth: colIdx === 0 ? 200 : 160,
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
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell, colIdx) => (
                  <td
                    key={cell.id}
                    role="gridcell"
                    className={colIdx === 0 ? 'sticky left-0 px-3 py-2' : 'p-0 align-top'}
                    style={{
                      borderBottom: '1px solid var(--border-subtle)',
                      ...(colIdx === 0 ? { background: 'var(--bg-surface)', zIndex: 10 } : {}),
                    }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Reset confirmation dialog (UIUX §4.5 modal pattern). */}
      {resetSlot ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
          onClick={() => setResetSlot(null)}
        >
          <div
            role="alertdialog"
            aria-label="Reset slot"
            data-testid="reset-dialog"
            className="w-96 rounded-lg p-5"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
              Reset this slot?
            </h2>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              The date, pieces, and freelancer will be cleared.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded px-4 py-2 text-sm font-semibold"
                style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}
                onClick={() => setResetSlot(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="reset-confirm"
                disabled={resetMutation.isPending}
                className="rounded px-4 py-2 text-sm font-bold"
                style={{ background: 'var(--status-red)', color: '#fff' }}
                onClick={() => resetMutation.mutate(resetSlot)}
              >
                {resetMutation.isPending ? 'Resetting…' : 'Reset slot'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
