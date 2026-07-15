'use client';

import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';

/**
 * Per-date-group collapse state for the tasks grid, persisted to sessionStorage
 * so collapsing a group survives a reload within the tab (Step 6). Keyed by the
 * 'YYYY-MM-DD' date. Default (absent key) = expanded.
 */
interface TaskGroupsStore {
  collapsed: Record<string, boolean>;
  toggle: (dateKey: string) => void;
}

// sessionStorage doesn't exist during SSR; fall back to a no-op so store
// creation never throws when a client component is rendered on the server.
const noopStorage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

export const useTaskGroups = create<TaskGroupsStore>()(
  persist(
    (set) => ({
      collapsed: {},
      toggle: (dateKey) =>
        set((s) => ({ collapsed: { ...s.collapsed, [dateKey]: !s.collapsed[dateKey] } })),
    }),
    {
      name: 'skaly:task-groups',
      storage: createJSONStorage(() =>
        typeof window === 'undefined' ? noopStorage : window.sessionStorage,
      ),
    },
  ),
);
