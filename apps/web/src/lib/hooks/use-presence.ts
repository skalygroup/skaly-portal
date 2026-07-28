'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { api } from '@/lib/api';
import { getSocket, usePresenceSocket, WS_PRESENCE } from '@/lib/socket';

/**
 * Who is online (ADR-023).
 *
 * SEEDED from GET /v1/staff, then PATCHED by `presence:changed` deltas. Not polled:
 * the server broadcasts only genuine transitions, so a delta stream is both cheaper
 * and more accurate than re-asking every N seconds.
 *
 * The roster is scoped by the SERVER — /v1/staff reports `isOnline` only for rows the
 * caller is already authorised to see (ADR-011), so presence can never become a
 * directory of staff a freelancer cannot otherwise list.
 *
 * Also owns the 30s heartbeat. It lives here rather than in a component because
 * exactly one heartbeat per tab is wanted: mounting this hook twice shares the same
 * socket, and the interval is keyed to the socket's lifetime, not the component's.
 */
const HEARTBEAT_MS = 30_000;

interface StaffListItem {
  id: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  isOnline: boolean;
}

export function usePresence(): { onlineIds: Set<string>; isOnline: (staffId: string) => boolean } {
  const [online, setOnline] = useState<Set<string>>(new Set());

  const { data: staff } = useQuery({
    queryKey: ['staff'],
    queryFn: async () => (await api<{ data: StaffListItem[] }>('/v1/staff')).data,
    staleTime: 5 * 60_000,
  });

  // Seed once the roster arrives. Deltas that land before this simply re-apply.
  useEffect(() => {
    if (!staff) return;
    setOnline(new Set(staff.filter((s) => s.isOnline).map((s) => s.id)));
  }, [staff]);

  const onChanged = useCallback(({ staffId, isOnline }: { staffId: string; isOnline: boolean }) => {
    setOnline((prev) => {
      // Same-set short-circuit: a redelivered transition must not re-render the tree.
      if (prev.has(staffId) === isOnline) return prev;
      const next = new Set(prev);
      if (isOnline) next.add(staffId);
      else next.delete(staffId);
      return next;
    });
  }, []);
  usePresenceSocket<{ staffId: string; isOnline: boolean }>('presence:changed', onChanged);

  // The heartbeat. Half the server's 60s freshness window (ADR-023), so one dropped
  // beat cannot flicker this tab offline.
  useEffect(() => {
    const socket = getSocket(WS_PRESENCE);
    const beat = () => socket.emit('presence:ping');
    beat(); // immediately, so a reconnect refreshes without waiting a full interval
    const timer = setInterval(beat, HEARTBEAT_MS);
    socket.on('connect', beat);
    return () => {
      clearInterval(timer);
      socket.off('connect', beat);
    };
  }, []);

  const isOnline = useCallback((staffId: string) => online.has(staffId), [online]);
  return { onlineIds: online, isOnline };
}
