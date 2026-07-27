'use client';

import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import { createClient } from '@/lib/supabase/client';

/**
 * The shared socket client — ONE connection per namespace (ADR-010 amendment).
 *
 * Sprint 8 built the connection itself: the TRD §8 reconnection policy, the C-05
 * refresh handshake (a 1-hour JWT expires mid-conversation and would otherwise drop
 * the bot socket), and the ability to subscribe.
 *
 * Sprint 10 attached the consumers — grid subscriptions (ADR-022), the bell, chat and
 * presence — and generalised this from a single /ws/notify singleton to one connection
 * per namespace. Every `// TODO(Sprint 10)` marker in the module grids is now retired.
 */

/**
 * ONE connection per namespace, cached by namespace — NOT a second singleton.
 *
 * Socket.io multiplexes every namespace of the same host over ONE underlying
 * engine.io transport, so `/ws/chat` and `/ws/presence` cost no extra websocket.
 * What must not happen is two managers for the same namespace: each would carry its
 * own handshake, its own reconnection timer, and its own copy of every subscription,
 * so every event would be handled twice.
 *
 * The map is what makes that structurally impossible — getSocket() is the only way
 * in, and it returns the same instance for the same namespace forever.
 */
const sockets = new Map<string, Socket>();

/** The three canonical namespaces (TRD §8). ADR-005: there is no fourth. */
export const WS_NOTIFY = '/ws/notify';
export const WS_CHAT = '/ws/chat';
export const WS_PRESENCE = '/ws/presence';

/** The server handshake (api/src/sockets/index.ts) reads auth.token; the C-05
 *  watcher (socketTokenWatcher.plugin.ts) reads auth.exp and refuses a socket
 *  whose exp is missing or already past — so BOTH must ride the handshake.
 *  expires_at is the token's unix-seconds expiry straight from Supabase. */
async function authPayload(): Promise<{ token: string; exp: number }> {
  const {
    data: { session },
  } = await createClient().auth.getSession();
  return { token: session?.access_token ?? '', exp: session?.expires_at ?? 0 };
}

export function getSocket(namespace: string = WS_NOTIFY): Socket {
  const existing = sockets.get(namespace);
  if (existing) return existing;

  const socket = io(`${process.env.NEXT_PUBLIC_WS_URL}${namespace}`, {
    // A function auth re-reads the session on every (re)connect, so a token
    // refreshed while the socket was down is picked up on the next attempt.
    auth: (cb: (data: { token: string; exp: number }) => void) => {
      void authPayload().then(cb);
    },
    // TRD §8: 1s delay, 30s cap, retry forever.
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    reconnectionAttempts: Infinity,
  });

  // C-05: the server warns ~60s before the JWT expires. Refresh via Supabase and
  // hand the fresh token back on the SAME live socket (emit, not reconnect), so
  // an in-flight bot stream is never dropped.
  socket.on('auth:refresh_required', () => {
    void (async () => {
      const {
        data: { session },
      } = await createClient().auth.refreshSession();
      const token = session?.access_token ?? (await authPayload()).token;
      if (token) socket.emit('auth:refresh', { token });
    })();
  });

  sockets.set(namespace, socket);
  return socket;
}

/**
 * Confirmed room membership — the gate `useRealtimeQuery` fetches behind (ADR-025).
 *
 * ⚠️ `socket.connected` IS NOT SUBSCRIBED. 'connect' fires when the transport is up;
 * the server then joins the socket's rooms, which under the Redis adapter is
 * asynchronous. A consumer that fetches on 'connect' still has a window where
 * broadcasts reach nobody — and because nothing in this app re-fetches a sitting page
 * (`refetchOnWindowFocus: false`, no polling), whatever it misses stays missing for
 * that tab's lifetime.
 *
 * So the client asks and the server ACKS. `subscribed` only goes true on the ack.
 *
 * ONE mechanism for mount AND reconnect: 'disconnect' clears it, 'connect' re-emits.
 * There is deliberately no separate reconnect branch — a second path is how the two
 * drift apart.
 */
export function useSocketRooms(namespace: string = WS_NOTIFY): { subscribed: boolean } {
  const [subscribed, setSubscribed] = useState(false);

  useEffect(() => {
    const socket = getSocket(namespace);
    let cancelled = false;

    const join = (): void => {
      socket.emit('room:join', () => {
        if (!cancelled) setSubscribed(true);
      });
    };

    const onDisconnect = (): void => {
      if (!cancelled) setSubscribed(false);
    };

    socket.on('connect', join);
    socket.on('disconnect', onDisconnect);
    // Already connected when this mounted (the singleton is shared, so this is the
    // common case for every component after the first) — 'connect' will not fire
    // again, so ask now.
    if (socket.connected) join();

    return () => {
      cancelled = true;
      socket.off('connect', join);
      socket.off('disconnect', onDisconnect);
    };
  }, [namespace]);

  return { subscribed };
}

/**
 * Subscribe to an event for the lifetime of the component, sharing the per-namespace
 * connection (never opens a second one). Pass a stable `handler` (useCallback) so the
 * effect does not resubscribe every render.
 */
export function useSocketEvent<T = unknown>(
  namespace: string,
  event: string,
  handler: (payload: T) => void,
): void {
  useEffect(() => {
    const s = getSocket(namespace);
    s.on(event, handler as (payload: unknown) => void);
    return () => {
      s.off(event, handler as (payload: unknown) => void);
    };
  }, [namespace, event, handler]);
}

/** `/ws/notify` — notifications and every grid-sync broadcast. */
export function useNotifySocket<T = unknown>(event: string, handler: (payload: T) => void): void {
  useSocketEvent<T>(WS_NOTIFY, event, handler);
}

/** `/ws/chat` — chat:message, chat:deleted, chat:typing. */
export function useChatSocket<T = unknown>(event: string, handler: (payload: T) => void): void {
  useSocketEvent<T>(WS_CHAT, event, handler);
}

/** `/ws/presence` — presence:changed, and the outbound presence:ping heartbeat. */
export function usePresenceSocket<T = unknown>(event: string, handler: (payload: T) => void): void {
  useSocketEvent<T>(WS_PRESENCE, event, handler);
}

/** Test seam: drop every cached connection so a suite starts clean. */
export function resetSockets(): void {
  for (const s of sockets.values()) s.disconnect();
  sockets.clear();
}
