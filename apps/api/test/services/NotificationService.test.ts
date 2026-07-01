import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { io as connectClient } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import { NotificationService } from '../../src/services/NotificationService.js';
import { registerSockets } from '../../src/sockets/index.js';

import type { SocketSetup } from '../../src/sockets/index.js';
import type { DB } from '@skaly/shared';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket as ClientSocket } from 'socket.io-client';

// The recipient's staff id doubles as the authenticated socket user, so the
// client joins user:{RECIPIENT_ID} and receives its own notifications.
const RECIPIENT_ID = randomUUID();

// Fake ioredis (no Upstash); the real adapter delivers locally. See connect.test.
vi.mock('ioredis', () => {
  const make = (): Record<string, unknown> => ({
    on: vi.fn(),
    off: vi.fn(),
    psubscribe: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => undefined),
    punsubscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    publish: vi.fn(async () => 0),
    duplicate: vi.fn(() => make()),
  });
  const Redis = vi.fn(() => make());
  return { Redis, default: Redis };
});

// Socket handshake resolves to the recipient so it joins user:{RECIPIENT_ID}.
vi.mock('../../src/lib/auth-verify.js', () => ({
  verifySupabaseToken: vi.fn(async (token: string) => {
    if (token === 'valid-token') {
      return {
        id: RECIPIENT_ID,
        supabase_uid: 'uid-1',
        name: 'Recipient',
        email: 'r@skaly.in',
        role: 'admin',
        active: true,
        mfa_enrolled: true,
        avatar_url: null,
      };
    }
    throw new Error('invalid token');
  }),
}));

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const notifications = new NotificationService();

const DOMAIN = '@notif.itest';
let httpServer: HttpServer;
let setup: SocketSetup;
let port: number;
const clients: ClientSocket[] = [];

async function cleanup() {
  await db.deleteFrom('notifications').where('staff_id', '=', RECIPIENT_ID).execute();
  await db.deleteFrom('staff').where('email', 'like', `%${DOMAIN}`).execute();
}

beforeAll(async () => {
  await cleanup();
  await db
    .insertInto('staff')
    .values({ id: RECIPIENT_ID, name: 'Recipient', email: `r-${RECIPIENT_ID}${DOMAIN}`, role: 'admin', active: true })
    .execute();

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
  await cleanup();
  setup.io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await db.destroy();
});

function connectNotifyClient(): ClientSocket {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const client = connectClient(`http://localhost:${port}/ws/notify`, {
    auth: { token: 'valid-token', exp },
    transports: ['websocket'],
    reconnection: false,
  });
  clients.push(client);
  return client;
}

describe('NotificationService.create', () => {
  test('writes a notifications row with mapped columns', async () => {
    const row = await notifications.create({
      recipientId: RECIPIENT_ID,
      type: 'signup_approved',
      title: 'Approved',
      body: 'Welcome aboard',
      data: { resetLink: 'https://x/reset' },
      trx: db,
    });

    const stored = await db
      .selectFrom('notifications')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(stored.staff_id).toBe(RECIPIENT_ID);
    expect(stored.type).toBe('signup_approved');
    expect(stored.title).toBe('Approved');
    expect(stored.message).toBe('Welcome aboard');
    expect(stored.payload).toEqual({ resetLink: 'https://x/reset' });
    expect(stored.is_read).toBe(false);
  });

  test('emits notify:new to user:{recipientId} on /ws/notify', async () => {
    const client = connectNotifyClient();
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', reject);
      setTimeout(() => reject(new Error('connect timeout')), 4000);
    });
    await new Promise((r) => setTimeout(r, 50)); // let the server-side join commit

    const received = new Promise<Record<string, unknown>>((resolve) =>
      client.on('notify:new', (n: Record<string, unknown>) => resolve(n)),
    );
    const row = await notifications.create({
      recipientId: RECIPIENT_ID,
      type: 'signup_request',
      title: 'New request',
      data: { requestId: 'req-1' },
      trx: db,
    });

    const payload = await received;
    expect(payload.id).toBe(row.id);
    expect(payload.type).toBe('signup_request');
    expect(payload.staff_id).toBe(RECIPIENT_ID);
    expect(payload.payload).toEqual({ requestId: 'req-1' });
  });

  test('rejects an unknown type with VALIDATION_ERROR and writes nothing', async () => {
    const before = await db
      .selectFrom('notifications')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('staff_id', '=', RECIPIENT_ID)
      .executeTakeFirstOrThrow();

    await expect(
      notifications.create({
        recipientId: RECIPIENT_ID,
        type: 'not_a_real_type' as never,
        title: 'x',
        trx: db,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });

    const after = await db
      .selectFrom('notifications')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('staff_id', '=', RECIPIENT_ID)
      .executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n));
  });

  test('a signup_rejected notification carries the public message, never rejection_note', async () => {
    const row = await notifications.create({
      recipientId: RECIPIENT_ID,
      type: 'signup_rejected',
      title: 'Update on your request',
      data: { publicRejectionMessage: 'Thanks for applying.' },
      trx: db,
    });

    const stored = await db
      .selectFrom('notifications')
      .select('payload')
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(stored.payload).toEqual({ publicRejectionMessage: 'Thanks for applying.' });
    expect(JSON.stringify(stored.payload)).not.toContain('rejection_note');
    expect(JSON.stringify(stored.payload)).not.toContain('rejectionNote');
  });
});