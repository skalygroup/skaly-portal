import { Redis } from 'ioredis';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterEach, afterAll } from 'vitest';

import { BotService } from '../../src/services/BotService.js';

import type Anthropic from '@anthropic-ai/sdk';
import type { DB } from '@skaly/shared';
import type { Server } from 'socket.io';

/**
 * ADR-021 — bot archive attribution.
 *
 * The load-bearing test in this file is the cross-user one: before ADR-021 every bot
 * reply carried the caller's staffId, so "return A's conversation and not B's" was a
 * question the schema could answer only by accident. Now the reply is anonymous and
 * ownership comes from the parent_id join, which is what makes the 12-month archive
 * (NFR §5.2) mean anything once the 12h Redis TTL has lapsed.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const A = 'e4000000-0000-4000-8000-00000000a001';
const B = 'e4000000-0000-4000-8000-00000000b001';
const DOMAIN = '@botarchive.itest';

function mockIo(): Server {
  return { of: () => ({ to: () => ({ emit: () => undefined }) }) } as unknown as Server;
}

const asMessage = (text: string): Anthropic.Message =>
  ({
    id: 'msg_x',
    type: 'message',
    role: 'assistant',
    model: 'test',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) as unknown as Anthropic.Message;

/**
 * A model that always answers `reply`, with no tool use.
 *
 * The text must be STREAMED, not just returned: BotService accumulates its archived
 * content from the `text` events, so a mock that only resolves finalMessage() archives
 * an empty string.
 */
function mockAnthropic(reply: string): Anthropic {
  return {
    messages: {
      stream: () => {
        let cb: ((t: string) => void) | undefined;
        return {
          on(event: string, handler: (t: string) => void) {
            if (event === 'text') cb = handler;
            return this;
          },
          async finalMessage() {
            cb?.(reply);
            return asMessage(reply);
          },
        };
      },
    },
  } as unknown as Anthropic;
}

const svc = (reply = 'Sure thing.'): BotService =>
  new BotService(mockAnthropic(reply), redis, mockIo());

/** One complete exchange, exactly as the route drives it (archive → handle). */
async function exchange(staffId: string, text: string, reply = 'Sure thing.'): Promise<string> {
  const s = svc(reply);
  const session = await s.loadSession(staffId, db);
  const userMessageId = await s.archiveUserMessage(staffId, text, db);
  await s.handleMessage({
    session,
    staffId,
    role: 'admin',
    userText: text,
    userMessageId,
    db,
  });
  return userMessageId;
}

async function cleanup(): Promise<void> {
  const staff = [A, B];
  await sql`
    DELETE FROM messages
    WHERE sender_id = ANY(${staff})
       OR parent_id IN (SELECT id FROM messages WHERE sender_id = ANY(${staff}))
  `.execute(db);
  await db.deleteFrom('bot_sessions').where('staff_id', 'in', staff).execute();
  await redis.del(
    `bot:session:${A}`, `bot:session:${B}`,
    `bot:pending:${A}`, `bot:pending:${B}`,
    // The clear marker is session state too — leaving it makes the NEXT test's
    // fallback silently return empty for a reason it never set up.
    `bot:cleared:${A}`, `bot:cleared:${B}`,
  );
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: A, name: 'Archive A', email: `a${DOMAIN}`, role: 'admin', active: true },
      { id: B, name: 'Archive B', email: `b${DOMAIN}`, role: 'admin', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await cleanup();
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await db.deleteFrom('staff').where('id', 'in', [A, B]).execute();
  await redis.quit();
  await db.destroy();
});

