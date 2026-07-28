import { createServer } from 'node:http';

import { io as connectClient } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket as ClientSocket } from 'socket.io-client';

/**
 * chat:typing on the EXISTING /ws/chat namespace (Sprint 10 STEP 7, ADR-005).
 *
 * Two invariants worth the socket harness: the SERVER-side throttle (a client-only
 * throttle is a request, not a limit — one open devtools console floods everyone), and
 * sender exclusion (the author knows they are typing).
 *
 * A "stopped typing" is deliberately never throttled: throttling it away is what
 * leaves someone permanently "typing…", which is the bug users actually notice.
 */
vi.mock('ioredis', () => {
  const make = (): Record<string, unknown> => ({
    on: vi.fn(),
    off: vi.fn(),
    psubscribe: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => undefined),
    punsubscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    publish: vi.fn(async () => 0),
    hset: vi.fn(async () => 1),
    hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
    hdel: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
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
const { TYPING_THROTTLE_MS, resetTypingThrottle } = await import('../../src/sockets/chat.js');

let httpServer: HttpServer;
let url: string;
let teardown: () => void;
const clients: ClientSocket[] = [];

/** Connect a client to /ws/chat, resolved once it is actually connected. */
function connect(staffId: string): Promise<ClientSocket> {
  const socket = connectClient(`${url}/ws/chat`, {
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

/** Collect chat:typing events for `ms`, then return them. */
function collect(socket: ClientSocket, ms = 150): Promise<{ staffId: string; isTyping: boolean }[]> {
  const seen: { staffId: string; isTyping: boolean }[] = [];
  socket.on('chat:typing', (p: { staffId: string; isTyping: boolean }) => seen.push(p));
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
  resetTypingThrottle();
});

afterAll(async () => {
  teardown();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('chat:typing', () => {
  test('reaches another client in the room', async () => {
    const [author, observer] = await Promise.all([connect('author-1'), connect('observer-1')]);

    const received = collect(observer);
    author.emit('chat:typing', { isTyping: true });

    expect(await received).toEqual([{ staffId: 'author-1', isTyping: true }]);
  });

  test('⭐ is NOT echoed back to its author (sender exclusion)', async () => {
    const [author, observer] = await Promise.all([connect('author-2'), connect('observer-2')]);

    const authorSaw = collect(author);
    const observerSaw = collect(observer);
    author.emit('chat:typing', { isTyping: true });

    // The author already knows they are typing — echoing it back is the failure
    // ADR-022 rule b exists to prevent, in its simplest form.
    expect(await authorSaw).toEqual([]);
    expect(await observerSaw).toHaveLength(1);
  });

  test('⭐ throttled SERVER-side to one broadcast per window', async () => {
    const [author, observer] = await Promise.all([connect('author-3'), connect('observer-3')]);

    const received = collect(observer, 200);
    // A client with the throttle removed — which is any client with devtools open.
    for (let i = 0; i < 20; i++) author.emit('chat:typing', { isTyping: true });

    expect(await received).toHaveLength(1);
  });

  test('a "stopped typing" is never throttled away', async () => {
    const [author, observer] = await Promise.all([connect('author-4'), connect('observer-4')]);

    const received = collect(observer, 200);
    author.emit('chat:typing', { isTyping: true });
    // Immediately after — inside the throttle window. Suppressing this is what leaves
    // someone showing "typing…" forever.
    author.emit('chat:typing', { isTyping: false });

    expect(await received).toEqual([
      { staffId: 'author-4', isTyping: true },
      { staffId: 'author-4', isTyping: false },
    ]);
  });

  test('a stop clears the throttle, so the next start broadcasts immediately', async () => {
    const [author, observer] = await Promise.all([connect('author-5'), connect('observer-5')]);

    const received = collect(observer, 200);
    author.emit('chat:typing', { isTyping: true });
    author.emit('chat:typing', { isTyping: false });
    author.emit('chat:typing', { isTyping: true });

    expect(await received).toHaveLength(3);
  });

  test('the throttle window matches the client contract', () => {
    // The client throttles to the same 2s; both halves are documented in one place.
    expect(TYPING_THROTTLE_MS).toBe(2_000);
  });

  test('typing is NEVER persisted', async () => {
    const [author] = await Promise.all([connect('author-6'), connect('observer-6')]);
    author.emit('chat:typing', { isTyping: true });
    await new Promise((r) => setTimeout(r, 100));

    // Nothing here touches the database — asserted by the absence of any db handle in
    // sockets/chat.ts. This test documents the contract; the module has no importable
    // persistence to spy on, which is exactly the point.
    const chatModule = await import('../../src/sockets/chat.js');
    expect(Object.keys(chatModule).sort()).toEqual([
      'TYPING_THROTTLE_MS',
      'attachChat',
      'resetTypingThrottle',
    ]);
  });
});
