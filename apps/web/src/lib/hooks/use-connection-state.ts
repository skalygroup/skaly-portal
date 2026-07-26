'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { getSocket, WS_NOTIFY } from '@/lib/socket';

/**
 * Connection state for the Error-Handling §5.4 banner.
 *
 * BACKOFF IS NOT HAND-ROLLED. Socket.io's built-in policy already matches the spec
 * (1s → 2s → 4s → 8s, capped at 30s) and lib/socket.ts configures it. Re-implementing
 * it here would give two competing retry schedules on one socket.
 *
 * ON RECONNECT, REFETCH UNCONDITIONALLY — once, not per query. The socket has no
 * replay: anything broadcast while we were down is simply gone, so the cache is stale
 * by an unknown amount and there is nothing to reconcile against. `invalidateQueries`
 * with no key marks everything stale and refetches what is actually mounted.
 */
export type ConnectionState = 'connected' | 'reconnecting' | 'offline';

export function useConnectionState(): ConnectionState {
  const queryClient = useQueryClient();
  const [socketUp, setSocketUp] = useState(true);
  const [browserOnline, setBrowserOnline] = useState(true);

  useEffect(() => {
    // navigator.onLine is a hint, not a guarantee — a captive portal reports "online".
    // The socket is the real signal; this only lets the UI say "offline" rather than
    // "reconnecting" when the OS is already certain there is no network.
    setBrowserOnline(navigator.onLine);
    const on = () => setBrowserOnline(true);
    const off = () => setBrowserOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    const socket = getSocket(WS_NOTIFY);
    setSocketUp(socket.connected);

    const onConnect = () => {
      setSocketUp(true);
      // Missed events are the whole reason this is unconditional.
      void queryClient.invalidateQueries();
    };
    const onDisconnect = () => setSocketUp(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [queryClient]);

  if (!browserOnline) return 'offline';
  return socketUp ? 'connected' : 'reconnecting';
}
