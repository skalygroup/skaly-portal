import type { Server, Socket } from 'socket.io';
import { logger } from '../lib/logger.js';

/**
 * WebSocket JWT refresh protocol (C-05).
 *
 * Tracks JWT expiry per socket connection and:
 * 1. At exp - 60s: emits auth:refresh_required
 * 2. At exp + 30s: force-disconnects if no refresh received
 * 3. On auth:refresh: validates new token exp, resets timers
 *
 * Full JWT signature verification is deferred to Sprint 1's auth plugin.
 * This watcher only checks the exp claim for timer management.
 */

interface SocketTimers {
  warningTimer: ReturnType<typeof setTimeout> | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

const EXPIRY_WARNING_SECONDS = 60; // emit refresh_required 60s before expiry
const GRACE_SECONDS = 30; // disconnect 30s after expiry if no refresh

/**
 * Decodes a JWT payload without signature verification.
 * Used only for reading the exp claim — actual auth verification
 * is handled by the auth plugin in Sprint 1.
 */
function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

function scheduleTimers(
  socket: Socket,
  exp: number,
  timers: SocketTimers,
): void {
  // Clear any existing timers
  if (timers.warningTimer) clearTimeout(timers.warningTimer);
  if (timers.disconnectTimer) clearTimeout(timers.disconnectTimer);

  const nowSec = Math.floor(Date.now() / 1000);

  // Schedule warning at exp - 60s
  const msUntilWarning = Math.max(0, (exp - EXPIRY_WARNING_SECONDS - nowSec) * 1000);
  timers.warningTimer = setTimeout(() => {
    socket.emit('auth:refresh_required', {
      message: 'Your session token is expiring soon. Please refresh.',
      expiresAt: new Date(exp * 1000).toISOString(),
    });
  }, msUntilWarning);

  // Schedule hard disconnect at exp + 30s
  const msUntilDisconnect = Math.max(0, (exp + GRACE_SECONDS - nowSec) * 1000);
  timers.disconnectTimer = setTimeout(() => {
    logger.info(
      { socketId: socket.id },
      'Socket token expired without refresh — disconnecting',
    );
    socket.emit('auth:token_expired', {
      message: 'Session expired. Please re-authenticate.',
    });
    socket.disconnect(true);
  }, msUntilDisconnect);
}

export function setupSocketTokenWatcher(io: Server): void {
  io.on('connection', (socket: Socket) => {
    const exp = socket.handshake.auth?.exp as number | undefined;
    const nowSec = Math.floor(Date.now() / 1000);

    // If exp missing or already in the past, disconnect immediately
    if (typeof exp !== 'number' || exp <= nowSec) {
      logger.warn(
        { socketId: socket.id, exp },
        'Socket connected with missing or expired token — disconnecting',
      );
      socket.disconnect(true);
      return;
    }

    const timers: SocketTimers = {
      warningTimer: null,
      disconnectTimer: null,
    };

    // Schedule initial timers
    scheduleTimers(socket, exp, timers);

    // Handle token refresh from client
    socket.on('auth:refresh', (data: { token: string }, ack?: (resp: { ok: boolean; message?: string }) => void) => {
      if (!data?.token || typeof data.token !== 'string') {
        ack?.({ ok: false, message: 'Token is required' });
        return;
      }

      const newExp = decodeJwtExp(data.token);
      if (newExp === null || newExp <= Math.floor(Date.now() / 1000)) {
        ack?.({ ok: false, message: 'Token is expired or invalid' });
        return;
      }

      // Replace exp in handshake auth and reschedule timers
      socket.handshake.auth.exp = newExp;
      scheduleTimers(socket, newExp, timers);

      logger.info(
        { socketId: socket.id, newExp },
        'Socket token refreshed successfully',
      );

      socket.emit('auth:refreshed', {
        expiresAt: new Date(newExp * 1000).toISOString(),
      });
      ack?.({ ok: true });
    });

    // Clean up timers on disconnect
    socket.on('disconnect', () => {
      if (timers.warningTimer) clearTimeout(timers.warningTimer);
      if (timers.disconnectTimer) clearTimeout(timers.disconnectTimer);
    });
  });
}
