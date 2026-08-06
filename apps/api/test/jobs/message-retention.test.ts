import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import { messageRetentionSweep } from '../../src/jobs/message-retention.js';

import type { DB } from '@skaly/shared';

/**
 * ADR-030's job, built on the predicate Sprint 10 already tested.
 *
 * `services/MessageRetention.test.ts` proves the RULE (a message past the cutoff
 * dies unless it still has a live reply). This file proves the JOB around it:
 * that batching does not split a turn-pair, that the FK survives, that
 * `bot_sessions` envelopes go with their horizon, and that nothing outside
 * `messages`/`bot_sessions` is touched.
 *
 * The straddling pair is the headline. Sprint 9's teardowns hit that wall three
 * times, which is why it is a seeded case here rather than a hypothetical.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const STAFF = 'eb000000-0000-4000-8000-0000000000a1';
const DOMAIN = '@retentionjob.itest';
const TAG = 'retjob:';

const OLD = sql`now() - interval '18 months'`;
const FRESH = sql`now() - interval '2 days'`;

async function insertMessage(over: {
  channel: 'common' | 'bot';
  content: string;
  parentId?: string | null;
  senderId?: string | null;
  senderType?: 'user' | 'bot';
  createdAt?: unknown;
}): Promise<string> {
  const row = await db
    .insertInto('messages')
    .values({
      channel: over.channel,
      sender_id: over.senderId === undefined ? STAFF : over.senderId,
      sender_type: over.senderType ?? 'user',
      content: `${TAG}${over.content}`,
      content_type: 'text',
      parent_id: over.parentId ?? null,
      created_at: (over.createdAt ?? FRESH) as never,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

const remaining = async (): Promise<string[]> => {
  const rows = await db
    .selectFrom('messages')
    .select('content')
    .where('content', 'like', `${TAG}%`)
    .execute();
  return rows.map((r) => r.content.replace(TAG, '')).sort();
};

async function clearAll(): Promise<void> {
  await sql`
    DELETE FROM messages
    WHERE content LIKE ${`${TAG}%`}
       OR parent_id IN (SELECT id FROM messages WHERE content LIKE ${`${TAG}%`})
  `.execute(db);
  await db.deleteFrom('bot_sessions').where('staff_id', '=', STAFF).execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values({ id: STAFF, name: 'Retention Job Staff', email: `r${DOMAIN}`, role: 'admin', active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await clearAll();
});

beforeEach(clearAll);

afterAll(async () => {
  await clearAll();
  await db.deleteFrom('staff').where('id', '=', STAFF).execute();
  await db.destroy();
});

describe('⭐ the straddling pair (Sprint 9 teardown case)', () => {
  test('an old bot question and its answer are deleted TOGETHER, without error', async () => {
    const question = await insertMessage({ channel: 'bot', content: 'old question', createdAt: OLD });
    await insertMessage({
      channel: 'bot',
      content: 'old answer',
      parentId: question,
      senderId: null,
      senderType: 'bot',
      createdAt: OLD,
    });

    // The failure this guards against is a FOREIGN KEY error, not a wrong count:
    // two statements, or parent-first ordering, raise messages_parent_id_fkey.
    const summary = await messageRetentionSweep(db);

    expect(summary.messagesDeleted).toBe(2);
    expect(await remaining()).toEqual([]);
  });

  test('a pair is never split — an answer inside the window keeps its question alive', async () => {
    const question = await insertMessage({ channel: 'bot', content: 'old question', createdAt: OLD });
    await insertMessage({
      channel: 'bot',
      content: 'recent answer',
      parentId: question,
      senderId: null,
      senderType: 'bot',
      createdAt: FRESH,
    });

    await messageRetentionSweep(db);

    expect(await remaining()).toEqual(['old question', 'recent answer'].sort());
  });

  test('a chat parent with one old and one NEW reply is retained whole', async () => {
    const parent = await insertMessage({ channel: 'common', content: 'chat parent', createdAt: OLD });
    await insertMessage({ channel: 'common', content: 'old reply', parentId: parent, createdAt: OLD });
    await insertMessage({ channel: 'common', content: 'new reply', parentId: parent, createdAt: FRESH });

    await messageRetentionSweep(db);

    const left = await remaining();
    expect(left, 'the parent is pinned by its newer reply').toContain('chat parent');
    expect(left).toContain('new reply');
  });

  test('a chat parent whose replies are all old goes with them', async () => {
    const parent = await insertMessage({ channel: 'common', content: 'chat parent', createdAt: OLD });
    await insertMessage({ channel: 'common', content: 'old reply', parentId: parent, createdAt: OLD });

    const summary = await messageRetentionSweep(db);

    expect(summary.messagesDeleted).toBe(2);
    expect(await remaining()).toEqual([]);
  });
});

describe('batching (ADR-030 amendment)', () => {
  test('⭐ many conversations clear over MULTIPLE statements, each deleted exactly once', async () => {
    for (let i = 0; i < 12; i += 1) {
      const q = await insertMessage({ channel: 'bot', content: `q${i}`, createdAt: OLD });
      await insertMessage({
        channel: 'bot',
        content: `a${i}`,
        parentId: q,
        senderId: null,
        senderType: 'bot',
        createdAt: OLD,
      });
    }

    // A batch size far below the row count: the purge must not be one statement.
    const summary = await messageRetentionSweep(db, { batchSize: 5 });

    expect(summary.batches, 'a single monster DELETE would lock messages during live chat').toBeGreaterThan(1);
    expect(summary.messagesDeleted).toBe(24);
    expect(summary.hitBatchCap).toBe(false);
    expect(await remaining()).toEqual([]);
  });

  test('⭐ a parent takes its children even when they fall outside the LIMIT', async () => {
    // One question with four answers, and a batch size of 1. Without the
    // `OR parent_id IN batch` closure the parent would be selected alone and the
    // FK would raise at statement end.
    const q = await insertMessage({ channel: 'bot', content: 'wide question', createdAt: OLD });
    for (let i = 0; i < 4; i += 1) {
      await insertMessage({
        channel: 'bot',
        content: `answer ${i}`,
        parentId: q,
        senderId: null,
        senderType: 'bot',
        createdAt: OLD,
      });
    }

    const summary = await messageRetentionSweep(db, { batchSize: 1 });

    expect(summary.messagesDeleted).toBe(5);
    expect(await remaining()).toEqual([]);
  });

  test('an empty run does no batches and reports zero', async () => {
    const summary = await messageRetentionSweep(db);
    expect(summary).toMatchObject({ messagesDeleted: 0, batches: 0, hitBatchCap: false });
  });
});

describe('bot_sessions envelopes', () => {
  test('a session past the horizon is deleted', async () => {
    await db
      .insertInto('bot_sessions')
      .values({ staff_id: STAFF, last_activity_at: OLD as never })
      .execute();

    const summary = await messageRetentionSweep(db);
    expect(summary.sessionsDeleted).toBe(1);
  });

  test('a session inside the window survives', async () => {
    await db
      .insertInto('bot_sessions')
      .values({ staff_id: STAFF, last_activity_at: FRESH as never })
      .execute();

    const summary = await messageRetentionSweep(db);
    expect(summary.sessionsDeleted).toBe(0);
  });

  test("⭐ an expired session does NOT take that person's live messages with it", async () => {
    // The ADR-021 regression: joining bot_sessions on staff_id means one stale
    // envelope deletes a whole person's bot history. Sessions and messages age
    // out on their own horizons.
    await db
      .insertInto('bot_sessions')
      .values({ staff_id: STAFF, last_activity_at: OLD as never })
      .execute();
    await insertMessage({ channel: 'bot', content: 'live conversation', createdAt: FRESH });

    await messageRetentionSweep(db);

    expect(await remaining()).toEqual(['live conversation']);
  });
});

describe('scope and shape', () => {
  test('⭐ messages_parent_id_fkey is still NO ACTION — the job does not alter it', async () => {
    await messageRetentionSweep(db);

    const row = await sql<{ confdeltype: string }>`
      SELECT confdeltype FROM pg_constraint WHERE conname = 'messages_parent_id_fkey'
    `.execute(db);

    // 'a' = NO ACTION. RESTRICT ('r') would break the batched delete; CASCADE
    // ('c') would lose chat replies; SET NULL ('n') re-orphans bot answers.
    expect(row.rows[0]?.confdeltype).toBe('a');
  });

  test('it audits ONE summary row, not one per message', async () => {
    for (let i = 0; i < 6; i += 1) {
      await insertMessage({ channel: 'common', content: `bulk ${i}`, createdAt: OLD });
    }

    const before = await auditCount();
    const summary = await messageRetentionSweep(db);
    const after = await auditCount();

    expect(summary.messagesDeleted).toBe(6);
    expect(after - before, '15k audit rows for one cleanup is how the log stops being readable').toBe(1);
  });

  test('a run that deletes nothing writes no audit row at all', async () => {
    const before = await auditCount();
    await messageRetentionSweep(db);
    expect((await auditCount()) - before).toBe(0);
  });

  test('it touches nothing outside messages and bot_sessions', async () => {
    await insertMessage({ channel: 'common', content: 'doomed', createdAt: OLD });

    const counts = async () => ({
      notifications: await countOf('notifications'),
      comments: await countOf('comments'),
      tasks: await countOf('tasks'),
    });

    const before = await counts();
    await messageRetentionSweep(db);

    expect(await counts()).toEqual(before);
  });
});

async function auditCount(): Promise<number> {
  const row = await db
    .selectFrom('audit_log')
    .select((eb) => eb.fn.countAll<string>().as('c'))
    .where('table_name', '=', 'messages')
    .executeTakeFirstOrThrow();
  return Number(row.c);
}

async function countOf(table: 'notifications' | 'comments' | 'tasks'): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<string>().as('c'))
    .executeTakeFirstOrThrow();
  return Number(row.c);
}
