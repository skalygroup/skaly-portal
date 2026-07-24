'use client';

import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';

import { createClient } from '@/lib/supabase/client';

/**
 * The shared /ws/notify client — ONE connection per tab (ADR-010 amendment,
 * minimal scope). Sprint 8 builds only:
 *   - the connection (with the TRD §8 reconnection policy),
 *   - the C-05 refresh handshake (a 1-hour JWT expires mid-conversation and would
 *     otherwise drop the bot socket), and
 *   - the ability to subscribe (the bot chat consumes bot:token / bot:message).
 *
 * Sprint 10 attaches grid subscriptions + the bell/notification UI here; this
 * file is the shared client and the // TODO(Sprint 10) markers in the modules
 * stay valid.
 */

let socket: Socket | null = null;

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

export function getSocket(): Socket {
  if (socket) return socket;

  socket = io(`${process.env.NEXT_PUBLIC_WS_URL}/ws/notify`, {
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
      if (token) socket?.emit('auth:refresh', { token });
    })();
  });

  return socket;
}

/** Subscribe to a /ws/notify event for the lifetime of the component, sharing the
 *  singleton (never opens a second connection). Pass a stable `handler`
 *  (useCallback) so the effect doesn't resubscribe every render. */
export function useNotifySocket<T = unknown>(event: string, handler: (payload: T) => void): void {
  useEffect(() => {
    const s = getSocket();
    s.on(event, handler as (payload: unknown) => void);
    return () => {
      s.off(event, handler as (payload: unknown) => void);
    };
  }, [event, handler]);
}
