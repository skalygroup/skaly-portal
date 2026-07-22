'use client';

import { NotebookPen, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { WORK_LOG_MAX, type AttendanceLog } from './types';

import { useColumnHighlightStore } from '@/lib/hooks/use-column-highlight';
import { cn } from '@/lib/utils';


export type SaveState = 'saving' | 'error' | undefined;

interface AttendanceCellProps {
  log: AttendanceLog | undefined;
  staffName: string;
  /** Column is in editableStaffIds — CSS-only gating otherwise (UIUX §4.2). */
  editable: boolean;
  /** Period locked → <span> cells, nothing focusable (UIUX §4.2 Locked). */
  locked: boolean;
  /** Holiday name for the tooltip on holiday cells. */
  holidayName: string | null;
  /** This cell's work-log textarea is expanded inline (row grows to 56px). */
  expanded: boolean;
  saveState: SaveState;
  /** Name of the last editor when a 409 STALE_DATA hit this row (§5.1). */
  staleName: string | null;
  /**
   * This cell's column key (the staff id), NOT a resolved boolean.
   *
   * The cell subscribes to the highlight store itself. Passing `columnActive`
   * down put `activeColumnId` in the grid's column-definition memo, so focusing
   * a cell rebuilt every column and TanStack Table remounted the whole grid —
   * between the browser's focus event and the click event. The click then landed
   * on a detached button and no request was ever sent: the grid's first click
   * did nothing, every time. Subscribing here also narrows the re-render to the
   * one column that actually changed.
   */
  columnId: string;
  onFocus: () => void;
  onBlur: () => void;
  onTogglePresent: (log: AttendanceLog) => void;
  onSaveWorkLog: (log: AttendanceLog, workLog: string) => void;
  onToggleExpand: (logId: string) => void;
  onRefreshRow: () => void;
}

/**
 * One grid cell. Variants by day_type (the column is day_type, not status):
 * working = interactive; sunday = greyed; holiday = gold-tinted + tooltip.
 * The real security boundary is the backend 403 — the `editable` dimming is UX.
 */
export function AttendanceCell({
  log,
  staffName,
  editable,
  locked,
  holidayName,
  expanded,
  saveState,
  staleName,
  columnId,
  onFocus,
  onBlur,
  onTogglePresent,
  onSaveWorkLog,
  onToggleExpand,
  onRefreshRow,
}: AttendanceCellProps) {
  // Work-log draft, debounced 800ms after the last keystroke.
  const [draft, setDraft] = useState(log?.workLog ?? '');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Adopt the server value when the cached row is replaced — unless the user is
  // mid-typing in this very textarea.
  useEffect(() => {
    if (document.activeElement !== textareaRef.current) {
      setDraft(log?.workLog ?? '');
    }
  }, [log?.workLog]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const columnActive = useColumnHighlightStore((s) => s.activeColumnId === columnId) && !locked;

  const highlight = columnActive
    ? {
        background: 'var(--accent-gold-dim)',
        borderLeft: '1px solid var(--accent-gold-border)',
        borderRight: '1px solid var(--accent-gold-border)',
      }
    : undefined;

  // ── No row for this staff/date (e.g. joined mid-month) ────────────────────
  if (!log) {
    return (
      <div className="flex h-full items-center px-3" style={{ background: 'var(--bg-base)' }}>
        <span className="font-mono text-[13px]" style={{ color: 'var(--text-disabled)' }}>
          —
        </span>
      </div>
    );
  }

  // ── Sunday: greyed, non-interactive ────────────────────────────────────────
  if (log.dayType === 'sunday') {
    return (
      <div className="flex h-full items-center px-3" style={{ background: 'var(--bg-base)' }}>
        <span className="font-mono text-[13px]" style={{ color: 'var(--text-disabled)' }}>
          Sun
        </span>
      </div>
    );
  }

  // ── Holiday: gold-tinted, non-interactive, name in tooltip ────────────────
  if (log.dayType === 'holiday') {
    return (
      <div
        className="flex h-full items-center px-3"
        style={{
          background: 'var(--accent-gold-06)',
          borderBottom: '1px solid var(--accent-gold)',
        }}
        title={holidayName ?? 'Holiday'}
        aria-label={`Holiday${holidayName ? `: ${holidayName}` : ''}`}
      >
        <span className="font-mono text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          Holiday
        </span>
      </div>
    );
  }

  // ── Working + locked period: static <span>, nothing focusable ─────────────
  if (locked) {
    return (
      <div className="flex h-full items-center gap-2 px-3" style={{ background: 'var(--bg-base)' }}>
        <span
          className="font-mono text-[13px] italic"
          style={{ color: 'var(--text-disabled)' }}
        >
          {log.present ? '✓ Present' : '– Absent'}
        </span>
        {log.workLog ? (
          <span
            className="truncate font-mono text-xs italic"
            style={{ color: 'var(--text-disabled)' }}
            title={log.workLog}
          >
            {log.workLog}
          </span>
        ) : null}
      </div>
    );
  }

  // ── Working, unlocked: the interactive cell ────────────────────────────────
  return (
    <div
      data-attendance-cell="working"
      data-editable={editable ? 'true' : 'false'}
      className={cn('relative flex h-full flex-col justify-center px-1.5', !editable && 'pointer-events-none opacity-40')}
      style={{ background: 'var(--bg-elevated)', ...highlight }}
    >
      {/* Save-status dot (never colour alone — title + sr text carry meaning). */}
      {saveState ? (
        <span
          className={cn('absolute right-1 top-1 h-1.5 w-1.5 rounded-full', saveState === 'saving' && 'animate-pulse')}
          style={{ background: saveState === 'error' ? 'var(--status-red)' : 'var(--accent-gold)' }}
          title={saveState === 'error' ? 'Save failed' : 'Saving…'}
        >
          <span className="sr-only">{saveState === 'error' ? 'Save failed' : 'Saving'}</span>
        </span>
      ) : null}

      {staleName ? (
        // 409 STALE_DATA inline handler (09-ERROR-HANDLING §5.1).
        <div className="flex items-center gap-1">
          <span
            className="truncate font-mono text-xs"
            style={{ color: 'var(--status-amber)' }}
            title={`Updated by ${staleName}`}
          >
            Updated by {staleName}
          </span>
          <button
            type="button"
            onClick={onRefreshRow}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded"
            aria-label="Refresh row"
            title="Refresh row"
          >
            <RefreshCw size={14} style={{ color: 'var(--accent-gold)' }} />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => onTogglePresent(log)}
            onFocus={onFocus}
            onBlur={onBlur}
            aria-pressed={log.present}
            aria-label={`${log.present ? 'Present' : 'Absent'} — ${staffName}, ${log.date}. Toggle.`}
            className="flex h-11 w-11 items-center justify-center rounded font-mono text-[13px]"
            style={{ color: log.present ? 'var(--accent-gold)' : 'var(--text-muted)' }}
          >
            {log.present ? '✓' : '–'}
          </button>
          <button
            type="button"
            onClick={() => onToggleExpand(log.id)}
            onFocus={onFocus}
            onBlur={onBlur}
            aria-expanded={expanded}
            aria-label={`Work log for ${staffName}, ${log.date}${log.workLog ? ' (has note)' : ''}`}
            title={log.workLog ?? 'Add work log'}
            className="relative flex h-11 w-11 items-center justify-center rounded"
            style={{ color: log.workLog ? 'var(--accent-gold)' : 'var(--text-muted)' }}
          >
            <NotebookPen size={14} />
            {log.workLog ? (
              <span
                className="absolute right-2 top-2 h-1 w-1 rounded-full"
                style={{ background: 'var(--accent-gold)' }}
              />
            ) : null}
          </button>
        </div>
      )}

      {expanded && !staleName ? (
        <textarea
          ref={textareaRef}
          value={draft}
          maxLength={WORK_LOG_MAX}
          rows={1}
          placeholder="Work log…"
          aria-label={`Work log text for ${staffName}, ${log.date}`}
          className="mb-1 w-full resize-none rounded px-1.5 py-0.5 font-mono text-xs"
          style={{
            background: 'var(--bg-base)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-default)',
          }}
          onFocus={onFocus}
          onChange={(e) => {
            const value = e.target.value;
            setDraft(value);
            if (debounceRef.current) clearTimeout(debounceRef.current);
            // Autosave 800ms after the last keystroke (UIUX §7).
            debounceRef.current = setTimeout(() => onSaveWorkLog(log, value), 800);
          }}
          onBlur={() => {
            // Flush a pending edit immediately on blur so nothing is lost.
            if (debounceRef.current) {
              clearTimeout(debounceRef.current);
              debounceRef.current = null;
              if (draft !== (log.workLog ?? '')) onSaveWorkLog(log, draft);
            }
            onBlur();
          }}
        />
      ) : null}
    </div>
  );
}
