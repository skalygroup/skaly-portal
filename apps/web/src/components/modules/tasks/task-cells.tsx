'use client';

import { TASK_STATUS_VALUES } from '@skaly/shared';
import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';

import { AssigneeStack, StatusChip } from './task-chips';

import type { Task } from './types';

export type SaveState = 'saving' | 'saved' | 'error' | undefined;

const goldGlow = { boxShadow: '0 0 0 2px var(--accent-gold)', borderRadius: 9999 } as const;

/** Status chip that, when editable, opens a dropdown of the five statuses.
 * Shakes on a DEPENDENCY_UNRESOLVED rejection (Step 7 §2). */
export function StatusCell({
  task,
  editable,
  active,
  shaking,
  onChange,
  onFocusColumn,
  onBlurColumn,
}: {
  task: Task;
  editable: boolean;
  active: boolean;
  shaking: boolean;
  onChange: (status: string) => void;
  onFocusColumn: () => void;
  onBlurColumn: () => void;
}) {
  const [open, setOpen] = useState(false);
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
  active,
  staff,
  onAdd,
  onRemove,
  onFocusColumn,
  onBlurColumn,
}: {
  task: Task;
  editable: boolean;
  active: boolean;
  staff: { id: string; name: string }[];
  onAdd: (staffId: string) => void;
  onRemove: (staffId: string) => void;
  onFocusColumn: () => void;
  onBlurColumn: () => void;
}) {
  const [open, setOpen] = useState(false);
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
  saveState,
  active,
  onSave,
  onFocusColumn,
  onBlurColumn,
}: {
  task: Task;
  editable: boolean;
  saveState: SaveState;
  active: boolean;
  onSave: (result: string) => void;
  onFocusColumn: () => void;
  onBlurColumn: () => void;
}) {
  const [val, setVal] = useState(task.result ?? '');
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
