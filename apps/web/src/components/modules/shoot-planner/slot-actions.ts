import { endOfMonth, format } from 'date-fns';

import type { Slot } from './types';

/** The popover's editable fields. */
export interface SlotDraft {
  slotDate: string;
  piecesExpected: number;
  freelancerId: string | null;
}

/** A slot PATCH body. NEVER contains `version` — slots are last-write-wins. */
export type SlotPatch = {
  slotStatus?: 'Scheduled' | 'Confirmed' | 'Completed';
  slotDate?: string;
  piecesExpected?: number;
  freelancerId?: string | null;
};

/** The date-picker bounds for a period: first → last day (UIUX §4.5). */
export function periodBounds(period: string): { min: string; max: string } {
  return { min: `${period}-01`, max: format(endOfMonth(new Date(`${period}-01T00:00:00`)), 'yyyy-MM-dd') };
}

/** The popover CTA label for a slot's current state (APPFLOW §6). */
export function ctaLabel(slotStatus: string): string | null {
  switch (slotStatus) {
    case 'Unset':
      return 'Schedule';
    case 'Scheduled':
      return 'Confirm';
    case 'Confirmed':
      return 'Mark as Completed';
    default:
      return null; // Completed: reset is the only way back (⋯ menu)
  }
}

/**
 * Build the PATCH body the CTA sends (APPFLOW §6). Unset→Schedule sends the
 * full draft; Scheduled→Confirm sends the status + whatever the user changed;
 * Confirmed→Complete sends only the status (field edits on a Confirmed slot go
 * through buildFieldPatch). Never includes `version`.
 */
export function buildCtaPatch(slot: Slot, draft: SlotDraft): SlotPatch {
  switch (slot.slotStatus) {
    case 'Unset':
      return {
        slotStatus: 'Scheduled',
        slotDate: draft.slotDate,
        piecesExpected: draft.piecesExpected,
        freelancerId: draft.freelancerId,
      };
    case 'Scheduled':
      return { slotStatus: 'Confirmed', ...buildFieldPatch(slot, draft) };
    default:
      return { slotStatus: 'Completed' };
  }
}

/** Only the fields the user actually changed (same-state edit / reschedule). */
export function buildFieldPatch(slot: Slot, draft: SlotDraft): Omit<SlotPatch, 'slotStatus'> {
  const patch: Omit<SlotPatch, 'slotStatus'> = {};
  if (draft.slotDate && draft.slotDate !== (slot.slotDate ?? '')) patch.slotDate = draft.slotDate;
  if (draft.piecesExpected !== slot.piecesExpected) patch.piecesExpected = draft.piecesExpected;
  if (draft.freelancerId !== slot.freelancerId) patch.freelancerId = draft.freelancerId;
  return patch;
}

/** Optimistically merge a patch into the cached slot list (revert = snapshot). */
export function applyPatchToSlots(slots: Slot[], slotId: string, patch: SlotPatch): Slot[] {
  return slots.map((s) => (s.id === slotId ? { ...s, ...patch } : s));
}

/** Replace one slot with the server's returned row (onSuccess). */
export function replaceSlot(slots: Slot[], updated: Slot): Slot[] {
  return slots.map((s) => (s.id === updated.id ? updated : s));
}