describe('ADR-021 — the two writes and their link', () => {
  test('one exchange writes exactly two rows, correctly shaped and linked', async () => {
    const userMessageId = await exchange(A, 'how many tasks are overdue?', 'Three.');

    const rows = await db
      .selectFrom('messages as m')
      .leftJoin('messages as p', 'p.id', 'm.parent_id')
      .select(['m.id', 'm.sender_type', 'm.sender_id', 'm.parent_id', 'm.content', 'm.content_type'])
      .where('m.channel', '=', 'bot')
      .where(sql<boolean>`COALESCE(m.sender_id, p.sender_id) = ${A}`)
      .orderBy('m.created_at', 'asc')
      .execute();

    expect(rows).toHaveLength(2);

    // The user's turn carries the owner — this is what makes the join work at all.
    expect(rows[0]).toMatchObject({
      id: userMessageId,
      sender_type: 'user',
      sender_id: A,
      parent_id: null,
      content: 'how many tasks are overdue?',
      content_type: 'text',
    });

    // The bot's reply is anonymous by design (the schema comment) and linked.
    expect(rows[1]).toMatchObject({
      sender_type: 'bot',
      sender_id: null,
      parent_id: userMessageId,
      content: 'Three.',
    });
  });

  test('the user turn is written BEFORE the model runs, so a crash mid-stream still leaves an attributable question', async () => {
    const s = new BotService(
      {
        messages: {
          stream: () => ({
            on() {
              return this;
            },
            async finalMessage(): Promise<Anthropic.Message> {
              throw new Error('anthropic exploded mid-stream');
            },
          }),
        },
      } as unknown as Anthropic,
      redis,
      mockIo(),
    );

    const session = await s.loadSession(A, db);
    const userMessageId = await s.archiveUserMessage(A, 'a question that never got answered', db);
    // handleMessage swallows the failure onto the socket rather than throwing.
    await s.handleMessage({
      session,
      staffId: A,
      role: 'admin',
      userText: 'a question that never got answered',
      userMessageId,
      db,
    });

    const turns = await s.getBotConversation(A, 50, 0, db);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ sender_type: 'user', content: 'a question that never got answered' });
  });
});

describe('ADR-021 — ownership resolves by join, across users', () => {
  test("A's conversation comes back, and B's does not — the assertion that was impossible before", async () => {
    await exchange(A, "A's question", "A's answer");
    await exchange(B, "B's question", "B's answer");

    const forA = await svc().getBotConversation(A, 50, 0, db);
    const forB = await svc().getBotConversation(B, 50, 0, db);

    const contentsA = forA.map((r) => r.content);
    const contentsB = forB.map((r) => r.content);

    expect(contentsA).toHaveLength(2);
    expect(contentsA).toEqual(expect.arrayContaining(["A's question", "A's answer"]));
    // The bot reply to B carries NO sender_id, so a naive query would either miss it
    // or hand it to everyone. Neither may happen.
    expect(contentsA).not.toContain("B's question");
    expect(contentsA).not.toContain("B's answer");

    expect(contentsB).toHaveLength(2);
    expect(contentsB).toEqual(expect.arrayContaining(["B's question", "B's answer"]));
    expect(contentsB).not.toContain("A's answer");
  });

  test('legacy rows carrying their own sender_id still resolve — which is why no backfill was needed', async () => {
    // Exactly the pre-ADR-021 write shape: a bot row with sender_id set, no parent.
    await db
      .insertInto('messages')
      .values({
        channel: 'bot',
        sender_id: A,
        sender_type: 'bot',
        content: 'a reply written the old way',
        content_type: 'text',
      })
      .execute();

    const turns = await svc().getBotConversation(A, 50, 0, db);
    expect(turns.map((t) => t.content)).toContain('a reply written the old way');
  });
});

