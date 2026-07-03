'use client';

import { create } from 'zustand';

/**
 * Gold column highlight (Amendment 2 / UIUX §4.4) — shared by every editable
 * grid in the portal. Non-virtualised grids use this per-cell hook approach;
 * virtual-scrolled grids (Content Calendar) will use the overlay variant.
 *
 * State rules (§4.4):
 *   1. onFocus            → column highlighted
 *   2. save in-flight     → stays highlighted even if focus moves on
 *   3. save success       → cleared (unless the user is still focused there)
 *   4. save failure       → stays highlighted; red status dot + toast; cleared
 *                           1.5s later (the component schedules that clear)
 *   5. locked months      → cells are <span>s, no onFocus ever fires
 */

interface ColumnHighlightStore {
  activeColumnId: string | null;
  /** Columns with a save in-flight — they hold their highlight through blur. */
  pending: Set<string>;
  setActiveColumn: (id: string | null) => void;
  /** blur-clear: only clears if the column has no in-flight save. */
  clearColumn: (id: string) => void;
  markPending: (id: string) => void;
  clearPending: (id: string) => void;
}

export const useColumnHighlightStore = create<ColumnHighlightStore>((set) => ({
  activeColumnId: null,
  pending: new Set<string>(),
  setActiveColumn: (id) => set({ activeColumnId: id }),
  clearColumn: (id) =>
    set((s) => (s.activeColumnId === id && !s.pending.has(id) ? { activeColumnId: null } : {})),
  markPending: (id) => set((s) => ({ pending: new Set(s.pending).add(id) })),
  clearPending: (id) =>
    set((s) => {
      const pending = new Set(s.pending);
      pending.delete(id);
      return { pending };
    }),
}));

/** Focus handlers for one editable cell in `columnId` (UIUX §4.4 snippet). */
export function useColumnHighlight(columnId: string) {
  const setActiveColumn = useColumnHighlightStore((s) => s.setActiveColumn);
  const clearColumn = useColumnHighlightStore((s) => s.clearColumn);
  return {
    onFocus: () => setActiveColumn(columnId),
    onBlur: () => clearColumn(columnId),
  };
}
