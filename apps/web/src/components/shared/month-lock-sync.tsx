'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useNotifySocket } from '@/lib/socket';

/**
 * `month:lock_changed`'s client half — ADR-029's pattern applied to the lock.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * `MonthService.lockMonth` has broadcast this since Sprint 11 with a comment
 * saying "every open grid for that period must stop offering edits that would
 * now be refused", and nothing listened. The emit was real, the UX layer was
 * missing, and an emit with no consumer is exactly the shape the ADR-020 census
 * exists to catch.
 *
 * Enforcement was never in doubt: a write to a locked period 423s server-side
 * either way. What was missing is the part the user experiences — a team member
 * editing a prior period that an admin has just locked finds out only when their
 * save is refused, potentially several cells in. That is a worse surprise than
 * the permission case, because the work is already typed.
 *
 * ── Invalidate, not patch ────────────────────────────────────────────────────
 * The payload carries `{ period, locked, actorStaffId }` and this ignores all of
 * it, per ADR-022's matrix. `locked` looks patchable, but the months rows also
 * carry `lockedBy`, `lockedAt` and the unlock reason — a partial patch would put
 * a row in the cache that never existed on the server, which is the failure
 * ADR-022 rule (b) names. One refetch answers all of it.
 *
 * ── One key, one endpoint ────────────────────────────────────────────────────
 * The five module grids and Settings → Months all read `['months']` now. They
 * did not when this shipped: the panel had its own `['settings', 'months']`
 * entry for the same `GET /v1/months`, so this component had to invalidate two
 * keys and a third consumer inventing a fourth would have been missed silently.
 * That is the split PermissionSync's test prevents on `['staff-me']`, and it had
 * already happened here. Unified in Sprint 12 — one invalidation, every surface.
 *
 * Mounted once in the portal layout — the socket is a per-namespace singleton, so
 * a second mount would handle every event twice.
 */
export function MonthLockSync() {
  const queryClient = useQueryClient();

  const onLockChanged = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['months'] });
  }, [queryClient]);

  useNotifySocket('month:lock_changed', onLockChanged);

  return null;
}
