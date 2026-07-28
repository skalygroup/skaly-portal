/**
 * Chat socket wiring on the EXISTING /ws/chat namespace (ADR-005 — no fourth
 * namespace; sockets/index.ts already declares /ws/chat, /ws/presence, /ws/notify).
 *
 * Only ONE event originates here: `chat:typing`. `chat:message` and `chat:deleted` are
 * emitted by the REST routes after their transaction commits, because they describe
 * durable state and must not be announced before it exists.
 *
 * Typing is the opposite kind of thing — ephemeral, never persisted, and worthless a
 * second later. It rides the socket directly and touches neither the database nor the
 * emit-after-commit seam.
 */
import { logger } from '../lib/logger.js';

import type { Socket } from 'socket.io';

/** Server-side floor: at most one broadcast per user per window. */
export const TYPING_THROTTLE_MS = 2_000;

const CHAT_ROOM = 'org:all';

/** Last broadcast per staffId. Per-instance by design — see attachChat's note. */
const lastTypingAt = new Map<string, number>();

/**
 * Wire chat onto a freshly connected /ws/chat socket.
 *
 * THROTTLED IN BOTH PLACES. The client throttles to one emit per 2s, and this repeats
 * the check server-side — because a client-only throttle is a request, not a limit,
 * and one open devtools console is enough to flood every connected user.
 *
 * The map is per-instance rather than in Redis: the cost of a duplicate broadcast when
 * two API instances each let one through is a typing dot that flickers, and paying a
 * Redis round trip per keystroke to prevent that is the wrong trade.
 * ponytail: per-instance throttle; move to Redis only if typing broadcasts ever show
 * up in a load profile.
 */
export function attachChat(socket: Socket, staffId: string): void {
  socket.on('chat:typing', (payload: unknown) => {
    const isTyping = typeof payload === 'object' && payload !== null && 'isTyping' in payload
      ? Boolean((payload as { isTyping: unknown }).isTyping)
      : true;

    // A "stopped typing" must always through — it is what clears the indicator, and
    // throttling it away leaves someone permanently "typing…".
    if (isTyping) {
      const now = Date.now();
      const last = lastTypingAt.get(staffId) ?? 0;
      if (now - last < TYPING_THROTTLE_MS) return;
      lastTypingAt.set(staffId, now);
    } else {
      lastTypingAt.delete(staffId);
    }

    // broadcast.to() — everyone in the room EXCEPT this socket. The author knows they
    // are typing; echoing it back is the sender-exclusion rule (ADR-022 rule b) in its
    // simplest form.
    socket.broadcast.to(CHAT_ROOM).emit('chat:typing', { staffId, isTyping });
  });

  socket.on('disconnect', () => {
    // Clear the indicator for anyone still showing it, then drop the throttle entry so
    // the map does not grow with departed staff.
    if (lastTypingAt.delete(staffId)) {
      try {
        socket.broadcast.to(CHAT_ROOM).emit('chat:typing', { staffId, isTyping: false });
      } catch (err) {
        logger.warn({ err, staffId }, 'chat: typing clear on disconnect failed');
      }
    }
  });
}

/** Test seam — the throttle is module state, so a suite must be able to reset it. */
export function resetTypingThrottle(): void {
  lastTypingAt.clear();
}
