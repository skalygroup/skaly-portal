'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { format, parseISO } from 'date-fns';
import { useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';

import { useDropperUiStore } from './dropper-ui-store';
import { applyOptimisticStage, checkSequence, replaceRow } from './stage-actions';
import { STAGES, type PipelineRow, type PipelineStatus, type PipelineUpdatedBy, type Stage } from './types';

import type { MonthItem } from '../attendance/types';
import type { StaffMeResponse } from '@skaly/shared/schemas/auth';

import { api, ApiError } from '@/lib/api';
import { useColumnHighlightStore } from '@/lib/hooks/use-column-highlight';
import { useMonthContext } from '@/lib/hooks/use-month-context';
import { useRealtimeSync } from '@/lib/hooks/use-realtime-sync';
import { handleMutationError } from '@/lib/mutation-errors';

const mono = { fontFamily: 'var(--font-mono)' } as const;

// Derived status → colour token (UIUX §4.3).
const STATUS_TOKEN: Record<PipelineStatus, string> = {
  Awaiting: '--text-muted',
  Editing: '--status-blue',
  Review: '--status-gold',
  Posted: '--status-green',
};

/** Today's IST calendar date as 'YYYY-MM-DD' — string-comparable with the wire dates. */
function todayIstIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function Avatar({ by }: { by: PipelineUpdatedBy }) {
  const initial = (by.name?.trim()?.[0] ?? '?').toUpperCase();
  return by.avatarUrl ? (
    // 20px avatar from a remote URL; not worth the next/image pipeline.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={by.avatarUrl}
      alt={by.name ?? ''}
      title={by.name ?? undefined}
      className="h-5 w-5 rounded-full object-cover"
      style={{ border: '1px solid var(--bg-surface)' }}
    />
  ) : (
    <span
      title={by.name ?? undefined}
      className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold"
      style={{ background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' }}
    >
      {initial}
    </span>
  );
}

function StatusChip({ status }: { status: PipelineStatus }) {
  const color = `var(${STATUS_TOKEN[status]})`;
  return (
    <span
      className="inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    >
      {status}
    </span>
  );
}

/** Row-bottom progress meter (3px gold, width = stagesComplete / 3). */
function ProgressBar({ stagesComplete }: { stagesComplete: number }) {
  return (
    <div
      aria-hidden
      data-testid="progress-track"
      className="absolute inset-x-0 bottom-0 h-[3px]"
      style={{ background: 'var(--border-subtle)' }}
    >
      <div
        data-testid="progress-fill"
        className="h-full transition-[width] duration-300"
        style={{ width: `${(stagesComplete / 3) * 100}%`, background: 'var(--accent-gold)' }}
      />
    </div>
  );
}

function ComingShootCell({ row, today }: { row: PipelineRow; today: string }) {
  // Reconciliation #10: a past coming_shoot_date reads as "no upcoming shoot".
  const upcoming = row.comingShootDate && row.comingShootDate >= today ? row.comingShootDate : null;
  if (!upcoming) {
    return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  }
  const fromTrigger = row.comingShootSource === 'trigger';
  return (
    <span className="inline-flex items-center gap-1 text-xs" style={mono}>
      {fromTrigger ? (
        <span
          aria-label="Set by Shoot Planner"
          title="Set by Shoot Planner"
          data-testid="coming-shoot-trigger"
          style={{ color: 'var(--accent-gold)' }}
        >
          ↑
        </span>
      ) : null}
      <span style={{ color: 'var(--text-secondary)' }}>{format(parseISO(upcoming), 'd MMM yyyy')}</span>
    </span>
  );
}

interface StageCellProps {
  row: PipelineRow;
  stage: Stage;
  field: 'rawReceivedAt' | 'finalsReadyAt' | 'postedAt';
  editable: boolean;
  onMark: (row: PipelineRow, stage: Stage) => void;
  onFocus: () => void;
  onBlur: () => void;
}

/**
 * One stage cell (RAW / Finals / Posted). Self-subscribing to the highlight +
 * UI stores so it re-renders on focus/shake/error WITHOUT rebuilding the parent
 * columns (which would remount this button and swallow the click).
 */
function StageCell({ row, stage, field, editable, onMark, onFocus, onBlur }: StageCellProps) {
  const cellKey = `${row.clientId}:${stage}`;
  const columnActive = useColumnHighlightStore((s) => editable && s.activeColumnId === stage);
  const shaking = useDropperUiStore((s) => s.shake.has(cellKey));
  const hasError = useDropperUiStore((s) => s.error.has(cellKey));
  const ts = row[field];
  const testid = `stage-${stage}-${row.clientId}`;

  const wrap = (children: React.ReactNode) => (
    <div
      className="relative"
      style={
        columnActive
          ? {
              background: 'var(--accent-gold-dim)',
              borderLeft: '1px solid var(--accent-gold-border)',
              borderRight: '1px solid var(--accent-gold-border)',
            }
          : undefined
      }
    >
      {children}
      {hasError ? (
        <span aria-hidden className="absolute right-2 top-2 h-2 w-2 rounded-full" style={{ background: 'var(--status-red)' }} />
      ) : null}
    </div>
  );

  if (ts) {
    return wrap(
      <div
        data-testid={`${testid}-filled`}
        className="m-1 flex min-h-11 items-center justify-between gap-2 rounded px-2 py-1.5"
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
      >
        <span className="text-xs" style={{ ...mono, color: 'var(--text-secondary)' }}>
          {format(parseISO(ts), 'd MMM · HH:mm')}
        </span>
        {/* Row-level updated_by avatar (reconciliation #13) — the row's last editor. */}
        {row.updatedBy ? <Avatar by={row.updatedBy} /> : null}
      </div>,
    );
  }

  if (!editable) {
    return wrap(
      <div
        data-testid={`${testid}-empty`}
        className="m-1 flex min-h-11 items-center justify-center rounded px-2 text-xs"
        style={{ border: '1px dashed var(--border-default)', color: 'var(--text-muted)' }}
      >
        —
      </div>,
    );
  }

  return wrap(
    <button
      type="button"
      data-testid={`${testid}-mark`}
      onClick={() => onMark(row, stage)}
      onFocus={onFocus}
      onBlur={onBlur}
      className={`m-1 flex min-h-11 w-[calc(100%-0.5rem)] items-center justify-center rounded px-2 text-xs focus-visible:outline-none focus-visible:[outline:2px_solid_var(--accent-gold)] ${
        shaking ? '[animation:skShake_0.4s]' : ''
      }`}
      style={{ border: '1px dashed var(--border-default)', color: 'var(--text-muted)' }}
    >
      Click to mark
    </button>,
  );
}

interface ClientCellProps {
  row: PipelineRow;
  canEdit: boolean;
  onDraftChange: (id: string, value: string, original: string) => void;
  onCommit: (id: string, name: string, original: string) => void;
  onRefresh: (clientId: string) => void;
}

/** Sticky client cell: name (inline-editable), status chip, STALE_DATA banner, progress bar. Self-subscribing. */
function ClientCell({ row, canEdit, onDraftChange, onCommit, onRefresh }: ClientCellProps) {
  const editing = useDropperUiStore((s) => s.editingClientId === row.clientId);
  const nameDraft = useDropperUiStore((s) => s.nameDraft);
  const staleName = useDropperUiStore((s) => s.stale[row.clientId] ?? null);
  const startEdit = useDropperUiStore((s) => s.startEdit);
  const stopEdit = useDropperUiStore((s) => s.stopEdit);

  return (
    <div className="relative flex flex-col gap-1 pb-1.5">
      {editing ? (
        <input
          autoFocus
          data-testid={`client-name-input-${row.clientId}`}
          value={nameDraft}
          onChange={(e) => onDraftChange(row.clientId, e.target.value, row.clientName)}
          onBlur={() => onCommit(row.clientId, nameDraft, row.clientName)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommit(row.clientId, nameDraft, row.clientName);
            if (e.key === 'Escape') stopEdit();
          }}
          className="rounded px-1 py-0.5 text-sm font-semibold focus:outline-none"
          style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--accent-gold-border)' }}
        />
      ) : canEdit ? (
        <button
          type="button"
          data-testid={`client-name-${row.clientId}`}
          onClick={() => startEdit(row.clientId, row.clientName)}
          className="w-fit text-left text-sm font-semibold focus-visible:outline-none focus-visible:[outline:2px_solid_var(--accent-gold)]"
          style={{ color: 'var(--text-primary)' }}
        >
          {row.clientName}
        </button>
      ) : (
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{row.clientName}</span>
      )}
      <StatusChip status={row.status} />
      {staleName ? (
        <button
          type="button"
          data-testid={`stale-refresh-${row.clientId}`}
          onClick={() => onRefresh(row.clientId)}
          className="w-fit text-left text-[11px] font-semibold"
          style={{ color: 'var(--status-red)' }}
        >
          Updated by {staleName} — Refresh row →
        </button>
      ) : null}
      <ProgressBar stagesComplete={row.stagesComplete} />
    </div>
  );
}

const columnHelper = createColumnHelper<PipelineRow>();

/**
 * The Content Dropper grid (04-APPFLOW §7, UIUX §10). Seven columns: Client
 * (sticky) · Visit Type · Last Shoot · RAW · Finals · Posted · Coming Shoot.
 * Interactions (admin/manager — the API is the gate): sequence-aware stage
 * marking with a client-side pre-check + shake, optimistic version-locked PATCH
 * (C-02), the STALE_DATA inline "Refresh row" conflict, the Trigger-2 toast on
 * posted, gold column highlight (§4.4), and client-name inline edit with
 * cross-module cache invalidation.
 *
 * The `columns` memo is kept STABLE (deps: canEdit/today + stable callbacks) —
 * transient state (highlight/shake/error/stale/editing) lives in stores read by
 * the cell components, so a focus never rebuilds columns and remounts a button
 * mid-click.
 *
 * Real-time is INVALIDATE-only (ADR-022): the derived status is recomputed server-side
 * (ADR-013) and the payload carries only {clientId, period}, so this event is
 * invalidate-only BY DEFINITION — rule a, not a preference. It also listens for
 * shoot:slot_updated, because Trigger 1 rewrites coming_shoot_date on this grid.
 */
const DROPPER_EVENTS = ['content-dropper:updated', 'shoot:slot_updated'] as const;

export function ContentDropperGrid() {
  const { period } = useMonthContext();
  useRealtimeSync(DROPPER_EVENTS);
  const queryClient = useQueryClient();
  const today = useMemo(() => todayIstIso(), []);
  const gridKey = useMemo(() => ['content-dropper', period] as const, [period]);

  const { data: rows, isPending, isError, error, refetch } = useQuery({
    queryKey: gridKey,
    queryFn: async () => (await api<{ data: PipelineRow[] }>(`/v1/content-dropper?period=${period}`)).data,
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

  // ── Gold column highlight, keyed by stage ('raw'/'finals'/'posted') (§4.4) ──
  const focusedColumnRef = useRef<string | null>(null);
  const focusHandlers = useCallback((col: string) => {
    const store = useColumnHighlightStore.getState;
    return {
      onFocus: () => {
        focusedColumnRef.current = col;
        store().setActiveColumn(col);
      },
      onBlur: () => {
        if (focusedColumnRef.current === col) focusedColumnRef.current = null;
        store().clearColumn(col);
      },
    };
  }, []);

  // §4.4 rule 4: on failure the highlight stays, then clears 1.5s after the toast.
  const failColumn = useCallback((col: string, cellKey: string) => {
    useDropperUiStore.getState().markError(cellKey);
    setTimeout(() => {
      const store = useColumnHighlightStore.getState();
      store.clearPending(col);
      if (store.activeColumnId === col) store.setActiveColumn(null);
      useDropperUiStore.getState().clearError(cellKey);
    }, 1500);
  }, []);

  // ── Stage PATCH mutation (optimistic, version-locked — C-02) ────────────────
  const stageMutation = useMutation({
    mutationFn: async (vars: { row: PipelineRow; stage: Stage }) =>
      (
        await api<{ data: PipelineRow }>(`/v1/content-dropper/${vars.row.id}/stage`, {
          method: 'PATCH',
          body: JSON.stringify({ stage: vars.stage, version: vars.row.version }),
        })
      ).data,
    onMutate: (vars) => {
      useColumnHighlightStore.getState().markPending(vars.stage);
      const snapshot = queryClient.getQueryData<PipelineRow[]>(gridKey);
      queryClient.setQueryData<PipelineRow[]>(gridKey, (old) =>
        old ? applyOptimisticStage(old, vars.row.id, vars.stage) : old,
      );
      return { snapshot };
    },
    onSuccess: (returned, vars) => {
      // Replace with the authoritative row so the NEXT edit sends the fresh version.
      queryClient.setQueryData<PipelineRow[]>(gridKey, (old) => (old ? replaceRow(old, returned) : old));
      if (vars.stage === 'posted') {
        toast.success('Posted! Content Calendar updated automatically.');
      }
      const store = useColumnHighlightStore.getState();
      store.clearPending(vars.stage);
      if (focusedColumnRef.current !== vars.stage) store.clearColumn(vars.stage);
    },
    onError: (err, vars, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(gridKey, ctx.snapshot); // revert
      const res = handleMutationError(err, 'Could not mark the stage. Please try again.');
      if (res.code === 'STALE_DATA') {
        useDropperUiStore.getState().setStale(vars.row.clientId, res.staleData?.updatedBy?.name ?? 'someone else');
      } else if (res.code === 'STAGE_SEQUENCE_VIOLATION') {
        useDropperUiStore.getState().triggerShake(`${vars.row.clientId}:${vars.stage}`);
      }
      failColumn(vars.stage, `${vars.row.clientId}:${vars.stage}`);
    },
  });

  // ── Client-name inline edit (800ms debounce) → cross-module invalidation ────
  const renameMutation = useMutation({
    mutationFn: async (vars: { id: string; name: string }) =>
      api(`/v1/clients/${vars.id}`, { method: 'PATCH', body: JSON.stringify({ name: vars.name }) }),
    onSuccess: () => {
      // Every clientId-keyed query, across modules (prefix match — APPFLOW §7).
      for (const key of ['content-dropper', 'shoot-planner', 'clients', 'attendance', 'staff']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      toast.success('Client name updated — reflected across all modules.');
      useDropperUiStore.getState().stopEdit();
    },
    onError: (err) => handleMutationError(err, 'Could not rename the client.'),
  });

  // ── Stable callbacks (mutate refs keep them stable so columns don't rebuild) ─
  const stageMutateRef = useRef(stageMutation.mutate);
  stageMutateRef.current = stageMutation.mutate;
  const renameMutateRef = useRef(renameMutation.mutate);
  renameMutateRef.current = renameMutation.mutate;
  const renameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sequence pre-check BEFORE the request (APPFLOW §7): shake + toast, no request.
  const markStage = useCallback((row: PipelineRow, stage: Stage) => {
    const check = checkSequence(row, stage);
    if (!check.ok) {
      toast.error(check.message);
      useDropperUiStore.getState().triggerShake(`${row.clientId}:${stage}`);
      return;
    }
    stageMutateRef.current({ row, stage });
  }, []);

  const refreshRow = useCallback(
    (clientId: string) => {
      useDropperUiStore.getState().clearStale(clientId);
      void queryClient.invalidateQueries({ queryKey: gridKey });
    },
    [queryClient, gridKey],
  );

  const onDraftChange = useCallback((id: string, value: string, original: string) => {
    useDropperUiStore.getState().setDraft(value);
    if (renameTimer.current) clearTimeout(renameTimer.current);
    renameTimer.current = setTimeout(() => {
      const trimmed = value.trim();
      if (trimmed && trimmed !== original) renameMutateRef.current({ id, name: trimmed });
    }, 800);
  }, []);

  const commitRename = useCallback((id: string, name: string, original: string) => {
    if (renameTimer.current) clearTimeout(renameTimer.current);
    const trimmed = name.trim();
    if (!trimmed || trimmed === original) {
      useDropperUiStore.getState().stopEdit();
      return;
    }
    renameMutateRef.current({ id, name: trimmed });
  }, []);

  const columns = useMemo(
    () => [
      columnHelper.accessor('clientName', {
        id: 'client',
        header: () => <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Client</span>,
        cell: ({ row }) => (
          <ClientCell
            row={row.original}
            canEdit={!!canEdit}
            onDraftChange={onDraftChange}
            onCommit={commitRename}
            onRefresh={refreshRow}
          />
        ),
      }),
      columnHelper.accessor('visitType', {
        id: 'visitType',
        header: () => <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Visit Type</span>,
        cell: ({ getValue }) => (
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{getValue() ?? '—'}</span>
        ),
      }),
      columnHelper.accessor('lastShootDate', {
        id: 'lastShoot',
        header: () => <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Last Shoot</span>,
        cell: ({ getValue }) => {
          const d = getValue();
          return (
            <span className="text-xs" style={{ ...mono, color: d ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
              {d ? format(parseISO(d), 'd MMM yyyy') : '—'}
            </span>
          );
        },
      }),
      ...STAGES.map((stage) =>
        columnHelper.display({
          id: stage.key,
          header: () => <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{stage.label}</span>,
          cell: ({ row }) => {
            const h = focusHandlers(stage.key);
            return (
              <StageCell
                row={row.original}
                stage={stage.key}
                field={stage.field as 'rawReceivedAt' | 'finalsReadyAt' | 'postedAt'}
                editable={!!canEdit}
                onMark={markStage}
                onFocus={h.onFocus}
                onBlur={h.onBlur}
              />
            );
          },
        }),
      ),
      columnHelper.display({
        id: 'comingShoot',
        header: () => <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Coming Shoot</span>,
        cell: ({ row }) => <ComingShootCell row={row.original} today={today} />,
      }),
    ],
    [canEdit, today, markStage, refreshRow, onDraftChange, commitRename, focusHandlers],
  );

  const table = useReactTable({ data: rows ?? [], columns, getCoreRowModel: getCoreRowModel() });

  if (isPending) {
    return <p className="py-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Loading content dropper…</p>;
  }
  if (isError) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm" style={{ color: 'var(--status-red)' }}>
          {error instanceof ApiError && error.code === 'PERMISSION_DENIED'
            ? 'You do not have access to the Content Dropper.'
            : 'Could not load the Content Dropper.'}
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
  if ((rows?.length ?? 0) === 0) {
    return (
      <p className="py-16 text-center text-xl" style={{ fontFamily: 'var(--font-display)', color: 'var(--text-muted)' }}>
        No pipelines yet
      </p>
    );
  }

  const widths = [200, 120, 130, 150, 150, 150, 160];

  return (
    <div>
      {locked ? (
        <div
          className="mb-4 rounded px-4 py-3 text-sm font-semibold"
          role="status"
          style={{ background: 'var(--accent-gold-dim)', border: '1px solid var(--accent-gold-border)', color: 'var(--accent-gold)' }}
        >
          This period is locked. Read-only.
        </div>
      ) : null}

      <div className="overflow-auto rounded-lg" style={{ border: '1px solid var(--border-subtle)', maxHeight: 'calc(100vh - 200px)' }}>
        <table
          role="grid"
          aria-label={`Content dropper for ${month?.label ?? period}`}
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
                      width: widths[colIdx],
                      minWidth: widths[colIdx],
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
              <tr key={row.id} data-testid={`pipeline-row-${row.original.clientId}`}>
                {row.getVisibleCells().map((cell, colIdx) => (
                  <td
                    key={cell.id}
                    role="gridcell"
                    className={colIdx === 0 ? 'sticky left-0 px-3 py-2 align-top' : 'px-3 py-2 align-middle'}
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
    </div>
  );
}
