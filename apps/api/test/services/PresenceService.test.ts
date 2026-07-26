import { Redis } from 'ioredis';
import { describe, test, expect, beforeEach, afterAll, vi } from 'vitest';

import {
  FRESHNESS_MS,
  HEARTBEAT_MS,
  PRESENCE_KEY,
  PresenceService,
} from '../../src/services/PresenceService.js';

/**
 * ADR-023 — presence as one hash with heartbeat freshness.
 *
 * The two assertions that matter most are the pair in "a stale field": it must be
 * BOTH excluded from the roster AND removed from the hash. Excluding without sweeping
 * leaves the hash growing forever with departed staff; sweeping without excluding
 * would report ghosts. A hash field has no per-field TTL, so those two behaviours
 * together ARE the expiry mechanism the old per-key TTL gave for free.
 */
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const svc = new PresenceService();

const A = 'presence-staff-a';
const B = 'presence-staff-b';
const C = 'presence-staff-c';

beforeEach(async () => {
  await redis.del(PRESENCE_KEY);
  vi.useRealTimers();
});

afterAll(async () => {
  await redis.del(PRESENCE_KEY);
  await redis.quit();
});

describe('the model', () => {
  test('markOnline then getOnline includes the staffId', async () => {
    await svc.markOnline(A);
    await expect(svc.getOnline()).resolves.toEqual([A]);
  });

  test('the stored value is a TIMESTAMP, never "1" — that is what makes expiry work', async () => {
    const before = Date.now();
    await svc.markOnline(A);
    const raw = await redis.hget(PRESENCE_KEY, A);

    expect(raw).not.toBe('1');
    const stored = Number(raw);
    expect(Number.isNaN(stored)).toBe(false);
    expect(stored).toBeGreaterThanOrEqual(before);
    expect(stored).toBeLessThanOrEqual(Date.now());
  });

  test('it is ONE hash, not a key per staff member', async () => {
    await svc.markOnline(A);
    await svc.markOnline(B);

    expect(await redis.type(PRESENCE_KEY)).toBe('hash');
    expect(await redis.hlen(PRESENCE_KEY)).toBe(2);
    // The retired per-staff keys must not come back.
    expect(await redis.exists(`presence:${A}`)).toBe(0);
  });

  test('⭐ a field older than the window is excluded AND swept from the hash', async () => {
    // Write a last-seen just past the freshness window, as an absent user would leave.
    await redis.hset(PRESENCE_KEY, A, String(Date.now() - FRESHNESS_MS - 1_000));
    await svc.markOnline(B);

    const online = await svc.getOnline();

    // The filter.
    expect(online).toEqual([B]);
    // The sweep — assert separately: excluding without removing grows the hash
    // forever with everyone who ever connected.
    expect(await redis.hexists(PRESENCE_KEY, A)).toBe(0);
    expect(await redis.hlen(PRESENCE_KEY)).toBe(1);
  });

  test('a heartbeat inside the window keeps the user online', async () => {
    // Just inside the window — stale enough that a missed beat would drop them.
    await redis.hset(PRESENCE_KEY, A, String(Date.now() - FRESHNESS_MS + 5_000));
    await svc.markOnline(A);

    await expect(svc.getOnline()).resolves.toEqual([A]);
  });

  test('the heartbeat is half the freshness window, so one dropped beat cannot flicker', () => {
    expect(HEARTBEAT_MS * 2).toBe(FRESHNESS_MS);
  });

  test('markOffline removes immediately', async () => {
    await svc.markOnline(A);
    await svc.markOffline(A);

    await expect(svc.getOnline()).resolves.toEqual([]);
    expect(await redis.hexists(PRESENCE_KEY, A)).toBe(0);
  });

  test('getOnline on an empty hash is empty, not an error', async () => {
    await expect(svc.getOnline()).resolves.toEqual([]);
  });
});

describe('transitions — presence:changed fires only when something changed', () => {
  test('the first markOnline is a transition', async () => {
    await expect(svc.markOnline(A)).resolves.toBe(true);
  });

  test('⭐ a heartbeat that changes nothing is NOT a transition', async () => {
    await svc.markOnline(A);
    // The heartbeat is the same call as connect — it must not re-announce.
    await expect(svc.markOnline(A)).resolves.toBe(false);
    await expect(svc.markOnline(A)).resolves.toBe(false);
  });

  test('coming back after being swept IS a transition', async () => {
    await redis.hset(PRESENCE_KEY, A, String(Date.now() - FRESHNESS_MS - 1_000));
    // Stale means they were shown offline, so returning is a genuine change.
    await expect(svc.markOnline(A)).resolves.toBe(true);
  });

  test('markOffline is a transition only when they were present', async () => {
    await svc.markOnline(A);
    await expect(svc.markOffline(A)).resolves.toBe(true);
    // A duplicate disconnect must not broadcast a second time.
    await expect(svc.markOffline(A)).resolves.toBe(false);
  });
});

describe('ADR-011 — presence is scoped to what the caller can already see', () => {
  test('getOnlineAmong returns only the intersection', async () => {
    await svc.markOnline(A);
    await svc.markOnline(B);
    await svc.markOnline(C);

    // A freelancer whose visible set is just themselves and one other.
    const visible = await svc.getOnlineAmong([A, B]);

    expect([...visible].sort()).toEqual([A, B].sort());
    expect(visible.has(C)).toBe(false);
  });

  test('an empty visible set returns empty without consulting Redis', async () => {
    await svc.markOnline(A);
    await expect(svc.getOnlineAmong([])).resolves.toEqual(new Set());
  });

  test('a visible id who is offline is absent', async () => {
    await svc.markOnline(A);
    const visible = await svc.getOnlineAmong([A, B]);
    expect(visible.has(A)).toBe(true);
    expect(visible.has(B)).toBe(false);
  });
});
