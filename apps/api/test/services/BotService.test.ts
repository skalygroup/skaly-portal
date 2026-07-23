import { Redis } from 'ioredis';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';

import { BotService } from '../../src/services/BotService.js';

import type Anthropic from '@anthropic-ai/sdk';
import type { DB } from '@skaly/shared';
import type { Server } from 'socket.io';

// STEP 3 smoke: the two-call tool loop end-to-end with a MOCKED Anthropic stream
// (no real API). Phase 1 returns a list_tasks tool_use; phase 2 streams the final
// answer. Asserts the bot:token/bot:message shape, the card, and archival. The
// full permission-filter + parity suite is STEP 5.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const ADMIN = 'e1000000-0000-4000-8000-00000000e101';

// ── Mock io: capture every emit ─────────────────────────────────────────────
interface Emitted {
  event: string;
  payload: Record<string, unknown>;
}
function mockIo(sink: Emitted[]): Server {
  return {
    of: () => ({
      to: () => ({
        emit: (event: string, payload: Record<string, unknown>) => {
          sink.push({ event, payload });
        },
      }),
    }),
  } as unknown as Server;
}

// ── Mock Anthropic stream: fires text events during finalMessage() ──────────
function fakeStream(textChunks: string[], final: Anthropic.Message) {
  let cb: ((t: string) => void) | undefined;
  return {
    on(event: string, handler: (t: string) => void) {
      if (event === 'text') cb = handler;
      return this;
    },
    async finalMessage() {
      for (const c of textChunks) cb?.(c);
      return final;
    },
  };
}

const asMessage = (content: unknown[], stopReason: string): Anthropic.Message =>
  ({
    id: 'msg_x',
    type: 'message',
    role: 'assistant',
    model: 'test',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) as unknown as Anthropic.Message;

/** Anthropic client that returns a list_tasks tool_use, then the final answer. */
function mockAnthropic(): Anthropic {
  let call = 0;
  return {
    messages: {
      stream: () => {
        call += 1;
        if (call === 1) {
          return fakeStream(
            [],
            asMessage(
              [{ type: 'tool_use', id: 'toolu_1', name: 'list_tasks', input: { period: '2099-01' } }],
              'tool_use',
            ),
          );
        }
        return fakeStream(['Here are ', 'your tasks.'], asMessage([{ type: 'text', text: 'Here are your tasks.' }], 'end_turn'));
      },
    },
  } as unknown as Anthropic;
}

async function cleanup(): Promise<void> {
  await db.deleteFrom('messages').where('sender_id', '=', ADMIN).execute();
  await redis.del(`bot:session:${ADMIN}`);
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values({ id: ADMIN, name: 'Bot Admin', email: `bot-${ADMIN}@bot.itest`, role: 'admin', active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await cleanup();
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await redis.quit();
  await db.destroy();
});

describe('BotService.handleMessage — list_tasks smoke (mocked Anthropic)', () => {
  test('runs the two-call loop and emits bot:token then a terminal bot:message with the card', async () => {
    const emitted: Emitted[] = [];
    const svc = new BotService(mockAnthropic(), redis, mockIo(emitted));

    await svc.handleMessage({ staffId: ADMIN, role: 'admin', userText: 'list my tasks', db });

    const tokens = emitted.filter((e) => e.event === 'bot:token');
    const terminals = emitted.filter((e) => e.event === 'bot:message');

    // Streamed deltas arrived as bot:token…
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.map((t) => t.payload.delta).join('')).toBe('Here are your tasks.');

    // …and exactly one terminal bot:message finalises with content + card.
    expect(terminals).toHaveLength(1);
    const terminal = terminals[0]!.payload;
    expect(terminal.content).toBe('Here are your tasks.');
    expect(terminal.toolsUsed).toEqual(['list_tasks']);
    expect((terminal.card as { type: string }).type).toBe('task_list');
    expect(terminal.sessionId).toBeTruthy();

    // Every event carries the same sessionId (no cross-stream contamination).
    const ids = new Set(emitted.map((e) => e.payload.sessionId));
    expect(ids.size).toBe(1);
  });

  test('archives both the user and bot message to messages (channel=bot)', async () => {
    const svc = new BotService(mockAnthropic(), redis, mockIo([]));
    await svc.handleMessage({ staffId: ADMIN, role: 'admin', userText: 'list my tasks', db });

    const rows = await db
      .selectFrom('messages')
      .select(['channel', 'sender_type', 'content'])
      .where('sender_id', '=', ADMIN)
      .where('channel', '=', 'bot')
      .orderBy('created_at', 'asc')
      .execute();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ channel: 'bot', sender_type: 'user', content: 'list my tasks' });
    expect(rows[1]).toMatchObject({ channel: 'bot', sender_type: 'bot', content: 'Here are your tasks.' });
  });

  test('persists the Redis session with an incremented turnCount', async () => {
    const svc = new BotService(mockAnthropic(), redis, mockIo([]));
    await svc.handleMessage({ staffId: ADMIN, role: 'admin', userText: 'list my tasks', db });

    const raw = await redis.get(`bot:session:${ADMIN}`);
    expect(raw).toBeTruthy();
    const session = JSON.parse(raw!) as { turnCount: number; messages: unknown[] };
    expect(session.turnCount).toBe(1);
    expect(session.messages.length).toBeGreaterThan(0);
  });
});
