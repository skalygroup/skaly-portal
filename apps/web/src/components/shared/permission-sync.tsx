'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

import { useNotifySocket } from '@/lib/socket';

/**
 * ADR-029's client half: an admin changes your permissions, your screen catches
 * up without a reload.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 * It is not enforcement. `perms:{staffId}` is deleted on every override write, so
 * the affected user's NEXT request already re-resolves from the database — there
 * is no window in which a revoked permission still works, with or without this
 * component. Enforcement stays server-side and per-request; ADR-029's rule is
 * "never move an enforcement decision onto a delivery channel that can drop
 * messages", and this channel can drop messages.
 *
 * What it fixes is an IDLE SESSION. Without it, a revoked module stays in the nav
 * until the user clicks it — at which point it correctly 403s, having offered an
 * action that could only ever fail. That is the half that reads as a bug.
 *
 * ── Why both a refetch and a refresh ─────────────────────────────────────────
 * The permission map has two consumers with different lifetimes. The grids and
 * the search palette hold it in TanStack under `['staff-me']`; the settings nav
 * and every `requirePanel` gate resolve it on the SERVER, where invalidating a
 * client cache means nothing. `router.refresh()` re-runs those Server Components
 * against the same freshly-resolved permissions, so the nav a user sees and the
 * gate that answers their next URL cannot disagree.
 *
 * ── Why no payload ───────────────────────────────────────────────────────────
 * The event carries `{ staffId, permissionKey }` and this ignores both. Per
 * ADR-022's matrix it is an INVALIDATE, not a patch: the payload names the key
 * that changed but cannot express what it RESOLVES to, because resolution is the
 * server's job and there is exactly one resolver (Sprint 8.1). Patching the
 * cached map from the key alone would be a second resolver, in the browser,
 * guessing.
 *
 * Mounted once in the portal layout — the socket is a per-namespace singleton, so
 * a second mount would handle every event twice.
 */
export function PermissionSync() {
  const queryClient = useQueryClient();
  const router = useRouter();

  const onChanged = useCallback(() => {
    // ONE key, five consumers (the four module grids and the search palette all
    // read `['staff-me']`), so TanStack dedups this into a single refetch.
    void queryClient.invalidateQueries({ queryKey: ['staff-me'] });
    router.refresh();
  }, [queryClient, router]);

  useNotifySocket('permission_changed', onChanged);

  return null;
}
