/**
 * Presence socket wiring (ADR-023, 02-TRD §8).
 *
 * The model lives in services/PresenceService.ts — one `presence` hash, field =
 * staffId, value = last-seen epoch ms, 60s freshness filter, swept on read. This file
 * is only the transport: connect, heartbeat, clean disconnect, and the transition
 * broadcast.
 *
 * `presence:changed` fires on genuine transitions ONLY. PresenceService.markOnline
 * returns whether the field was stale-or-absent, so the heartbeat and the connect are
 * the same call and the "did anything change" test happens once, in one place —
 * rather than a heartbeat handler, a connect handler, and a set-diff each keeping
 * their own copy of it.
 */
import { emitAfterCommit } from '../lib/emit-after-commit.js';
import { logger } from '../lib/logger.js';
import { HEARTBEAT_MS, presenceService } from '../services/PresenceService.js';

import type { Socket } from 'socket.io';

const PRESENCE_NAMESPACE = '/ws/presence';
const ORG_ROOM = 'org:all';

/** Re-exported so the client and the tests read the interval from one place. */
export { HEARTBEAT_MS };

/**
 * Announce a transition to everyone. The payload is a delta — one staff member and
 * their new state — never the whole roster, which is the difference between 2
 * broadcasts a minute and 100.
 */
function broadcastTransition(staffId: string, isOnline: boolean): void {
  emitAfterCommit(PRESENCE_NAMESPACE, ORG_ROOM, 'presence:changed', { staffId, isOnline });
}

/**
 * Wire presence onto a freshly connected /ws/presence socket.
 *
 * Presence is best-effort throughout: a Redis failure is logged, never thrown
 * (11-THIRD-PARTY §graceful). Losing a heartbeat costs at most 60s of accuracy;
 * throwing would cost the socket.
 */
export function attachPresence(socket: Socket, staffId: string): void {
  const online = (): void => {
    presenceService
      .markOnline(staffId)
      .then((transitioned) => {
        if (transitioned) broadcastTransition(staffId, true);
      })
      .catch((err: unknown) => logger.warn({ err, staffId }, 'presence: markOnline failed'));
  };

  // Connect and heartbeat are the same operation — see the module note.
  online();
  socket.on('presence:ping', online);

  socket.on('disconnect', (reason: string) => {
    // CLEAN disconnects only (ADR-023). Socket.io also reports 'transport close' and
    // 'ping timeout' here — a phone locking its screen, a tunnel blipping. HDEL'ing on
    // those is what the pre-ADR code was avoiding by having no disconnect handler at
    // all, and it shows up as presence dots flickering during a meeting. An unclean
    // drop needs no handler: the 60s freshness filter expires them, and if the client
    // reconnects inside the window nobody ever saw them leave.
    if (reason !== 'client namespace disconnect' && reason !== 'server namespace disconnect') {
      return;
    }
    presenceService
      .markOffline(staffId)
      .then((wasPresent) => {
        if (wasPresent) broadcastTransition(staffId, false);
      })
      .catch((err: unknown) => logger.warn({ err, staffId }, 'presence: markOffline failed'));
  });
}
