/**
 * Redis-backed presence (02-TRD §8, 11-THIRD-PARTY-INTEGRATIONS §5).
 *
 * Model: a `presence:{staffId}` key with a 60s TTL. Set on connect, refreshed by
 * a `presence:ping` the client sends every 30s. On disconnect we do NOTHING —
 * the TTL lets the key lapse within 60s, which avoids online/offline flicker on
 * brief network blips (no explicit DEL, ever).
 */
import { logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';

import type { Socket } from 'socket.io';

const PRESENCE_TTL_SECONDS = 60;
const presenceKey = (staffId: string) => `presence:${staffId}`;

/**
 * Wire presence onto a freshly connected /ws/presence socket: mark online, and
 * refresh the TTL on each client heartbeat. Presence is best-effort — a Redis
 * failure is logged, never thrown (11-THIRD-PARTY-INTEGRATIONS §graceful).
 */
export function attachPresence(socket: Socket, staffId: string): void {
  redis
    .set(presenceKey(staffId), '1', 'EX', PRESENCE_TTL_SECONDS)
    .catch((err: unknown) => logger.warn({ err, staffId }, 'presence: set failed'));

  socket.on('presence:ping', () => {
    redis
      .expire(presenceKey(staffId), PRESENCE_TTL_SECONDS)
      .catch((err: unknown) => logger.warn({ err, staffId }, 'presence: expire failed'));
  });

  // No disconnect handler by design — the 60s TTL expires the key naturally.
}

/**
 * The staff ids currently online, read by chat (Sprint 10). Uses SCAN, never
 * KEYS, so it stays non-blocking on a large keyspace.
 */
export async function getOnlineStaffIds(): Promise<string[]> {
  const ids: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'presence:*', 'COUNT', 100);
    cursor = next;
    for (const key of keys) ids.push(key.slice('presence:'.length));
  } while (cursor !== '0');
  return ids;
}
