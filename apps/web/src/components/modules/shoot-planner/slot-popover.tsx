'use client';

import { useEffect, useState } from 'react';

import { buildCtaPatch, buildFieldPatch, ctaLabel, periodBounds, type SlotPatch, type SlotDraft } from './slot-actions';

import type { Slot } from './types';

const mono = { fontFamily: 'var(--font-mono)' } as const;

/**
 * The slot popover (UIUX §4.5/§9, APPFLOW §6): date picker (period-bound,
 * native input) + pieces stepper + freelancer dropdown + the state CTA.
 * Opens below the cell; Esc / outside-click close (the grid renders a backdrop).
 * Admin/manager only — the grid never mounts this for read-only viewers.
 */
export function SlotPopover({
  slot,
  period,
  piecesDefault,
  freelancers,
  busy,
  columnFocus,
  onPatch,
  onClose,
}: {
  slot: Slot;
  period: string;
  piecesDefault: number;
  freelancers: { id: string; name: string }[];
  busy: boolean;
  columnFocus: { onFocus: () => void; onBlur: () => void };
  onPatch: (patch: SlotPatch) => void;
  onClose: () => void;
}) {
  const bounds = periodBounds(period);
  const [draft, setDraft] = useState<SlotDraft>({
    slotDate: slot.slotDate ?? '',
    piecesExpected: slot.piecesExpected || piecesDefault,
    freelancerId: slot.freelancerId,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cta = ctaLabel(slot.slotStatus);
  const needsDate = slot.slotStatus === 'Unset' || slot.slotStatus === 'Scheduled';
  const ctaDisabled = busy || (needsDate && !draft.slotDate);
  // A Confirmed slot: field edits (reschedule) are a separate save from Complete.
  const fieldPatch = buildFieldPatch(slot, draft);
  const dirty = Object.keys(fieldPatch).length > 0;

  return (
    <div
      data-testid="slot-popover"
      role="dialog"
      aria-label={`Edit slot ${slot.slotIndex} for ${slot.clientName}`}
      className="absolute left-0 top-full z-50 mt-1 flex w-56 flex-col gap-2 rounded-lg p-3"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
    >
      <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
        Shoot date
        <input
          type="date"
          data-testid="slot-date"
          value={draft.slotDate}
          min={bounds.min}
          max={bounds.max}
          disabled={slot.slotStatus === 'Completed'}
          onChange={(e) => setDraft((d) => ({ ...d, slotDate: e.target.value }))}
          {...columnFocus}
          className="rounded px-2 py-1.5 text-sm"
          style={{ ...mono, background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
        Pieces expected
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Fewer pieces"
            disabled={draft.piecesExpected <= 1}
            onClick={() => setDraft((d) => ({ ...d, piecesExpected: d.piecesExpected - 1 }))}
            {...columnFocus}
            className="h-8 w-8 rounded text-sm font-bold"
            style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
          >
            −
          </button>
          <span data-testid="slot-pieces" className="w-8 text-center text-sm" style={{ ...mono, color: 'var(--text-primary)' }}>
            {draft.piecesExpected}
          </span>
          <button
            type="button"
            aria-label="More pieces"
            onClick={() => setDraft((d) => ({ ...d, piecesExpected: d.piecesExpected + 1 }))}
            {...columnFocus}
            className="h-8 w-8 rounded text-sm font-bold"
            style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
          >
            +
          </button>
        </div>
      </label>

      <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
        Freelancer
        <select
          data-testid="slot-freelancer"
          value={draft.freelancerId ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, freelancerId: e.target.value || null }))}
          {...columnFocus}
          className="rounded px-2 py-1.5 text-sm"
          style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
        >
          <option value="">Unassigned</option>
          {freelancers.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>

      {/* Reschedule / field edits on a Confirmed slot save separately from Complete. */}
      {slot.slotStatus === 'Confirmed' && dirty ? (
        <button
          type="button"
          data-testid="slot-save-changes"
          disabled={busy}
          onClick={() => onPatch(fieldPatch)}
          className="rounded px-3 py-2 text-sm font-semibold"
          style={{ background: 'var(--bg-base)', border: '1px solid var(--accent-gold-border)', color: 'var(--accent-gold)' }}
        >
          Save changes
        </button>
      ) : null}

      {cta ? (
        <button
          type="button"
          data-testid="slot-cta"
          disabled={ctaDisabled}
          onClick={() => onPatch(buildCtaPatch(slot, draft))}
          className="rounded px-3 py-2 text-sm font-bold"
          style={{
            background: ctaDisabled ? 'var(--bg-base)' : 'var(--accent-gold)',
            color: ctaDisabled ? 'var(--text-disabled)' : '#1A1A1A',
            cursor: ctaDisabled ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? 'Saving…' : cta}
        </button>
      ) : null}
    </div>
  );
}