describe('ADR-021 — bot_sessions is the session envelope', () => {
  test('a conversation creates exactly one row, with the right staff_id', async () => {
    await exchange(A, 'first');

    const rows = await db.selectFrom('bot_sessions').selectAll().where('staff_id', '=', A).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.staff_id).toBe(A);
  });

  test('a second turn bumps last_activity_at and does NOT create a second row', async () => {
    const s = svc();
    const session = await s.loadSession(A, db);

    const first = await s.archiveUserMessage(A, 'turn one', db);
    await s.handleMessage({ session, staffId: A, role: 'admin', userText: 'turn one', userMessageId: first, db });

    const after1 = await db
      .selectFrom('bot_sessions')
      .selectAll()
      .where('staff_id', '=', A)
      .executeTakeFirstOrThrow();

    // The envelope is keyed by the session, so a reload must find the same row.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const same = await s.loadSession(A, db);
    expect(same.sessionId).toBe(session.sessionId);

    const second = await s.archiveUserMessage(A, 'turn two', db);
    await s.handleMessage({ session: same, staffId: A, role: 'admin', userText: 'turn two', userMessageId: second, db });

    const rows = await db.selectFrom('bot_sessions').selectAll().where('staff_id', '=', A).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(after1.id);
    expect(rows[0]!.last_activity_at.getTime()).toBeGreaterThan(after1.last_activity_at.getTime());
  });

  test('bot_sessions is never consulted for ownership — deleting it leaves the conversation attributable', async () => {
    await exchange(A, 'still mine', 'still yours');
    await db.deleteFrom('bot_sessions').where('staff_id', '=', A).execute();

    // parent_id owns the message graph; bot_sessions owns the session lifecycle.
    // Losing the envelope must not lose the conversation.
    const turns = await svc().getBotConversation(A, 50, 0, db);
    expect(turns.map((t) => t.content)).toEqual(expect.arrayContaining(['still mine', 'still yours']));
  });
});

describe('ADR-021 — the DB fallback behind GET /v1/bot/session/current', () => {
  test('with Redis gone, the archive still serves the turns, oldest first', async () => {
    const s = svc('the archived answer');
    const session = await s.loadSession(A, db);
    const userMessageId = await s.archiveUserMessage(A, 'the archived question', db);
    await s.handleMessage({
      session,
      staffId: A,
      role: 'admin',
      userText: 'the archived question',
      userMessageId,
      db,
    });

    const live = await s.sessionView(A, db);
    expect(live.sessionId).not.toBeNull();

    // Simulate the 12h TTL lapsing.
    await redis.del(`bot:session:${A}`);

    const restored = await s.sessionView(A, db);
    // Readable but no longer resumable — sessionId is null, which is exactly true.
    expect(restored.sessionId).toBeNull();
    expect(restored.messages).toHaveLength(2);
    expect(restored.messages[0]).toMatchObject({ role: 'user', content: 'the archived question' });
    expect(restored.messages[1]).toMatchObject({ role: 'assistant', content: 'the archived answer' });
    expect(restored.lastActivityAt).not.toBeNull();
  });

  test("the fallback is scoped — B's expired session does not surface A's history", async () => {
    await exchange(A, "A's private question", "A's private answer");
    await redis.del(`bot:session:${B}`);

    const view = await svc().sessionView(B, db);
    expect(view.messages).toHaveLength(0);
    expect(view.sessionId).toBeNull();
  });

  test('no session and no archive → the null shape, unchanged', async () => {
    const view = await svc().sessionView(B, db);
    expect(view).toMatchObject({ sessionId: null, messages: [], turnCount: 0, lastActivityAt: null });
  });

  test('⭐ an EXPLICIT clear does NOT resurrect the archive', async () => {
    const s = svc('an answer');
    await exchange(A, 'a question', 'an answer');

    // "New conversation" — the user asked for a blank slate.
    await s.clearSession(A);

    const view = await s.sessionView(A, db);
    // An expired session and a cleared one both leave Redis empty. Without the clear
    // marker the fallback fires and the conversation the user just dismissed comes
    // straight back, so the Clear button appears to do nothing.
    expect(view.messages).toEqual([]);
    expect(view.sessionId).toBeNull();
  });

  test('the archive is still reachable after a clear EXPIRES', async () => {
    const s = svc('an answer');
    await exchange(A, 'a question', 'an answer');
    await s.clearSession(A);
    // Simulate the marker's TTL lapsing — at which point the live session would have
    // expired anyway, so the archive becoming reachable again is the correct end state.
    await redis.del(`bot:cleared:${A}`);

    const view = await s.sessionView(A, db);
    expect(view.messages).toHaveLength(2);
  });

  test('starting a new session drops the clear marker', async () => {
    const s = svc();
    await s.clearSession(A);
    await s.loadSession(A, db);
    expect(await redis.get(`bot:cleared:${A}`)).toBeNull();
  });
});
