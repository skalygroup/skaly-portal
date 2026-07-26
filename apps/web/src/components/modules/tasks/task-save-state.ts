'use client';

import { create } from 'zustand';

/**
 * Per-row transient save state for the tasks grid: the result editor's save dot
 * and the shake a DEPENDENCY_UNRESOLVED rejection triggers.
 *
 * IT LIVES IN A STORE FOR THE SAME REASON `activeColumnId` DOES (see
 * `useColumnActive` in task-cells.tsx). Held as grid state, both of these went
 * into the `edit` object, which is in the column-definition memo — so every
 * save, and every shake, rebuilt the columns and TanStack Table remounted every
 * cell. StatusCell's `open` flag lives in the cell, so a remount closes the
 * dropdown the user has just opened.
 *
 * That is not theoretical: the shake clears itself 400ms after a refused status
 * change, and a user retrying inside that window had the menu vanish under their
 * finger. It failed deterministically on webkit (Sprint 9 STEP 12) and passed on
 * chromium only because its clicks beat the timer.
 *
 * Subscribing per cell means a save dot on one row re-renders that row's editor
 * and nothing else.
 */
export type SaveState = 'saving' | 'saved' | 'error' | undefined;

interface TaskSaveStore {
  saveStates: Record<string, SaveState>;
  /** Task ids currently shaking (a refused status transition). */
  shakeIds: Set<string>;
  setSave: (taskId: string, state: SaveState) => void;
  addShake: (taskId: string) => void;
  removeShake: (taskId: string) => void;
}

export const useTaskSaveStore = create<TaskSaveStore>((set) => ({
  saveStates: {},
  shakeIds: new Set<string>(),
  setSave: (taskId, state) => set((s) => ({ saveStates: { ...s.saveStates, [taskId]: state } })),
  addShake: (taskId) => set((s) => ({ shakeIds: new Set(s.shakeIds).add(taskId) })),
  removeShake: (taskId) =>
    set((s) => {
      const next = new Set(s.shakeIds);
      next.delete(taskId);
      return { shakeIds: next };
    }),
}));

/** One row's save dot state. */
export function useTaskSaveState(taskId: string): SaveState {
  return useTaskSaveStore((s) => s.saveStates[taskId]);
}

/** Whether this row is shaking off a refused transition. */
export function useTaskShaking(taskId: string): boolean {
  return useTaskSaveStore((s) => s.shakeIds.has(taskId));
}
