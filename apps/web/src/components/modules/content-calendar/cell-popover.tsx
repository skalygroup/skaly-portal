'use client';

import { CALENDAR_STATUSES, CALENDAR_NOTE_MAX, type CalendarStatus } from '@skaly/shared';
import { useEffect, useRef, useState } from 'react';

import { createDebouncer } from './cell-actions';

import type { CalendarCell } from './types';

const NOTE_DEBOUNCE_MS = 800;

/**
 * The cell popover (200px, below the cell — APPFLOW §8 / UIUX §11): a status
 * dropdown over the six shared values and a note textarea.
 *
 *   - status change → PATCH immediately
 *   - note          → PATCH 800ms after typing stops (one per burst)
 *   - Esc closes; the grid renders the outside-click backdrop
 *
 * A pending note is flushed on close, so a user who types and clicks away does
 * not silently lose the note.
 *
 * admin/manager only — the grid never mounts this for a read-only viewer, and
 * the API 403s regardless.
 */
export function CellPopover({
  cell,
  onPatch,
  onClose,
  columnFocus,
}: {
  cell: CalendarCell;
  onPatch: (change: { status?: CalendarStatus; note?: string | null }) => void;
  onClose: () => void;
  columnFocus: { onFocus: () => void; onBlur: () => void };
}) {
  const [note, setNote] = useState(cell.note ?? '');
  const debouncer = useRef(createDebouncer(NOTE_DEBOUNCE_MS));
  // Read in cleanup without making the effect depend on the live values.
  const latest = useRef({ note, saved: cell.note ?? '', onPatch });
  latest.current = { note, saved: cell.note ?? '', onPatch };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // On unmount: flush a note the debounce has not yet sent.
  useEffect(() => {
    const d = debouncer.current;
    return () => {
      if (d.pending) {
        d.cancel();
        const { note: n, saved, onPatch: patch } = latest.current;
        if (n !== saved) patch({ note: n || null });
      }
    };
  }, []);

  const onNoteChange = (value: string) => {
    setNote(value);
    debouncer.current.schedule(() => {
      // Re-read at fire time: the cache may have moved under us mid-burst.
      const { note: n, saved, onPatch: patch } = latest.current;
      if (n !== saved) patch({ note: n || null });
    });
  };

  return (
    <div
      data-testid={`cell-popover-${cell.clientId}-${cell.date}`}
      role="dialog"
      aria-label={`Edit ${cell.date}`}
      className="absolute left-0 top-full z-50 mt-1 flex flex-col gap-2 rounded-lg p-3"
      style={{
        width: 200,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
      }}
    >
      <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
        Status
        <select
          data-testid="cell-status"
          value={cell.status}
          onChange={(e) => onPatch({ status: e.target.value as CalendarStatus })}
          {...columnFocus}
          className="rounded px-2 py-1.5 text-sm"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-primary)',
          }}
        >
          {CALENDAR_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
        Note
        <textarea
          data-testid="cell-note"
          value={note}
          rows={3}
          maxLength={CALENDAR_NOTE_MAX}
          onChange={(e) => onNoteChange(e.target.value)}
          {...columnFocus}
          className="resize-none rounded px-2 py-1.5 text-sm"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-primary)',
          }}
        />
      </label>
    </div>
  );
}
