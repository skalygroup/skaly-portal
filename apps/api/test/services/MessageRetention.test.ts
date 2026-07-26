import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import { NotificationService, RETENTION_MONTHS } from '../../src/services/NotificationService.js';

import type { DB } from '@skaly/shared';

/**
 * The NFR §5.2 12-month retention query (Sprint 10 STEP 4, cron in Sprint 12).
 *
 * Written and tested NOW because it is destructive and because ADR-021's addendum
 * makes its SHAPE load-bearing, not just its predicate:
 *
 *   `messages_parent_id_fkey` is NO ACTION, which Postgres checks at STATEMENT END.
 *   One DELETE removing a parent and its children together therefore succeeds — while
 *   two statements, or parent-first ordering, fail. Sprint 10's test teardowns hit
 *   that wall three separate times.
 *
 * A cron discovering this at 02:00 IST is the scenario these tests exist to prevent.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const STAFF = 'ea000000-0000-4000-8000-00000000e001';
const DOMAIN = '@retention.itest';
const svc = new NotificationService();

/** Comfortably outside the window; `fresh` is comfortably inside it. */
const OLD = sql`now() - interval '18 months'`;
const FRESH = sql`now() - interval '2 days'`;

async function insertMessage(over: {
  channel: 'common' | 'bot';
  senderId?: string | null;
  senderType?: 'user' | 'bot';
  content: string;
  parentId?: string | null;
  createdAt?: unknown;
}): Promise<string> {
  const row = await db
    .insertInto('messages')
    .values({
      channel: over.channel,
      sender_id: over.senderId === undefined ? STAFF : over.senderId,
      sender_type: over.senderType ?? 'user',
      content: over.content,
      content_type: 'text',
      parent_id: over.parentId ?? null,
      created_at: (over.createdAt ?? FRESH) as never,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function clearAll(): Promise<void> {
  await sql`
    DELETE FROM messages
    WHERE sender_id = ${STAFF}
       OR parent_id IN (SELECT id FROM messages WHERE sender_id = ${STAFF})
       OR content LIKE 'retention:%'
  `.execute(db);
  await db.deleteFrom('bot_sessions').where('staff_id', '=', STAFF).execute();
}

const remaining = async (): Promise<string[]> => {
  const rows = await db
    .selectFrom('messages')
    .select('content')
    .where('content', 'like', 'retention:%')
    .execute();
  return rows.map((r) => r.content).sort();
};

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values({ id: STAFF, name: 'Retention Staff', email: `r${DOMAIN}`, role: 'admin', active: true })
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

describe('the window', () => {
  test('is 12 months', () => {
    expect(RETENTION_MONTHS).toBe(12);
  });

  test('a fresh chat message is never touched', async () => {
    await insertMessage({ channel: 'common', content: 'retention:fresh chat' });

    expect(await svc.deleteExpiredMessages(db)).toBe(0);
    expect(await remaining()).toEqual(['retention:fresh chat']);
  });
});

describe('chat rows age out by created_at', () => {
  test('an old top-level message is deleted', async () => {
    await insertMessage({ channel: 'common', content: 'retention:old chat', createdAt: OLD });

    expect(await svc.deleteExpiredMessages(db)).toBe(1);
    expect(await remaining()).toEqual([]);
  });

  test('⭐ an old parent whose replies are still fresh is HELD BACK', async () => {
    const parent = await insertMessage({
      channel: 'common',
      content: 'retention:old parent',
      createdAt: OLD,
    });
    await insertMessage({
      channel: 'common',
      content: 'retention:fresh reply',
      parentId: parent,
    });

    // This is why CASCADE was rejected: it would take a reply that is still well
    // inside its own retention window along with its parent.
    expect(await svc.deleteExpiredMessages(db)).toBe(0);
    expect(await remaining()).toEqual(['retention:fresh reply', 'retention:old parent']);
  });

  test('⭐ once the replies are old too, parent AND children go in ONE statement', async () => {
    const parent = await insertMessage({
      channel: 'common',
      content: 'retention:old parent 2',
      createdAt: OLD,
    });
    await insertMessage({
      channel: 'common',
      content: 'retention:old reply',
      parentId: parent,
      createdAt: OLD,
    });

    // The ADR-021 shape: NO ACTION is checked at statement end, so removing both
    // together succeeds where two statements or parent-first would raise
    // messages_parent_id_fkey.
    expect(await svc.deleteExpiredMessages(db)).toBe(2);
    expect(await remaining()).toEqual([]);
  });
});

describe('bot rows age out as TURN-PAIRS, never mid-conversation', () => {
  /** A bot exchange: user turn + anonymous reply linked by parent_id (ADR-021). */
  async function botExchange(label: string, createdAt: unknown): Promise<{ sessionId: string }> {
    const sessionId = crypto.randomUUID();
    await db.insertInto('bot_sessions').values({ id: sessionId, staff_id: STAFF }).execute();

    const turn = await insertMessage({
      channel: 'bot',
      content: `retention:${label} question`,
      createdAt,
    });
    await insertMessage({
      channel: 'bot',
      senderId: null,
      senderType: 'bot',
      content: `retention:${label} answer`,
      parentId: turn,
      createdAt,
    });
    return { sessionId };
  }

  test('a fresh exchange is untouched', async () => {
    await botExchange('active', FRESH);

    expect(await svc.deleteExpiredMessages(db)).toBe(0);
    expect(await remaining()).toEqual(['retention:active answer', 'retention:active question']);
  });

  test('⭐ an old exchange takes BOTH turns — a question never outlives its answer', async () => {
    await botExchange('expired', OLD);

    // parent_id is what guarantees the pair moves together: the reply is a child of
    // the question, so the question cannot go while the answer is inside the window.
    expect(await svc.deleteExpiredMessages(db)).toBe(2);
    expect(await remaining()).toEqual([]);
  });

  test('⭐ an old question with a still-fresh answer is held back ENTIRELY', async () => {
    const turn = await insertMessage({
      channel: 'bot',
      content: 'retention:straddling question',
      createdAt: OLD,
    });
    await insertMessage({
      channel: 'bot',
      senderId: null,
      senderType: 'bot',
      content: 'retention:straddling answer',
      parentId: turn,
    });

    // The pair straddles the cutoff. Deleting the question would leave an anonymous
    // reply with no parent — unattributable, which is the exact bug ADR-021 exists
    // to prevent, reintroduced by a cleanup job.
    expect(await svc.deleteExpiredMessages(db)).toBe(0);
    expect(await remaining()).toEqual([
      'retention:straddling answer',
      'retention:straddling question',
    ]);
  });

  test('⭐ one expired conversation does NOT take a live one from the same person', async () => {
    await botExchange('gone', OLD);
    await botExchange('kept', FRESH);

    // The first implementation joined bot_sessions on staff_id, so ONE expired
    // session deleted that person's entire bot history. This is that regression.
    await svc.deleteExpiredMessages(db);
    expect(await remaining()).toEqual(['retention:kept answer', 'retention:kept question']);
  });
});

describe('the job is safe to run repeatedly', () => {
  test('a second run deletes nothing and does not throw', async () => {
    await insertMessage({ channel: 'common', content: 'retention:old', createdAt: OLD });

    expect(await svc.deleteExpiredMessages(db)).toBe(1);
    // A cron retrying after a partial failure must be harmless.
    expect(await svc.deleteExpiredMessages(db)).toBe(0);
  });

  test('an empty table is 0, not an error', async () => {
    expect(await svc.deleteExpiredMessages(db)).toBe(0);
  });
});
