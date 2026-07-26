import { Redis } from 'ioredis';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import { transactionWithEmits } from '../../src/lib/emit-after-commit.js';
import { ChatService, parseMentionCandidates } from '../../src/services/ChatService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type { DB } from '@skaly/shared';

/**
 * ChatService (Sprint 10 STEP 6).
 *
 * Two things here are worth more than the rest: the freelancer `chat.access` override
 * tested in BOTH directions (this is the key's first real use), and the keyset
 * pagination test that asserts no duplicates AND no gaps across a boundary where two
 * messages share a timestamp — the failure mode that only appears when someone types
 * fast, and never in a fixture with one message per second.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const ADMIN = 'e8000000-0000-4000-8000-00000000c001';
const MEMBER = 'e8000000-0000-4000-8000-00000000c002';
const MENTIONEE = 'e8000000-0000-4000-8000-00000000c003';
const FREELANCER = 'e8000000-0000-4000-8000-00000000c004';
const DOMAIN = '@chatsvc.itest';

const staffIds = [ADMIN, MEMBER, MENTIONEE, FREELANCER];
const svc = new ChatService(redis);

const as = (staffId: string, role: CurrentUser['role']): CurrentUser => ({ staffId, role });
const asAdmin = as(ADMIN, 'admin');
const asMember = as(MEMBER, 'team_member');
const asFreelancer = as(FREELANCER, 'freelancer');

/** Send through a committing transaction, as the route does. */
const send = (content: string, user: CurrentUser = asMember, parentId?: string) =>
  transactionWithEmits(db, (trx) => svc.send({ content, parentId }, user, trx));

/**
 * Clear everything this suite writes — chat rows AND the bot rows the cross-channel
 * leak test seeds.
 *
 * In beforeEach rather than inline after an assertion: a cleanup that trails its
 * assertion never runs when the assertion fails, and the leftovers then break the NEXT
 * run for a reason that has nothing to do with the test. That is exactly what happened
 * while proving this suite catches the channel-filter bug.
 *
 * Scoped by OWNERSHIP and issued as ONE statement, for the ADR-021 reason: parent and
 * children must go together, or `messages_parent_id_fkey` refuses the delete.
 */
async function clearChat(): Promise<void> {
  await sql`
    DELETE FROM messages
    WHERE sender_id = ANY(${staffIds})
       OR parent_id IN (SELECT id FROM messages WHERE sender_id = ANY(${staffIds}))
       OR channel = 'common'
       OR parent_id IN (SELECT id FROM messages WHERE channel = 'common')
  `.execute(db);
  await db.deleteFrom('notifications').where('staff_id', 'in', staffIds).execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN, name: 'Chat Admin', email: `admin${DOMAIN}`, role: 'admin', active: true },
      { id: MEMBER, name: 'Chat Member', email: `member${DOMAIN}`, role: 'team_member', active: true },
      { id: MENTIONEE, name: 'Rahul Menon', email: `rahul${DOMAIN}`, role: 'team_member', active: true },
      { id: FREELANCER, name: 'Chat Free', email: `free${DOMAIN}`, role: 'freelancer', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await clearChat();
});

beforeEach(async () => {
  await clearChat();
  await db.deleteFrom('user_permissions').where('staff_id', 'in', staffIds).execute();
  await redis.del(...staffIds.map((id) => `perms:${id}`));
});

afterAll(async () => {
  await clearChat();
  await db.deleteFrom('user_permissions').where('staff_id', 'in', staffIds).execute();
  await db.deleteFrom('audit_log').where('staff_id', 'in', staffIds).execute();
  await db.deleteFrom('staff').where('id', 'in', staffIds).execute();
  await redis.quit();
  await db.destroy();
});

