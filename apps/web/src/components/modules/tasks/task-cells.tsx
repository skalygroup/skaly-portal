'use client';

import { TASK_STATUS_VALUES } from '@skaly/shared';
import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';

import { AssigneeStack, StatusChip } from './task-chips';
import { useTaskSaveState, useTaskShaking } from './task-save-state';

import type { SaveState } from './task-save-state';
import type { Task } from './types';

import { useColumnHighlightStore } from '@/lib/hooks/use-column-highlight';

export type { SaveState };

/**
 * Whether this cell's column is the highlighted one, read straight from the store.
 *
 * Deliberately NOT an `active` prop threaded down from the grid: that put
 * `activeColumnId` in the column-definition memo, so focusing a cell rebuilt
 * every column and TanStack Table remounted the grid — between the focus event
 * and the click. The click then landed on a detached element, StatusCell's local
 * `open` state died with the old component, and the dropdown never appeared.
 * The grid's first click did nothing, every time.
 */
function useColumnActive(columnId: string): boolean {
  return useColumnHighlightStore((s) => s.activeColumnId === columnId);
}

const goldGlow = { boxShadow: '0 0 0 2px var(--accent-gold)', borderRadius: 9999 } as const;

/** Status chip that, when editable, opens a dropdown of the five statuses.
 * Shakes on a DEPENDENCY_UNRESOLVED rejection (Step 7 §2). */
export function StatusCell({
  task,
  editable,
  columnId,
  onChange,
  onFocusColumn,
  onBlurColumn,
}: {
  task: Task;
  editable: boolean;
  columnId: string;
  onChange: (status: string) => void;
  onFocusColumn: () => void;
  onBlurColumn: () => void;
}) {
  const [open, setOpen] = useState(false);
  const active = useColumnActive(columnId);
  // From the store, not a prop — a `shaking` prop puts the shake in the column
  // memo, and the remount that follows closes this dropdown mid-click.
  const shaking = useTaskShaking(task.id);
  if (!editable) return <StatusChip status={task.status} />;

  return (
    <div className="relative inline-block">
      <motion.button
        type="button"
        animate={shaking ? { x: [0, -4, 4, -4, 4, 0] } : { x: 0 }}
        transition={{ duration: 0.35 }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
          onFocusColumn();
        }}
        style={active ? goldGlow : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <StatusChip status={task.status} />
      </motion.button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setOpen(false); onBlurColumn(); }} />
          <ul
            role="listbox"
            className="absolute left-0 z-20 mt-1 w-40 overflow-hidden rounded-lg py-1"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
          >
            {TASK_STATUS_VALUES.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    if (s !== task.status) onChange(s);
                  }}
                  className="flex w-full items-center px-3 py-1.5 text-left text-sm hover:opacity-80"
                  style={{ color: 'var(--text-primary)', background: s === task.status ? 'var(--bg-selected)' : undefined }}
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** Avatar stack that, when editable, opens a popover to add/remove assignees. */
export function AssigneeCell({
  task,
  editable,
  columnId,
  staff,
  onAdd,
  onRemove,
  onFocusColumn,
  onBlurColumn,
}: {
  task: Task;
  editable: boolean;
  columnId: string;
  staff: { id: string; name: string }[];
  onAdd: (staffId: string) => void;
  onRemove: (staffId: string) => void;
  onFocusColumn: () => void;
  onBlurColumn: () => void;
}) {
  const [open, setOpen] = useState(false);
  const active = useColumnActive(columnId);
  if (!editable) return <AssigneeStack assignees={task.assignees} />;

  const assigned = new Set(task.assignees.map((a) => a.id));
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); onFocusColumn(); }}
        style={active ? { boxShadow: '0 0 0 2px var(--accent-gold)', borderRadius: 6 } : undefined}
        aria-label="Edit assignees"
      >
        <AssigneeStack assignees={task.assignees} />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setOpen(false); onBlurColumn(); }} />
          <ul
            className="absolute left-0 z-20 mt-1 max-h-56 w-48 overflow-y-auto rounded-lg py-1"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
          >
            {staff.map((s) => {
              const on = assigned.has(s.id);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); if (on) onRemove(s.id); else onAdd(s.id); }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {s.name}
                    <span style={{ color: on ? 'var(--accent-gold)' : 'var(--text-disabled)' }}>{on ? '✓' : '+'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** Debounced (800ms) result editor for the expanded row, with a save-state dot. */
export function ResultEditor({
  task,
  editable,
  columnId,
  onSave,
  onFocusColumn,
  onBlurColumn,
}: {
  task: Task;
  editable: boolean;
  columnId: string;
  onSave: (result: string) => void;
  onFocusColumn: () => void;
  onBlurColumn: () => void;
}) {
  const [val, setVal] = useState(task.result ?? '');
  const active = useColumnActive(columnId);
  // Store, not a prop — same reason as StatusCell's `shaking`.
  const saveState = useTaskSaveState(task.id);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setVal(task.result ?? ''), [task.result]);

  if (!editable) {
    return (
      <p className="text-sm" style={{ color: task.result ? 'var(--text-primary)' : 'var(--text-disabled)' }}>
        {task.result || '—'}
      </p>
    );
  }

  return (
    <div>
      <textarea
        value={val}
        rows={2}
        onFocus={onFocusColumn}
        onBlur={onBlurColumn}
        onChange={(e) => {
          const v = e.target.value;
          setVal(v);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            if (v !== (task.result ?? '')) onSave(v);
          }, 800);
        }}
        className="w-full rounded px-2 py-1.5 text-sm"
        style={{
          background: 'var(--bg-base)',
          color: 'var(--text-primary)',
          border: `1px solid ${active ? 'var(--accent-gold)' : 'var(--border-default)'}`,
        }}
      />
      <SaveDot state={saveState} />
    </div>
  );
}

function SaveDot({ state }: { state: SaveState }) {
  if (!state) return null;
  const map = { saving: '--status-amber', saved: '--status-green', error: '--status-red' } as const;
  const label = { saving: 'Saving…', saved: 'Saved', error: 'Save failed' } as const;
  return (
    <span className="mt-1 inline-flex items-center gap-1 text-[11px]" style={{ color: `var(${map[state]})` }}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: `var(${map[state]})` }} />
      {label[state]}
    </span>
  );
}
