import { createServer } from 'node:http';

import { io as connectClient } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket as ClientSocket } from 'socket.io-client';

/**
 * presence:changed on /ws/presence (Sprint 10 STEP 3, ADR-023).
 *
 * PresenceService.test.ts proves the TRANSITION FLAG — markOnline returns true only
 * when the field was absent or stale. This proves the wiring actually uses it: that a
 * connect broadcasts, and that a heartbeat which changes nothing broadcasts NOTHING.
 *
 * Those are different claims. A correct flag consumed by a handler that emits
 * unconditionally passes every service test and still puts 100 broadcasts a minute on
 * the wire from 50 idle users.
 *
 * Redis is faked with a real in-memory hash so the freshness/transition logic runs for
 * real — a mock returning null for every hget would report every beat as a transition
 * and the key assertion here would pass vacuously.
 */
const hash = new Map<string, string>();

vi.mock('ioredis', () => {
  const make = (): Record<string, unknown> => ({
    on: vi.fn(),
    off: vi.fn(),
    psubscribe: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => undefined),
    punsubscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    publish: vi.fn(async () => 0),
    // A real hash, so freshness comparisons are genuine.
    hset: vi.fn(async (_k: string, f: string, v: string) => {
      const isNew = !hash.has(f);
      hash.set(f, v);
      return isNew ? 1 : 0;
    }),
    hget: vi.fn(async (_k: string, f: string) => hash.get(f) ?? null),
    hgetall: vi.fn(async () => Object.fromEntries(hash)),
    hdel: vi.fn(async (_k: string, ...fields: string[]) => {
      let n = 0;
      for (const f of fields) if (hash.delete(f)) n += 1;
      return n;
    }),
    del: vi.fn(async () => 1),
    quit: vi.fn(async () => 'OK'),
    duplicate: vi.fn(() => make()),
  });
  const Redis = vi.fn(() => make());
  return { Redis, default: Redis };
});

vi.mock('../../src/lib/auth-verify.js', () => ({
  verifySupabaseToken: vi.fn(async (token: string) => {
    const id = token.replace('token-', '');
    return {
      id,
      supabase_uid: `uid-${id}`,
      name: id,
      email: `${id}@skaly.in`,
      role: 'team_member',
      active: true,
      mfa_enrolled: false,
      avatar_url: null,
    };
  }),
}));

const { registerSockets } = await import('../../src/sockets/index.js');

let httpServer: HttpServer;
let url: string;
let teardown: () => void;
const clients: ClientSocket[] = [];

function connect(staffId: string): Promise<ClientSocket> {
  const socket = connectClient(`${url}/ws/presence`, {
    auth: { token: `token-${staffId}`, exp: Math.floor(Date.now() / 1000) + 3600 },
    transports: ['websocket'],
    reconnection: false,
  });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

function collect(socket: ClientSocket, ms = 200): Promise<{ staffId: string; isOnline: boolean }[]> {
  const seen: { staffId: string; isOnline: boolean }[] = [];
  socket.on('presence:changed', (p: { staffId: string; isOnline: boolean }) => seen.push(p));
  return new Promise((resolve) => setTimeout(() => resolve(seen), ms));
}

beforeAll(async () => {
  httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
  const { io, pubClient, subClient } = registerSockets(httpServer);
  teardown = () => {
    void io.close();
    void pubClient.quit?.();
    void subClient.quit?.();
  };
});

afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect();
  hash.clear();
});

afterAll(async () => {
  teardown();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('presence:changed', () => {
  test('a connect announces the new arrival to everyone else', async () => {
    const observer = await connect('watcher-1');
    const received = collect(observer);

    await connect('arriving-1');

    expect(await received).toEqual([{ staffId: 'arriving-1', isOnline: true }]);
  });

  test('⭐ a heartbeat that changes nothing broadcasts NOTHING', async () => {
    const observer = await connect('watcher-2');
    const beater = await connect('beater-2');
    // Let the connect transition land before we start listening.
    await new Promise((r) => setTimeout(r, 100));

    const received = collect(observer, 250);
    for (let i = 0; i < 10; i++) beater.emit('presence:ping');

    // Already online and still fresh — nothing changed, so nothing goes on the wire.
    // A handler emitting unconditionally would put 10 broadcasts here, and 100 a
    // minute from 50 idle users.
    expect(await received).toEqual([]);
  });

  test('the hash records the heartbeat even though it does not broadcast', async () => {
    const beater = await connect('beater-3');
    await new Promise((r) => setTimeout(r, 80));

    const before = hash.get('beater-3');
    await new Promise((r) => setTimeout(r, 20));
    beater.emit('presence:ping');
    await new Promise((r) => setTimeout(r, 80));

    // Silent on the wire, still refreshing the freshness window — which is the whole
    // point of a heartbeat.
    expect(hash.get('beater-3')).not.toBe(before);
  });

  test('a clean disconnect announces the departure', async () => {
    const observer = await connect('watcher-4');
    const leaver = await connect('leaver-4');
    await new Promise((r) => setTimeout(r, 100));

    const received = collect(observer, 250);
    leaver.disconnect();

    expect(await received).toEqual([{ staffId: 'leaver-4', isOnline: false }]);
  });

  test('the arrival does not receive its own presence:changed', async () => {
    await connect('watcher-5');
    const arriving = await connect('arriving-5');
    const ownEvents = collect(arriving, 200);

    // Nothing further should reach the arriving socket about itself.
    expect((await ownEvents).filter((e) => e.staffId === 'arriving-5')).toEqual([]);
  });
});
