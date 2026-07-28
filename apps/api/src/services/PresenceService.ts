/**
 * Presence — one Redis hash with heartbeat freshness (ADR-023).
 *
 *   key "presence" (hash) · field = staffId · value = last-seen epoch ms
 *
 * Replaces the per-staff `presence:{staffId}` string keys, whose roster read was a
 * `SCAN` over the keyspace: O(N) across cursor round-trips, no consistency guarantee,
 * and billed per command on Upstash. Harmless at 50 keys, and the wrong primitive at
 * any size. The roster is now one `HGETALL`.
 *
 * THE VALUE IS A TIMESTAMP, NEVER "1". A hash field has no per-field TTL, so the
 * timestamp plus the 60s filter IS the expiry mechanism. Storing "1" would trade a
 * blocking-command problem for a ghost-presence problem — the classic symptom being
 * users who closed their browser still showing online forever.
 *
 * The sweep runs on read, so the hash cannot grow with departed staff. No cron.
 */
import { logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';

/** One hash for the whole roster. */
export const PRESENCE_KEY = 'presence';

/** A field older than this is offline. Twice the heartbeat, so one dropped beat
 *  does not flicker someone offline. */
export const FRESHNESS_MS = 60_000;

/** The client heartbeat interval — half the freshness window (ADR-023). */
export const HEARTBEAT_MS = 30_000;

export class PresenceService {
  /**
   * Mark a staff member online. Called on socket connect AND on every heartbeat —
   * they are the same operation, which is why there is no separate `heartbeat()`.
   *
   * Returns true when this was a genuine offline→online TRANSITION, so the caller
   * broadcasts `presence:changed` only when something actually changed. A 30s beat
   * from 50 users is 100 broadcasts a minute if you skip that check.
   */
  async markOnline(staffId: string): Promise<boolean> {
    const now = Date.now();
    // Read before write: "was this field fresh a moment ago" is the transition test.
    // A missing field is a transition; so is a STALE one — the user went away long
    // enough to be swept and has come back.
    const previous = await redis.hget(PRESENCE_KEY, staffId);
    const wasOnline = previous !== null && now - Number(previous) < FRESHNESS_MS;

    await redis.hset(PRESENCE_KEY, staffId, String(now));
    return !wasOnline;
  }

  /**
   * Mark a staff member offline on a CLEAN disconnect. Returns true if they were
   * actually present, so a duplicate disconnect does not broadcast twice.
   *
   * An unclean disconnect needs no handler — the freshness filter expires them
   * within 60s, which is also what stops a brief network blip from flickering
   * someone offline.
   */
  async markOffline(staffId: string): Promise<boolean> {
    const removed = await redis.hdel(PRESENCE_KEY, staffId);
    return removed > 0;
  }

  /**
   * The staff ids currently online: `HGETALL`, filtered to the freshness window,
   * with expired fields `HDEL`'d in the same pass.
   *
   * The sweep is not housekeeping — without it the hash grows monotonically with
   * every staff member who ever connected, turning a fixed-size key into an
   * unbounded one.
   */
  async getOnline(): Promise<string[]> {
    const all = await redis.hgetall(PRESENCE_KEY);
    const now = Date.now();
    const fresh: string[] = [];
    const expired: string[] = [];

    for (const [staffId, lastSeen] of Object.entries(all)) {
      if (now - Number(lastSeen) < FRESHNESS_MS) fresh.push(staffId);
      else expired.push(staffId);
    }

    if (expired.length > 0) {
      await redis
        .hdel(PRESENCE_KEY, ...expired)
        .catch((err: unknown) => logger.warn({ err, expired }, 'presence: sweep failed'));
    }

    return fresh;
  }

  /**
   * The online subset of `visibleStaffIds` — the only shape a caller should use to
   * answer "who is online" for a specific viewer.
   *
   * ADR-011 applies: a freelancer must not learn about staff they cannot otherwise
   * see, so presence is reported *against a set the caller already fetched and is
   * already authorised for*, never as a standalone directory. Passing the visible
   * ids in makes that structural rather than remembered — there is no overload that
   * returns everyone.
   */
  async getOnlineAmong(visibleStaffIds: readonly string[]): Promise<Set<string>> {
    if (visibleStaffIds.length === 0) return new Set();
    const online = new Set(await this.getOnline());
    return new Set(visibleStaffIds.filter((id) => online.has(id)));
  }
}

/** Shared instance — the service is stateless; all state lives in Redis. */
export const presenceService = new PresenceService();
