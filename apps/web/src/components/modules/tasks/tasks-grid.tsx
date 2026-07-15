'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { format, parseISO } from 'date-fns';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ChevronRight, Paperclip, Plus } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { TaskAttachmentPanel } from './task-attachment-panel';
import { AssigneeCell, ResultEditor, StatusCell, type SaveState } from './task-cells';
import { DependencyBadge, PriorityBadge } from './task-chips';
import { TaskCreatePanel } from './task-create-panel';
import { useTaskGroups } from './use-task-groups';

import type { Task } from './types';
import type { MonthItem } from '../attendance/types';
import type { StaffMeResponse } from '@skaly/shared/schemas/auth';

import { api, ApiError } from '@/lib/api';
import { useColumnHighlightStore } from '@/lib/hooks/use-column-highlight';
import { currentIstPeriod, useMonthContext } from '@/lib/hooks/use-month-context';
import { handleMutationError } from '@/lib/mutation-errors';

const mono = { fontFamily: 'var(--font-mono)' } as const;
const columnHelper = createColumnHelper<Task>();

/** The edit surface threaded down to the cells (Step 7). */
interface EditApi {
  staff: { id: string; name: string }[];
  activeColumnId: string | null;
  saveStates: Record<string, SaveState>;
  shakeIds: Set<string>;
  canEditStatusResult: (t: Task) => boolean;
  canEditAssignees: boolean;
  onStatus: (task: Task, status: string) => void;
  onResultSave: (task: Task, result: string) => void;
  onAssignAdd: (task: Task, staffId: string) => void;
  onAssignRemove: (task: Task, staffId: string) => void;
  onOpenAttachments: (task: Task) => void;
  focusHandlers: (col: string) => { onFocus: () => void; onBlur: () => void };
}

/**
 * Work Allocation grid (APPFLOW §5, UIUX §8). Step 7 makes it interactive: the
 * create panel, optimistic status/result/assignee edits, and the gold column
 * highlight. Tasks are unversioned (ADR-008) — no version is ever sent and there
 * is no stale-conflict UI. Real-time is own-mutation refresh only (ADR-010).
 *
 * TODO(Sprint 10): subscribe to task:changed on /ws/notify → invalidateQueries(['tasks', period]).
 */
