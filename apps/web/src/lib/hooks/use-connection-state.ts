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

    // OPTIMISTIC AT MOUNT, deliberately.
    //
    // getSocket() creates the connection on first call, so `socket.connected` is
    // false until the handshake completes — a few hundred ms during which seeding
    // state from it would flash the "Reconnecting…" banner and DISABLE the composer
    // on every single page load. The user has not lost anything at that point; they
    // simply have not connected yet, and those are different things.
    //
    // So state changes only on real events: 'disconnect' means we had a connection
    // and lost it, which is the only case worth telling anyone about. If the very
    // first handshake fails, socket.io emits 'disconnect' too, so a genuine failure
    // still surfaces — just without the false positive on every load.
    if (socket.connected) setSocketUp(true);

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
