import { createServer } from 'node:http';

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { io as connectClient } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type { DB } from '@skaly/shared';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket as ClientSocket } from 'socket.io-client';

// ── Mocks (declared before importing the module under test) ─────────────────
// Fake ioredis so the socket adapter + lib/redis never dial Upstash; the real
// adapter still delivers to LOCAL sockets, so a same-instance org:all round-trip
// works without real Redis.
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

// The socket handshake token → an active user (its id is the socket identity for
// room joins; every authed socket also joins org:all — the room we assert on).
vi.mock('../../src/lib/auth-verify.js', () => ({
  verifySupabaseToken: vi.fn(async (token: string) => {
    if (token === 'valid-token') {
      return {
        id: 'ws-listener-1',
        supabase_uid: 'uid-ws-1',
        name: 'WS Listener',
        email: 'ws@skaly.in',
        role: 'admin',
        active: true,
        mfa_enrolled: true,
        avatar_url: null,
      };
    }
    throw new Error('invalid token');
  }),
}));

// Imported AFTER the mocks so registerSockets/HolidayService bind to them.
const { registerSockets } = await import('../../src/sockets/index.js');
const { HolidayService } = await import('../../src/services/HolidayService.js');

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const svc = new HolidayService();

const PERIOD = '2000-09';
const CREATE_DATE = '2000-09-15';
const REMOVE_DATE = '2000-09-20'; // distinct date → no (period, date) unique clash
const DOMAIN = '@holidaybroadcast.itest';
// Persistent fixture actor (create/remove audit → append-only audit_log FK).
const ACTOR_ID = 'd0000000-0000-4000-8000-00000000d001';
const currentUser: CurrentUser = { staffId: ACTOR_ID, role: 'admin' };

let httpServer: HttpServer;
let setup: Awaited<ReturnType<typeof registerSockets>>;
let port: number;
const clients: ClientSocket[] = [];

/** Connect a client to /ws/notify and wait until it is joined (org:all). */
async function connectNotify(): Promise<ClientSocket> {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const client = connectClient(`http://localhost:${port}/ws/notify`, {
    auth: { token: 'valid-token', exp },
    transports: ['websocket'],
    reconnection: false,
  });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.on('connect', () => resolve());
    client.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 4000);
  });
  await new Promise((r) => setTimeout(r, 50)); // let the server-side join commit
  return client;
}

beforeAll(async () => {
  httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as AddressInfo).port;
  setup = registerSockets(httpServer);

  await db
    .insertInto('staff')
    .values({ id: ACTOR_ID, name: 'Broadcast Actor', email: `actor-${ACTOR_ID}${DOMAIN}`, role: 'admin', active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();
  await db.deleteFrom('holidays').where('period', '=', PERIOD).execute();
});

afterAll(async () => {
  for (const c of clients) c.disconnect();
  await db.deleteFrom('holidays').where('period', '=', PERIOD).execute();
  setup.io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await db.destroy();
});

describe('holiday broadcasts reach org:all over the wire', () => {
  test('create → client receives attendance:holiday_added { period, date, name }', async () => {
    const client = await connectNotify();
    const received = new Promise<Record<string, unknown>>((resolve) =>
      client.on('attendance:holiday_added', resolve),
    );

    await db
      .transaction()
      .execute((trx) =>
        svc.create({ period: PERIOD, date: CREATE_DATE, name: 'Broadcast Day', currentUser, trx }),
      );

    await expect(received).resolves.toEqual({
      period: PERIOD,
      date: CREATE_DATE,
      name: 'Broadcast Day',
    });
  });

  test('remove → client receives attendance:holiday_removed { period, date }', async () => {
    // Seed an active holiday (on its own date) to remove.
    const { id: holidayId } = await db
      .insertInto('holidays')
      .values({ period: PERIOD, date: REMOVE_DATE, name: 'ToRemove', active: true, added_by: ACTOR_ID })
      .returning('id')
      .executeTakeFirstOrThrow();

    const client = await connectNotify();
    const received = new Promise<Record<string, unknown>>((resolve) =>
      client.on('attendance:holiday_removed', resolve),
    );

    await db.transaction().execute((trx) => svc.remove(holidayId, currentUser, trx));

    await expect(received).resolves.toEqual({ period: PERIOD, date: REMOVE_DATE });
  });
});