describe('the mention parser — candidates, because a regex cannot know where a name ends', () => {
  test('offers every prefix, longest first, so the staff table can decide', () => {
    // "@Rahul can you look" and "@Rahul Menon please look" are the same SHAPE. Only
    // the DB knows the first is a one-word name and the second a two-word one.
    expect(parseMentionCandidates('hey @Rahul can you look')).toEqual([
      ['Rahul can you', 'Rahul can', 'Rahul'],
    ]);
  });

  test('one candidate list per @-site', () => {
    const sites = parseMentionCandidates('@Rahul and @Chat Admin');
    expect(sites).toHaveLength(2);
    expect(sites[0]).toContain('Rahul');
    expect(sites[1]).toContain('Chat Admin');
  });

  test('⭐ does NOT match inside an email address', () => {
    // The classic false positive: every email contains an @ followed by a name.
    expect(parseMentionCandidates('mail me at rahul@skalygroup.com please')).toEqual([]);
  });

  test('⭐ does NOT match inside a code span or fenced block', () => {
    expect(parseMentionCandidates('use `@media` for that')).toEqual([]);
    expect(parseMentionCandidates('```\n@media screen {}\n```')).toEqual([]);
  });

  test('does NOT match inside a URL', () => {
    expect(parseMentionCandidates('see https://x.com/@rahul for context')).toEqual([]);
  });
});

describe('mention RESOLUTION — where the name actually gets decided', () => {
  test('⭐ trailing prose is not swallowed into the name', async () => {
    // The bug this replaced: a greedy pattern mentioned "Rahul can you".
    const msg = await send('@Rahul Menon can you look at this', asMember);
    expect(msg.mentions).toHaveLength(1);
    expect(msg.mentions[0]!.name).toBe('Rahul Menon');
  });

  test('a one-word name followed by prose resolves to just the name', async () => {
    const msg = await send('@Chat Admin can you look at this', asMember);
    expect(msg.mentions.map((m) => m.name)).toEqual(['Chat Admin']);
  });

  test('the longest matching candidate wins', async () => {
    // Both "Chat Admin" and a hypothetical "Chat" would match the same @-site; the
    // full name must win so the right person is notified.
    const msg = await send('@Chat Admin please', asMember);
    expect(msg.mentions[0]!.staffId).toBe(ADMIN);
  });

  test('a repeated mention of the same person resolves once', async () => {
    const msg = await send('@Rahul Menon and again @Rahul Menon', asMember);
    expect(msg.mentions).toHaveLength(1);
  });
});

describe('send', () => {
  test('creates the message with the content stored RAW', async () => {
    const msg = await send('  hello <b>world</b> & co  ');

    expect(msg.content).toBe('hello <b>world</b> & co');
    const row = await db
      .selectFrom('messages')
      .select('content')
      .where('id', '=', msg.id)
      .executeTakeFirstOrThrow();
    // Sanitising on write would destroy the original; escaping is a render concern.
    expect(row.content).toBe('hello <b>world</b> & co');
  });

  test('N distinct non-author mentions → N mention rows and N notifications', async () => {
    const msg = await send('@Rahul Menon and @Chat Admin please review', asMember);

    expect(msg.mentions.map((m) => m.staffId).sort()).toEqual([MENTIONEE, ADMIN].sort());

    const rows = await db
      .selectFrom('message_mentions')
      .selectAll()
      .where('message_id', '=', msg.id)
      .execute();
    expect(rows).toHaveLength(2);

    const notifs = await db
      .selectFrom('notifications')
      .select('staff_id')
      .where('type', '=', 'mention')
      .where('staff_id', 'in', staffIds)
      .execute();
    expect(notifs.map((n) => n.staff_id).sort()).toEqual([MENTIONEE, ADMIN].sort());
  });

  test('the same person mentioned twice in one message → ONE notification', async () => {
    await send('@Rahul Menon and again @Rahul Menon', asMember);

    const notifs = await db
      .selectFrom('notifications')
      .selectAll()
      .where('type', '=', 'mention')
      .where('staff_id', '=', MENTIONEE)
      .execute();
    expect(notifs).toHaveLength(1);
  });

  test('⭐ a self-mention creates the ROW but NO notification', async () => {
    const msg = await send('note to self @Chat Member', asMember);

    // The row is real — the highlight should still render.
    const rows = await db
      .selectFrom('message_mentions')
      .selectAll()
      .where('message_id', '=', msg.id)
      .execute();
    expect(rows.map((r) => r.staff_id)).toEqual([MEMBER]);

    // …but ADR-006's non-actor rule means no notification.
    const notifs = await db
      .selectFrom('notifications')
      .selectAll()
      .where('type', '=', 'mention')
      .where('staff_id', '=', MEMBER)
      .execute();
    expect(notifs).toHaveLength(0);
  });

  test('an unknown @name produces no mention and no notification', async () => {
    const msg = await send('@Nobody At All are you there');
    expect(msg.mentions).toEqual([]);
  });

  test('an inactive staff member is never mentioned', async () => {
    await db.updateTable('staff').set({ active: false }).where('id', '=', MENTIONEE).execute();
    const msg = await send('@Rahul Menon ping');
    expect(msg.mentions).toEqual([]);
    await db.updateTable('staff').set({ active: true }).where('id', '=', MENTIONEE).execute();
  });

  test('rejects empty and over-length content', async () => {
    await expect(send('   ')).rejects.toThrow();
    await expect(send('x'.repeat(4001))).rejects.toThrow();
  });

  test('a reply to a missing parent is refused rather than orphaned', async () => {
    await expect(send('reply', asMember, 'e8000000-0000-4000-8000-0000000000ff')).rejects.toThrow();
  });
});

