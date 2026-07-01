import { createServer } from 'node:http';

import { io as connectClient } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import { getIo, registerSockets } from '../../src/sockets/index.js';

import type { SocketSetup } from '../../src/sockets/index.js';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket as ClientSocket } from 'socket.io-client';

// ── Mocks (declared before importing the module under test) ─────────────────

// Fake ioredis so registerSockets' pub/sub clients (and the lib/redis singleton)
// never dial Upstash. The real Redis adapter still constructs against these
// fakes, and its broadcast() delivers to LOCAL sockets before publishing — so a
// same-instance room round-trip works without any real Redis. We deliberately
// omit pSubscribe so the adapter takes its ioredis code path.
vi.mock('ioredis', () => {
  const make = (): Record<string, unknown> => ({
    on: vi.fn(),
    off: vi.fn(),
    psubscribe: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => undefined),
    punsubscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    publish: vi.fn(async () => 0),
    set: vi.fn(async () => 'OK'),
    expire: vi.fn(async () => 1),
    scan: vi.fn(async () => ['0', []]),
    duplicate: vi.fn(() => make()),
  });
  const Redis = vi.fn(() => make());
  return { Redis, default: Redis };
});

// Stub the shared verifier: 'valid-token' → an active admin; anything else fails.
const STAFF_ID = 'staff-123';
vi.mock('../../src/lib/auth-verify.js', () => ({
  verifySupabaseToken: vi.fn(async (token: string) => {
    if (token === 'valid-token') {
      return {
        id: STAFF_ID,
        supabase_uid: 'uid-123',
        name: 'Test User',
        email: 'test@skaly.in',
        role: 'admin',
        active: true,
        mfa_enrolled: true,
        avatar_url: null,
      };
    }
    throw new Error('invalid token');
  }),
}));



let httpServer: HttpServer;
let setup: SocketSetup;
let port: number;
const clients: ClientSocket[] = [];

function connect(token: string): ClientSocket {
  const exp = Math.floor(Date.now() / 1000) + 3600; // token watcher reads exp
  const client = connectClient(`http://localhost:${port}/ws/notify`, {
    auth: { token, exp },
    transports: ['websocket'],
    reconnection: false,
  });
  clients.push(client);
  return client;
}

beforeAll(async () => {
  httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as AddressInfo).port;
  setup = registerSockets(httpServer);
});

afterEach(() => {
  for (const c of clients) c.disconnect();
  clients.length = 0;
});

afterAll(async () => {
  setup.io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('Socket.io /ws/notify handshake', () => {
  test('a valid token connects and is joined to user:{staffId}', async () => {
    const client = connect('valid-token');

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', (err) => reject(err));
      setTimeout(() => reject(new Error('connect timeout')), 4000);
    });

    // Prove the room join by broadcasting to it and receiving on the client.
    const received = new Promise<unknown>((resolve) => client.on('grid:update', resolve));
    // Small tick so the server-side connection handler's join has committed.
    await new Promise((r) => setTimeout(r, 50));
    getIo().of('/ws/notify').to(`user:${STAFF_ID}`).emit('grid:update', { ok: true });

    await expect(received).resolves.toEqual({ ok: true });
  });

  test('an invalid token is rejected', async () => {
    const client = connect('bad-token');

    const err = await new Promise<Error>((resolve, reject) => {
      client.on('connect_error', (e) => resolve(e as Error));
      client.on('connect', () => reject(new Error('should not have connected')));
      setTimeout(() => reject(new Error('no connect_error within timeout')), 4000);
    });

    expect(err.message).toBe('UNAUTHORIZED');
  });
});