export function TasksGrid() {
  const { period } = useMonthContext();
  const queryClient = useQueryClient();
  const gridKey = useMemo(() => ['tasks', period] as const, [period]);

  const { data: tasks, isPending, isError, error, refetch } = useQuery({
    queryKey: gridKey,
    queryFn: async () => (await api<{ data: Task[] }>(`/v1/tasks?period=${period}`)).data,
    staleTime: 30_000,
  });

  const { data: months } = useQuery({
    queryKey: ['months'],
    queryFn: async () => (await api<{ data: MonthItem[] }>('/v1/months')).data,
    staleTime: 60_000,
  });
  const locked = months?.find((m) => m.period === period)?.locked ?? false;

  const { data: me } = useQuery({
    queryKey: ['staff-me'],
    queryFn: async () => api<StaffMeResponse>('/v1/staff/me'),
    staleTime: 5 * 60_000,
  });
  const { data: staff = [] } = useQuery({
    queryKey: ['staff'],
    queryFn: async () => (await api<{ data: { id: string; name: string; role: string }[] }>('/v1/staff')).data,
    staleTime: 5 * 60_000,
  });

  const isManager = me?.role === 'admin' || me?.role === 'manager';
  const canCreate = isManager && !locked;

  // ── Per-cell transient UI state ─────────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [attachTaskId, setAttachTaskId] = useState<string | null>(null);
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [shakeIds, setShakeIds] = useState<Set<string>>(new Set());
  const setSave = useCallback((id: string, s: SaveState) => setSaveStates((p) => ({ ...p, [id]: s })), []);

  const activeColumnId = useColumnHighlightStore((s) => s.activeColumnId);
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

  const replaceRow = useCallback(
    (updated: Task) =>
      queryClient.setQueryData<Task[]>(gridKey, (old) => old?.map((t) => (t.id === updated.id ? updated : t))),
    [queryClient, gridKey],
  );

  // §4.4 rule 4 failure path: highlight holds, then clears 1.5s after the toast.
  const failClear = useCallback((col: string) => {
    setTimeout(() => {
      const store = useColumnHighlightStore.getState();
      store.clearPending(col);
      if (store.activeColumnId === col) store.setActiveColumn(null);
    }, 1500);
  }, []);

  // ── Mutations (all optimistic where the change is instant) ──────────────────
  const statusMutation = useMutation({
    mutationFn: async (vars: { task: Task; status: string }) =>
      (await api<{ data: Task }>(`/v1/tasks/${vars.task.id}`, { method: 'PATCH', body: JSON.stringify({ status: vars.status }) })).data,
    onMutate: (vars) => {
      const store = useColumnHighlightStore.getState();
      store.markPending('status');
      store.setActiveColumn('status');
      const snapshot = queryClient.getQueryData<Task[]>(gridKey);
      queryClient.setQueryData<Task[]>(gridKey, (old) => old?.map((t) => (t.id === vars.task.id ? { ...t, status: vars.status } : t)));
      return { snapshot };
    },
    onSuccess: (updated) => {
      replaceRow(updated);
      const store = useColumnHighlightStore.getState();
      store.clearPending('status');
      if (focusedColumnRef.current !== 'status') store.clearColumn('status');
    },
    onError: (err, vars, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(gridKey, ctx.snapshot); // ADR-008: plain revert, no stale UI
      const res = handleMutationError(err);
      if (res.code === 'DEPENDENCY_UNRESOLVED') {
        setShakeIds((p) => new Set(p).add(vars.task.id));
        setTimeout(() => setShakeIds((p) => { const n = new Set(p); n.delete(vars.task.id); return n; }), 400);
      }
      failClear('status');
    },
  });

  const resultMutation = useMutation({
    mutationFn: async (vars: { task: Task; result: string }) =>
      (await api<{ data: Task }>(`/v1/tasks/${vars.task.id}`, { method: 'PATCH', body: JSON.stringify({ result: vars.result }) })).data,
    onMutate: (vars) => {
      setSave(vars.task.id, 'saving');
      const store = useColumnHighlightStore.getState();
      store.markPending('result');
      store.setActiveColumn('result');
    },
    onSuccess: (updated) => {
      replaceRow(updated);
      setSave(updated.id, 'saved');
      setTimeout(() => setSave(updated.id, undefined), 2000);
      const store = useColumnHighlightStore.getState();
      store.clearPending('result');
      if (focusedColumnRef.current !== 'result') store.clearColumn('result');
    },
    onError: (err, vars) => {
      setSave(vars.task.id, 'error');
      handleMutationError(err);
      failClear('result');
    },
  });

  const assignMutation = useMutation({
    mutationFn: async (vars: { task: Task; staffId: string; add: boolean }) =>
      vars.add
        ? (await api<{ data: Task }>(`/v1/tasks/${vars.task.id}/assignees`, { method: 'POST', body: JSON.stringify({ staffIds: [vars.staffId] }) })).data
        : (await api<{ data: Task }>(`/v1/tasks/${vars.task.id}/assignees/${vars.staffId}`, { method: 'DELETE' })).data,
    onMutate: () => {
      const store = useColumnHighlightStore.getState();
      store.markPending('assignees');
      store.setActiveColumn('assignees');
    },
    onSuccess: (updated) => {
      replaceRow(updated);
      const store = useColumnHighlightStore.getState();
      store.clearPending('assignees');
      if (focusedColumnRef.current !== 'assignees') store.clearColumn('assignees');
    },
    onError: (err) => {
      handleMutationError(err);
      failClear('assignees');
    },
  });

  const canEditStatusResult = useCallback(
    (t: Task) => {
      if (locked || !me) return false;
      if (me.role === 'admin' || me.role === 'manager') return true;
      return me.role === 'team_member' && t.assignees.some((a) => a.id === me.id);
    },
    [locked, me],
  );

  const edit: EditApi = useMemo(
    () => ({
      staff,
      activeColumnId,
      saveStates,
      shakeIds,
      canEditStatusResult,
      canEditAssignees: isManager && !locked,
      onStatus: (task, status) => statusMutation.mutate({ task, status }),
      onResultSave: (task, result) => resultMutation.mutate({ task, result }),
      onAssignAdd: (task, staffId) => assignMutation.mutate({ task, staffId, add: true }),
      onAssignRemove: (task, staffId) => assignMutation.mutate({ task, staffId, add: false }),
      onOpenAttachments: (task) => setAttachTaskId(task.id),
      focusHandlers,
    }),
    [staff, activeColumnId, saveStates, shakeIds, canEditStatusResult, isManager, locked, statusMutation, resultMutation, assignMutation, focusHandlers],
  );

  const groups = useMemo(() => {
    const byDate = new Map<string, Task[]>();
    for (const t of tasks ?? []) {
      const bucket = byDate.get(t.date) ?? [];
      bucket.push(t);
      byDate.set(t.date, bucket);
    }
    return [...byDate.keys()].sort().map((date) => ({ date, tasks: byDate.get(date)! }));
  }, [tasks]);

  if (isPending) {
    return <p className="py-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Loading tasks…</p>;
  }
  if (isError) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm" style={{ color: 'var(--status-red)' }}>
          {error instanceof ApiError && error.code === 'PERMISSION_DENIED' ? 'You do not have access to tasks.' : 'Could not load tasks.'}
        </p>
        <button type="button" onClick={() => void refetch()} className="mt-3 rounded px-4 py-2 text-sm font-semibold" style={{ background: 'var(--bg-elevated)', color: 'var(--accent-gold)' }}>
          Retry
        </button>
      </div>
    );
  }

  const defaultDate = groups[0]?.date ?? (period === currentIstPeriod() ? new Date().toISOString().slice(0, 10) : `${period}-01`);

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}>
          Work Allocation
        </h1>
        {isManager ? (
          <button
            type="button"
            disabled={locked}
            onClick={() => setCreateOpen(true)}
            title={locked ? 'Period is locked' : undefined}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: 'var(--accent-gold)', color: 'var(--bg-base)' }}
          >
            <Plus size={16} /> Add task
          </button>
        ) : null}
      </div>

      {locked ? (
        <div className="mb-4 rounded px-4 py-3 text-sm font-semibold" role="status" style={{ background: 'var(--accent-gold-dim)', border: '1px solid var(--accent-gold-border)', color: 'var(--accent-gold)' }}>
          This period is locked. Read-only.
        </div>
      ) : null}

      {groups.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-3xl font-bold" style={{ fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}>No tasks yet</p>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>Tasks created for this period will appear here, grouped by date.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <TaskGroup key={g.date} date={g.date} tasks={g.tasks} edit={edit} />
          ))}
        </div>
      )}

      {canCreate ? (
        <TaskCreatePanel open={createOpen} onClose={() => setCreateOpen(false)} period={period} defaultDate={defaultDate} tasks={tasks ?? []} />
      ) : null}

      <TaskAttachmentPanel
        open={attachTaskId !== null}
        onClose={() => setAttachTaskId(null)}
        taskId={attachTaskId}
        period={period}
        meId={me?.id}
        canManage={isManager}
      />
    </div>
  );
}