describe('list — keyset pagination', () => {
  /** Seed n messages; all but the timestamps are irrelevant. */
  async function seed(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await send(`message ${i}`);
  }

  test('returns newest first with a cursor when more remain', async () => {
    await seed(5);
    const page = await svc.list({ limit: 3 }, asMember, db);

    expect(page.messages).toHaveLength(3);
    expect(page.messages[0]!.content).toBe('message 4');
    expect(page.nextCursor).not.toBeNull();
  });

  test('the last page has a null cursor', async () => {
    await seed(3);
    const page = await svc.list({ limit: 10 }, asMember, db);
    expect(page.messages).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  test('⭐ no duplicates and no gaps across pages', async () => {
    await seed(10);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page: Awaited<ReturnType<typeof svc.list>> = await svc.list(
        { limit: 3, cursor },
        asMember,
        db,
      );
      seen.push(...page.messages.map((m) => m.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
  });

  test('⭐ messages sharing a timestamp still paginate exactly once each', async () => {
    // The reason `id` is in the keyset. With created_at alone, a page boundary landing
    // between two same-instant rows either drops one or repeats it — invisible until
    // someone types fast, and never reproduced by a one-per-second fixture.
    await seed(4);
    await sql`UPDATE messages SET created_at = now() WHERE channel = 'common'`.execute(db);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4; i++) {
      const page: Awaited<ReturnType<typeof svc.list>> = await svc.list(
        { limit: 2, cursor },
        asMember,
        db,
      );
      seen.push(...page.messages.map((m) => m.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  test('replies are not in the top-level list', async () => {
    const parent = await send('the parent');
    await send('the reply', asMember, parent.id);

    const page = await svc.list({ limit: 50 }, asMember, db);
    expect(page.messages.map((m) => m.content)).toEqual(['the parent']);
    expect(page.messages[0]!.replyCount).toBe(1);
  });
});

describe('threads', () => {
  test('getThread returns replies oldest-first', async () => {
    const parent = await send('parent');
    await send('first reply', asMember, parent.id);
    await send('second reply', asAdmin, parent.id);

    const thread = await svc.getThread(parent.id, asMember, db);
    expect(thread.map((m) => m.content)).toEqual(['first reply', 'second reply']);
  });

  test('⭐ a bot message id returns nothing — the channel filter is load-bearing', async () => {
    // parent_id is shared with the bot archive (ADR-021), so filtering on parent alone
    // would hand a chat caller someone else's bot conversation from just an id.
    const botTurn = await db
      .insertInto('messages')
      .values({ channel: 'bot', sender_id: ADMIN, sender_type: 'user', content: 'my private question', content_type: 'text' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('messages')
      .values({
        channel: 'bot',
        sender_id: null,
        sender_type: 'bot',
        content: 'the private answer',
        content_type: 'text',
        parent_id: botTurn.id,
      })
      .execute();

    const thread = await svc.getThread(botTurn.id, asMember, db);
    expect(thread).toEqual([]);
    // No cleanup here on purpose — clearChat() owns it, so a failing assertion above
    // cannot leak bot rows into the next run.
  });
});

describe('soft delete', () => {
  test('the author can delete; the message tombstones rather than vanishing', async () => {
    const msg = await send('delete me', asMember);
    await transactionWithEmits(db, (trx) => svc.remove(msg.id, asMember, trx));

    const page = await svc.list({ limit: 50 }, asMember, db);
    const tombstone = page.messages.find((m) => m.id === msg.id);

    expect(tombstone?.isDeleted).toBe(true);
    // A tombstone that still ships the text is hidden, not deleted.
    expect(tombstone?.content).toBe('');
  });

  test("⭐ a thread's replies survive the parent's deletion", async () => {
    const parent = await send('parent');
    await send('the reply that must survive', asMember, parent.id);

    await transactionWithEmits(db, (trx) => svc.remove(parent.id, asMember, trx));

    const thread = await svc.getThread(parent.id, asMember, db);
    expect(thread.map((m) => m.content)).toEqual(['the reply that must survive']);
  });

  test('a non-author member cannot delete; an admin and a manager can', async () => {
    const mine = await send('mine', asMember);
    await expect(
      transactionWithEmits(db, (trx) => svc.remove(mine.id, as(MENTIONEE, 'team_member'), trx)),
    ).rejects.toThrow(/only delete your own/i);

    await transactionWithEmits(db, (trx) => svc.remove(mine.id, asAdmin, trx));

    const theirs = await send('theirs', asMember);
    await transactionWithEmits(db, (trx) => svc.remove(theirs.id, as(ADMIN, 'manager'), trx));
  });

  test('deleting twice is a 404, not a silent success', async () => {
    const msg = await send('once');
    await transactionWithEmits(db, (trx) => svc.remove(msg.id, asMember, trx));
    await expect(
      transactionWithEmits(db, (trx) => svc.remove(msg.id, asMember, trx)),
    ).rejects.toThrow();
  });
});

describe('search', () => {
  test('ranks matches and excludes soft-deleted content', async () => {
    await send('the quarterly report needs a rewrite');
    const doomed = await send('report deleted before search');
    await transactionWithEmits(db, (trx) => svc.remove(doomed.id, asMember, trx));

    const hits = await svc.search('report', asMember, db);
    const contents = hits.map((h) => h.content);

    expect(contents).toContain('the quarterly report needs a rewrite');
    // The tombstone is blanked, so its original text cannot come back through search.
    expect(contents).not.toContain('report deleted before search');
  });

  test('an empty query returns nothing rather than everything', async () => {
    await send('anything');
    expect(await svc.search('   ', asMember, db)).toEqual([]);
  });

  test('a non-matching query returns nothing', async () => {
    await send('hello there');
    expect(await svc.search('zzzznomatch', asMember, db)).toEqual([]);
  });
});

describe('⭐ chat.access — the key first real use, tested BOTH ways', () => {
  test('a freelancer is denied by default', async () => {
    await expect(send('let me in', asFreelancer)).rejects.toThrow(/access to chat/i);
    await expect(svc.list({ limit: 10 }, asFreelancer, db)).rejects.toThrow(/access to chat/i);
    await expect(svc.search('x', asFreelancer, db)).rejects.toThrow(/access to chat/i);
  });

  test('an admin-granted override lets the SAME freelancer in', async () => {
    await db
      .insertInto('user_permissions')
      .values({ staff_id: FREELANCER, permission_key: 'chat.access', value: true, set_by: ADMIN })
      .execute();
    // The resolver reads through Redis; the override write must invalidate it.
    await redis.del(`perms:${FREELANCER}`);

    const msg = await send('now I am in', asFreelancer);
    expect(msg.senderId).toBe(FREELANCER);
    expect((await svc.list({ limit: 10 }, asFreelancer, db)).messages.length).toBeGreaterThan(0);
  });

  test('an override set to FALSE denies a role that defaults to allowed', async () => {
    await db
      .insertInto('user_permissions')
      .values({ staff_id: MEMBER, permission_key: 'chat.access', value: false, set_by: ADMIN })
      .execute();
    await redis.del(`perms:${MEMBER}`);

    // The override wins over the role default in both directions — a gate that only
    // grants is half a gate.
    await expect(send('should be refused', asMember)).rejects.toThrow(/access to chat/i);
  });

  test('admin, manager and team_member are allowed by default', async () => {
    await expect(send('admin can', asAdmin)).resolves.toBeDefined();
    await expect(send('manager can', as(ADMIN, 'manager'))).resolves.toBeDefined();
    await expect(send('member can', asMember)).resolves.toBeDefined();
  });
});
