'use client';

import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { getSocket, useSocketRooms, WS_NOTIFY } from '@/lib/socket';

/**
 * A query whose data cannot be silently stale (ADR-025).
 *
 * ── The defect this exists for ────────────────────────────────────────────────
 * Consumers fetched on mount and joined their socket room some milliseconds later.
 * Anything broadcast in between reached nobody AND was absent from the snapshot.
 * Nothing corrected it afterwards: `providers.tsx` sets `refetchOnWindowFocus: false`,
 * there is no `refetchInterval`/`refetchOnMount`/`refetchOnReconnect` anywhere, and no
 * consumer gated on socket state. A tab that missed an event was wrong for the rest of
 * its lifetime, with no visual cue — silent stale data on a shared operational grid.
 *
 * ── TWO gaps, not one ────────────────────────────────────────────────────────
 *   1. PRE-JOIN   — the fetch goes out before the room exists.
 *   2. IN-FLIGHT  — even with the room joined first, an event arriving WHILE the
 *                   initial fetch is in flight patches the cache, and then the fetch
 *                   resolves from a snapshot taken before that event and overwrites it.
 *
 * Ordering alone closes only (1). That is precisely why the obvious fix —
 * `invalidateQueries` on 'connect' — made things worse when it was tried in Sprint 10:
 * it moved the race later and made it rarer, so it stopped failing the suite and
 * started presenting as an unreproducible "sometimes it doesn't update".
 *
 * ── The fix ──────────────────────────────────────────────────────────────────
 *   (1) is closed by `enabled: subscribed` — TanStack's own flag does the sequencing,
 *       so there is no bespoke orchestration to keep in step.
 *   (2) is closed by buffering events during the fetch and replaying them ONTO the
 *       snapshot INSIDE `queryFn`. Reconciled data is what enters the cache, so there
 *       is no moment at which the cache holds the un-reconciled snapshot. Draining in
 *       an effect keyed on `dataUpdatedAt` would leave exactly that moment open.
 */
export interface RealtimeQueryOptions<TData> {
  queryKey: QueryKey;
  queryFn: () => Promise<TData>;
  /** Socket events this surface listens to. */
  events: readonly string[];
  /**
   * Pure reducer: `(snapshot, event) => snapshot`. Used for BOTH live patching and
   * buffer replay, which is what makes the two paths incapable of disagreeing.
   * Return `INVALIDATE` for events whose effect a payload cannot express.
   */
  applyEvent: (data: TData, event: { name: string; payload: unknown }) => TData | typeof INVALIDATE;
  namespace?: string;
  enabled?: boolean;
  staleTime?: number;
}

/**
 * Sentinel for ADR-022's invalidate half of the matrix.
 *
 * Some events cannot be expressed as a patch — the H-01 holiday cascade flips every
 * staff column for a date; a task create/assign changes membership, not a field. Those
 * rows of the matrix refetch, and always did. Returning this from the reducer keeps
 * that decision in ONE place (the reducer) instead of splitting it between a reducer
 * and a separate event list that could drift apart.
 */
export const INVALIDATE = Symbol('realtime:invalidate');

export function useRealtimeQuery<TData>(opts: RealtimeQueryOptions<TData>) {
  const {
    queryKey,
    queryFn,
    events,
    applyEvent,
    namespace = WS_NOTIFY,
    enabled = true,
    staleTime = 30_000,
  } = opts;

  const queryClient = useQueryClient();
  const { subscribed } = useSocketRooms(namespace);

  // Events seen while the initial fetch is in flight, awaiting replay.
  const buffer = useRef<{ name: string; payload: unknown }[]>([]);
  const collecting = useRef(false);

  // Kept in refs so the socket handler below never needs to be re-bound when a
  // caller passes a fresh closure — re-binding mid-flight would drop events.
  const applyRef = useRef(applyEvent);
  applyRef.current = applyEvent;
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;

  const wrappedQueryFn = useCallback(async (): Promise<TData> => {
    buffer.current = [];
    collecting.current = true;
    try {
      // Annotated: without it TS widens to `Awaited<TData>` and the reducer's
      // `TData` result no longer assigns back.
      const snapshot: TData = await queryFn();
      // Replay BEFORE returning: what the cache receives is already reconciled.
      let next: TData = snapshot;
      for (const event of buffer.current) {
        const result = applyRef.current(next, event);
        // An invalidate-only event during the fetch means the snapshot cannot be
        // repaired by replay. Returning it as-is and scheduling a refetch is correct
        // and terminates: the refetch takes a snapshot that already includes the
        // change, so it has nothing left to replay.
        if (result === INVALIDATE) {
          queueMicrotask(() => {
            void queryClient.invalidateQueries({ queryKey: keyRef.current });
          });
          break;
        }
        next = result;
      }
      return next;
    } finally {
      collecting.current = false;
      buffer.current = [];
    }
  }, [queryFn, queryClient]);

  const query = useQuery({
    queryKey,
    queryFn: wrappedQueryFn,
    // (1) The pre-join gap: no fetch until the server has acked our rooms.
    enabled: enabled && subscribed,
    staleTime,
    // The cheap self-healing net A2 says is missing. Scoped to realtime-backed
    // queries ONLY — flipping it globally would reintroduce the fan-out problem
    // ADR-022 exists to prevent (50 users, one edit, 50 refetches).
    refetchOnWindowFocus: true,
  });

  /**
   * RECONNECT resync — the same mechanism as mount, not a second code path.
   *
   * While disconnected the socket has no replay, so the cache is stale by an unknown
   * amount. `enabled` alone will not refetch if the data is still inside `staleTime`,
   * so re-subscription has to mark it stale explicitly.
   *
   * The ORDER is what makes this safe, and it is the whole difference from the
   * invalidate-on-connect this replaces: `subscribed` only goes true on the room ack,
   * so by the time this fires we are already in the room, and anything arriving during
   * the refetch is buffered and replayed rather than overwritten.
   */
  // "Have we EVER been subscribed" — deliberately not "were we subscribed last
  // render". Clearing this on disconnect would make every reconnect look like a
  // first subscribe, and the resync would never fire at all.
  const subscribedBefore = useRef(false);
  useEffect(() => {
    if (!subscribed) return;
    if (subscribedBefore.current) {
      void queryClient.invalidateQueries({ queryKey: keyRef.current });
    }
    // The FIRST subscribe needs no invalidate — the initial fetch is gated on it
    // and runs on its own.
    subscribedBefore.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribed]);

  useEffect(() => {
    const socket = getSocket(namespace);

    const handlers = events.map((name) => {
      const handler = (payload: unknown): void => {
        // (2) The in-flight gap: hold it for replay rather than patching a cache
        // the pending fetch is about to overwrite.
        if (collecting.current) {
          buffer.current.push({ name, payload });
          return;
        }
        const current = queryClient.getQueryData<TData>(keyRef.current);
        if (current === undefined) return; // nothing cached yet; the fetch will include it
        const result = applyRef.current(current, { name, payload });
        if (result === INVALIDATE) {
          void queryClient.invalidateQueries({ queryKey: keyRef.current });
        } else {
          queryClient.setQueryData<TData>(keyRef.current, result);
        }
      };
      socket.on(name, handler);
      return { name, handler };
    });

    return () => {
      for (const { name, handler } of handlers) socket.off(name, handler);
    };
    // `events` is a literal array at every call site; join it so a new array with
    // the same contents does not re-bind every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, events.join('|'), queryClient]);

  return { ...query, subscribed };
}