function TaskGroup({ date, tasks, edit }: { date: string; tasks: Task[]; edit: EditApi }) {
  const collapsed = useTaskGroups((s) => s.collapsed[date] ?? false);
  const toggle = useTaskGroups((s) => s.toggle);
  return (
    <section className="overflow-hidden rounded-lg" style={{ border: '1px solid var(--border-subtle)' }}>
      <button type="button" onClick={() => toggle(date)} aria-expanded={!collapsed} className="flex w-full items-center gap-2 px-4 py-2.5 text-left" style={{ background: 'var(--bg-surface)' }}>
        {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        <span className="text-sm font-semibold" style={{ ...mono, color: 'var(--text-primary)' }}>{format(parseISO(date), 'EEE dd MMM')}</span>
        <span className="text-xs" style={{ ...mono, color: 'var(--text-muted)' }}>{tasks.length}</span>
      </button>
      {!collapsed ? <TaskGroupTable tasks={tasks} edit={edit} /> : null}
    </section>
  );
}

function TaskGroupTable({ tasks, edit }: { tasks: Task[]; edit: EditApi }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const columns = useMemo(
    () => [
      columnHelper.accessor('date', { header: 'Date', cell: ({ getValue }) => <span className="text-[13px]" style={{ ...mono, color: 'var(--text-secondary)' }}>{format(parseISO(getValue()), 'dd MMM')}</span> }),
      columnHelper.accessor('clientName', { header: 'Client', cell: ({ getValue }) => <span className="text-sm" style={{ color: getValue() ? 'var(--text-primary)' : 'var(--text-disabled)' }}>{getValue() ?? '—'}</span> }),
      columnHelper.accessor('description', { header: 'Description', cell: ({ getValue }) => <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{getValue()}</span> }),
      columnHelper.display({
        id: 'assignees',
        header: 'Assignees',
        cell: ({ row }) => {
          const fh = edit.focusHandlers('assignees');
          return (
            <AssigneeCell
              task={row.original}
              editable={edit.canEditAssignees}
              active={edit.activeColumnId === 'assignees'}
              staff={edit.staff}
              onAdd={(sid) => edit.onAssignAdd(row.original, sid)}
              onRemove={(sid) => edit.onAssignRemove(row.original, sid)}
              onFocusColumn={fh.onFocus}
              onBlurColumn={fh.onBlur}
            />
          );
        },
      }),
      columnHelper.display({
        id: 'status',
        header: 'Status',
        cell: ({ row }) => {
          const fh = edit.focusHandlers('status');
          return (
            <StatusCell
              task={row.original}
              editable={edit.canEditStatusResult(row.original)}
              active={edit.activeColumnId === 'status'}
              shaking={edit.shakeIds.has(row.original.id)}
              onChange={(s) => edit.onStatus(row.original, s)}
              onFocusColumn={fh.onFocus}
              onBlurColumn={fh.onBlur}
            />
          );
        },
      }),
      columnHelper.accessor('priority', { header: 'Priority', cell: ({ getValue }) => <PriorityBadge priority={getValue()} /> }),
      columnHelper.display({ id: 'dependency', header: 'Dependency', cell: ({ row }) => <DependencyBadge blocked={row.original.dependencyBlocked} description={row.original.dependencyDescription} id={row.original.id} /> }),
      columnHelper.accessor('deadline', { header: 'Deadline', cell: ({ getValue }) => <span className="text-[13px]" style={{ ...mono, color: getValue() ? 'var(--text-secondary)' : 'var(--text-disabled)' }}>{getValue() ? format(parseISO(getValue()!), 'dd MMM') : '—'}</span> }),
      columnHelper.display({
        id: 'files',
        header: 'Files',
        cell: ({ row }) => (
          <button
            type="button"
            onClick={() => edit.onOpenAttachments(row.original)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[13px] hover:opacity-80"
            style={{ ...mono, color: 'var(--text-muted)' }}
            aria-label="Attachments"
          >
            <Paperclip size={13} /> {row.original.attachmentCount}
          </button>
        ),
      }),
    ],
    [edit],
  );

  const table = useReactTable({ data: tasks, columns, getCoreRowModel: getCoreRowModel() });
  const colCount = columns.length;

  return (
    <div className="overflow-x-auto">
      <table role="grid" className="w-full border-separate border-spacing-0">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((header, i) => (
                <th key={header.id} aria-colindex={i + 1} className="px-3 py-2 text-left text-xs font-medium" style={{ background: 'var(--bg-base)', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => {
            const t = row.original;
            const isOpen = expandedId === t.id;
            return (
              <FragmentRow key={row.id} open={isOpen} colCount={colCount} task={t} edit={edit} onToggle={() => setExpandedId((cur) => (cur === t.id ? null : t.id))}>
                {row.getVisibleCells().map((cell, i) => (
                  <td key={cell.id} role="gridcell" aria-colindex={i + 1} className="px-3 py-2.5 align-middle" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </FragmentRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow({ open, colCount, task, edit, onToggle, children }: { open: boolean; colCount: number; task: Task; edit: EditApi; onToggle: () => void; children: React.ReactNode }) {
  const fh = edit.focusHandlers('result');
  return (
    <>
      <tr
        role="row"
        tabIndex={0}
        aria-expanded={open}
        onClick={(e) => {
          // Don't toggle when interacting with an editable control inside the row.
          if ((e.target as HTMLElement).closest('button, select, textarea, [role="listbox"]')) return;
          onToggle();
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
            e.preventDefault();
            onToggle();
          }
        }}
        className="cursor-pointer focus:outline-none"
        style={{ background: open ? 'var(--bg-hover)' : undefined }}
      >
        {children}
      </tr>
      <tr>
        <td colSpan={colCount} className="p-0">
          <AnimatePresence initial={false}>
            {open ? (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} style={{ overflow: 'hidden', background: 'var(--bg-surface)' }}>
                <div className="grid gap-4 px-4 py-4 md:grid-cols-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Remark</p>
                    <p className="text-sm" style={{ color: task.remark ? 'var(--text-primary)' : 'var(--text-disabled)' }}>{task.remark || '—'}</p>
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Result</p>
                    <ResultEditor
                      task={task}
                      editable={edit.canEditStatusResult(task)}
                      active={edit.activeColumnId === 'result'}
                      saveState={edit.saveStates[task.id]}
                      onSave={(r) => edit.onResultSave(task, r)}
                      onFocusColumn={fh.onFocus}
                      onBlurColumn={fh.onBlur}
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Time logs</p>
                    <p className="text-sm italic" style={{ color: 'var(--text-disabled)' }}>coming soon</p>
                  </div>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </td>
      </tr>
    </>
  );
}
