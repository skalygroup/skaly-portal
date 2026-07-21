'use client';

import { create } from 'zustand';

/**
 * Transient Content Dropper UI state (shake, red error dot, STALE_DATA banner,
 * inline name edit). Kept in a store — NOT parent React state — so the cells
 * that read it subscribe individually. That keeps the TanStack `columns` memo
 * stable: without this, a focus/highlight/shake state change would rebuild
 * columns and remount the clicked button mid-interaction, swallowing the click.
 */
interface DropperUiState {
  shake: Set<string>; // `${clientId}:${stage}`
  error: Set<string>; // `${clientId}:${stage}` — red dot on a failed save
  stale: Record<string, string>; // clientId → editor name (STALE_DATA)
  editingClientId: string | null;
  nameDraft: string;

  triggerShake: (key: string) => void;
  markError: (key: string) => void;
  clearError: (key: string) => void;
  setStale: (clientId: string, name: string) => void;
  clearStale: (clientId: string) => void;
  startEdit: (clientId: string, name: string) => void;
  setDraft: (name: string) => void;
  stopEdit: () => void;
}

export const useDropperUiStore = create<DropperUiState>((set) => ({
  shake: new Set(),
  error: new Set(),
  stale: {},
  editingClientId: null,
  nameDraft: '',

  triggerShake: (key) => {
    set((s) => ({ shake: new Set(s.shake).add(key) }));
    setTimeout(() => {
      set((s) => {
        const next = new Set(s.shake);
        next.delete(key);
        return { shake: next };
      });
    }, 450);
  },
  markError: (key) => set((s) => ({ error: new Set(s.error).add(key) })),
  clearError: (key) =>
    set((s) => {
      const next = new Set(s.error);
      next.delete(key);
      return { error: next };
    }),
  setStale: (clientId, name) => set((s) => ({ stale: { ...s.stale, [clientId]: name } })),
  clearStale: (clientId) =>
    set((s) => {
      const next = { ...s.stale };
      delete next[clientId];
      return { stale: next };
    }),
  startEdit: (clientId, name) => set({ editingClientId: clientId, nameDraft: name }),
  setDraft: (name) => set({ nameDraft: name }),
  stopEdit: () => set({ editingClientId: null }),
}));
