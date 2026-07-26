'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import type { QueryClient } from '@tanstack/react-query';

import { getSocket, WS_NOTIFY } from '@/lib/socket';

/**
 * ADR-022 — patch vs invalidate, as a TABLE.
 *
 * The dividing line is CORRECTNESS, not performance:
 *
 *   PATCH      when the payload contains the COMPLETE new state of a single
 *              addressable cache entry.
 *   INVALIDATE when it does not — when the change touches a trigger, a cascade,
 *              an aggregate, membership, or row ordering.
 *
 * A patched cache missing a trigger's side effect shows stale DERIVED data, which is
 * worse than the refetch it avoided. The fan-out reduction falls out for free, because
 * the hot path (calendar cells) happens to be the patchable one.
 *
 * This is a table rather than a switch on purpose: the matrix IS the spec, and a table
 * can be read against the ADR line by line. An event absent from it is not wired —
 * adding a subscription means adding a row to ADR-022 first.
 */

/** What a handler may do with an event. */
export type SyncAction =
  | { kind: 'patch'; apply: (client: QueryClient, payload: RealtimePayload) => void }
  | { kind: 'invalidate'; keys: (payload: RealtimePayload) => unknown[][] };

export interface RealtimePayload {
  /** Who caused this. Present on every emitter; used for sender exclusion. */
  actorStaffId?: string;
  [key: string]: unknown;
}

/** A calendar cell as `content-calendar:updated` delivers it (ADR-022 patchable). */
interface CalendarCellPayload extends RealtimePayload {
  id: string;
  clientId: string;
  date: string;
  period: string;
  status: string;
  note: string | null;
  source: string | null;
  /** ⚠️ Load-bearing — see the patch note below. */
  version: number;
}

type PatchFn = (client: QueryClient, payload: RealtimePayload) => void;

const patch = (apply: PatchFn): SyncAction => ({ kind: 'patch', apply });
const invalidate = (keys: (p: RealtimePayload) => unknown[][]): SyncAction => ({ kind: 'invalidate', keys });

/**
 * THE MATRIX. Each row is one line of ADR-022.
 */
export const SYNC_MATRIX: Record<string, SyncAction> = {
  // ── PATCH — the payload fully specifies one addressable entry ──────────────
  'content-calendar:updated': patch((client, raw) => {
    const cell = raw as CalendarCellPayload;
    client.setQueryData(
      ['content-calendar', cell.period],
      (prev: { cells: CalendarCellPayload[]; clients: unknown[] } | undefined) => {
        if (!prev) return prev;
        const i = prev.cells.findIndex((c) => c.id === cell.id);
        if (i === -1) return prev;
        const next = prev.cells.slice();
        // ⚠️ The WHOLE cell, version included. Writing the fields and forgetting
        // `version` leaves the cache holding the OLD one, and the receiver's next
        // edit 409s against a value the server already moved past — which presents
        // as a backend bug and is not one (ADR-022 rule a).
        next[i] = { ...next[i], ...cell };
        return { ...prev, cells: next };
      },
    );
  }),

  'client:name_updated': patch((client, raw) => {
    const { clientId, name } = raw as RealtimePayload & { clientId: string; name: string };
    // A string. Every cached list holding this client is patched in place rather
    // than refetched — a rename must propagate across modules (APPFLOW §7).
    client.setQueriesData<{ clients?: { id: string; name: string }[] }>(
      { queryKey: ['content-calendar'] },
      (prev) => {
        if (!prev?.clients) return prev;
        return { ...prev, clients: prev.clients.map((c) => (c.id === clientId ? { ...c, name } : c)) };
      },
    );
  }),

  // ── INVALIDATE — the payload cannot express what changed ───────────────────
  //
  // H-01: one holiday flips EVERY staff column for that date and reverts their
  // attendance logs. No single-row payload can express that cascade, so patching
  // here would leave every other column showing a working day that is now a holiday.
  'attendance:holiday_added': invalidate((p) => [['attendance', p.period]]),
  'attendance:holiday_removed': invalidate((p) => [['attendance', p.period]]),

  // Ordering, membership and the ADR-006 assignee fan-out — a task's position in the
  // grid depends on rows the payload says nothing about.
  'task:created': invalidate((p) => [['tasks', p.period]]),
  'task:updated': invalidate((p) => [['tasks', p.period]]),
  'task:assigned': invalidate((p) => [['tasks', p.period]]),

  // Trigger 1 recomputes coming_shoot_date on the PIPELINE when a slot moves, so the
  // dropper is stale in a way the slot's own fields do not describe (ADR-012).
  'shoot:slot_updated': invalidate((p) => [
    ['shoot-planner', p.period],
    ['content-dropper', p.period],
  ]),

  // ADR-013: the derived status is recomputed server-side and this payload carries
  // only {clientId, period}. Invalidate-only BY DEFINITION until the payload can
  // carry the recomputed status — which is exactly ADR-022 rule a.
  'content-dropper:updated': invalidate((p) => [['content-dropper', p.period]]),
};

/**
 * Attach the matrix for one module's events.
 *
 * `events` names which rows this component cares about, so a grid only re-renders for
 * its own module. Every event still routes through the same table — the subset is a
 * subscription filter, never a second policy.
 */
export function useRealtimeSync(events: readonly string[], currentStaffId?: string): void {
  const queryClient = useQueryClient();
  // Read through a ref so a changing staffId never resubscribes the socket.
  const meRef = useRef(currentStaffId);
  meRef.current = currentStaffId;

  const handle = useCallback(
    (event: string, payload: RealtimePayload) => {
      // SENDER EXCLUSION, client half (ADR-022 rule b). The server uses
      // socket.broadcast for socket-originated events, but REST-originated ones have
      // no originating socket to exclude, so the actor gets their own echo. Applying
      // it would double-apply the optimistic update the actor already made, or fight
      // the mutation still in flight — a failure nearly impossible to diagnose from a
      // bug report, which is why there are two guards rather than one.
      if (meRef.current && payload.actorStaffId === meRef.current) return;

      const action = SYNC_MATRIX[event];
      // Not in the matrix means not wired. Silence is correct: the ADR is the spec,
      // and an unknown event is a missing ADR row, not a runtime decision.
      if (!action) return;

      if (action.kind === 'patch') {
        action.apply(queryClient, payload);
        return;
      }
      for (const key of action.keys(payload)) {
        // v5 object form.
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    [queryClient],
  );

  useEffect(() => {
    const socket = getSocket(WS_NOTIFY);
    const bound = events.map((event) => {
      const fn = (payload: RealtimePayload) => handle(event, payload);
      socket.on(event, fn);
      return [event, fn] as const;
    });
    return () => {
      for (const [event, fn] of bound) socket.off(event, fn);
    };
    // `events` is a module-level constant array at every call site.
  }, [events, handle]);
}
