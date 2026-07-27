'use client';


import { useEffect, useState } from 'react';

import { getSocket, useSocketRooms, WS_NOTIFY } from '@/lib/socket';

/**
 * Connection state for the Error-Handling §5.4 banner.
 *
 * BACKOFF IS NOT HAND-ROLLED. Socket.io's built-in policy already matches the spec
 * (1s → 2s → 4s → 8s, capped at 30s) and lib/socket.ts configures it. Re-implementing
 * it here would give two competing retry schedules on one socket.
 *
 * ⚠️ THIS NO LONGER REFETCHES (ADR-025, Sprint 10.1). It used to call
 * `invalidateQueries()` with no key on every 'connect' — the original
 * 09-ERROR-HANDLING §5.4 instruction. The reasoning was sound (the socket has no
 * replay, so the cache is stale by an unknown amount) and the timing was not: the
 * refetch went out before room membership was re-established, so it could resolve
 * from a snapshot taken before an event that arrived in the meantime and overwrite
 * it. Resync now belongs to `useRealtimeQuery`, which runs it after the ack and
 * buffers anything landing during the fetch.
 *
 * What is left here is presentation: the banner. It reports CONNECTED only once the
 * rooms are acked, because between 'connect' and that ack the user is transported
 * but not subscribed.
 */
export type ConnectionState = 'connected' | 'reconnecting' | 'offline';

export function useConnectionState(): ConnectionState {
  const { subscribed } = useSocketRooms(WS_NOTIFY);
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

    /**
     * ⚠️ This used to call `queryClient.invalidateQueries()` unconditionally on
     * 'connect' — 09-ERROR-HANDLING §5.4 as originally written. ADR-025 removes it:
     * the refetch was issued BEFORE room membership was re-established, so it could
     * resolve from a snapshot taken before an event that arrived in the meantime and
     * silently overwrite it. Resync now belongs to `useRealtimeQuery`, which runs it
     * after the ack and buffers anything that lands during the fetch.
     */
    const onConnect = () => setSocketUp(true);
    const onDisconnect = () => setSocketUp(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  if (!browserOnline) return 'offline';
  // "Connected" means SUBSCRIBED, not merely transported (ADR-025). Between
  // 'connect' and the room:join ack the socket is up while broadcasts still land
  // nowhere — clearing the banner there tells the user they are live when they are
  // not, which is worse than showing it a moment longer.
  return socketUp && subscribed ? 'connected' : 'reconnecting';
}
