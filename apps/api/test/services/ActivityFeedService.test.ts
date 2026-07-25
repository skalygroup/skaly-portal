import { SYSTEM_ACTOR_UUID } from '@skaly/shared';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import { ActivityFeedService } from '../../src/services/ActivityFeedService.js';
import { AuditService } from '../../src/services/AuditService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type { AuditAction } from '../../src/services/AuditService.js';
import type { DB } from '@skaly/shared';

/**
 * ActivityFeedService — the humanised home-page feed (APPFLOW §3, FR-SET-07).
 *
 * Every row goes in through AuditService.log, the one sanctioned write path, so the
 * feed is read from rows shaped exactly as production writes them.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const feed = new ActivityFeedService();
const audit = new AuditService();

const ADMIN = 'e7000000-0000-4000-8000-000000000001';
const MEMBER = 'e7000000-0000-4000-8000-000000000002';
const FREELANCER = 'e7000000-0000-4000-8000-000000000003';
const PERIOD = '2093-08';
const OTHER_PERIOD = '2093-07';

const admin: CurrentUser = { staffId: ADMIN, role: 'admin' };
const member: CurrentUser = { staffId: MEMBER, role: 'team_member' };
const freelancer: CurrentUser = { staffId: FREELANCER, role: 'freelancer' };

const ALL_ACTORS = [ADMIN, MEMBER, FREELANCER, SYSTEM_ACTOR_UUID];

async function log(opts: {
  actorId?: string | null;
  entity: string;
  action: AuditAction;
  after?: unknown;
  before?: unknown;
  entityId?: string;
  actorSource?: 'user' | 'system' | 'bot';
}): Promise<void> {
  await audit.log({
    // `?? ADMIN` would turn an EXPLICIT null back into ADMIN, and an explicit null
    // is the whole point — it is how AuditService produces a 'system' row.
    actorId: 'actorId' in opts ? opts.actorId : ADMIN,
    entity: opts.entity,
    action: opts.action,
    entityId: opts.entityId ?? 'e7000000-0000-4000-8000-00000000aaaa',
    after: opts.after,
    before: opts.before,
    actorSource: opts.actorSource,
    trx: db,
  });
}

async function cleanup(): Promise<void> {
  await db.deleteFrom('audit_log').where('staff_id', 'in', ALL_ACTORS).execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN, name: 'Feed Admin', email: `a${ADMIN}@f.itest`, role: 'admin', active: true },
      { id: MEMBER, name: 'Feed Member', email: `m${MEMBER}@f.itest`, role: 'team_member', active: true },
      { id: FREELANCER, name: 'Feed Free', email: `f${FREELANCER}@f.itest`, role: 'freelancer', active: true },
      { id: SYSTEM_ACTOR_UUID, name: 'System', email: 'system@skaly.internal', role: 'admin', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('months')
    .values([
      { period: PERIOD, label: PERIOD, locked: false },
      { period: OTHER_PERIOD, label: OTHER_PERIOD, locked: false },
    ])
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();
  await cleanup();
});

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await db.deleteFrom('staff').where('id', 'in', [ADMIN, MEMBER, FREELANCER]).execute();
  await db.destroy();
});

describe('the role filter', () => {
  beforeEach(async () => {
    await log({ actorId: ADMIN, entity: 'tasks', action: 'INSERT', after: { description: 'Admin task', period: PERIOD } });
    await log({ actorId: MEMBER, entity: 'tasks', action: 'UPDATE', after: { status: 'Done', period: PERIOD } });
    await log({ actorId: FREELANCER, entity: 'shoot_schedules', action: 'UPDATE', after: { slot_status: 'Confirmed', period: PERIOD } });
  });

  test('an admin sees everyone\'s events', async () => {
    const items = await feed.getFeed({ period: PERIOD }, admin, db);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.actor).sort()).toEqual(['Feed Admin', 'Feed Free', 'Feed Member']);
  });

  test('a team_member sees only their own', async () => {
    const items = await feed.getFeed({ period: PERIOD }, member, db);
    expect(items).toHaveLength(1);
    expect(items[0]!.actor).toBe('Feed Member');
    expect(items[0]!.text).toBe('Feed Member marked a task as Done');
  });

  test('a freelancer sees only their own', async () => {
    const items = await feed.getFeed({ period: PERIOD }, freelancer, db);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toBe('Feed Free set a shoot slot to Confirmed');
  });

  test('newest first', async () => {
    const items = await feed.getFeed({ period: PERIOD }, admin, db);
    const times = items.map((i) => Date.parse(i.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

describe('the template table is a whitelist', () => {
  test('an unmapped (table, action) pair is SKIPPED, never rendered raw', async () => {
    // user_permissions has no template — an override write must not appear as
    // "someone updated user_permissions".
    await log({ entity: 'user_permissions', action: 'UPDATE', after: { value: true, period: PERIOD } });
    await log({ entity: 'attendance_logs', action: 'UPDATE', after: { present: true, period: PERIOD } });

    expect(await feed.getFeed({ period: PERIOD }, admin, db)).toEqual([]);
  });

  test('a renderer may skip a row that says nothing', async () => {
    // A tasks:UPDATE with no status change is not interesting on a home feed.
    await log({ entity: 'tasks', action: 'UPDATE', after: { remark: 'typo fix', period: PERIOD } });
    expect(await feed.getFeed({ period: PERIOD }, admin, db)).toEqual([]);

    await log({ entity: 'tasks', action: 'UPDATE', after: { status: 'Blocked', period: PERIOD } });
    const items = await feed.getFeed({ period: PERIOD }, admin, db);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toContain('Blocked');
  });

  test('no raw JSONB payload ever reaches an item (NFR §4.2)', async () => {
    // The whitelist is also the safety boundary: only fields a template NAMES are
    // read, and only for tables on the list.
    await log({
      entity: 'tasks',
      action: 'INSERT',
      after: { description: 'A task', period: PERIOD, secret_note: 'DOB 1990-01-01, mobile 99999' },
    });
    const items = await feed.getFeed({ period: PERIOD }, admin, db);
    expect(items).toHaveLength(1);
    const serialised = JSON.stringify(items[0]);
    expect(serialised).not.toContain('secret_note');
    expect(serialised).not.toContain('1990-01-01');
    expect(serialised).not.toContain('99999');
    expect(Object.keys(items[0]!).sort()).toEqual(['actor', 'at', 'id', 'link', 'text']);
  });

  test('a mapped pair renders its deep link', async () => {
    const recordId = 'e7000000-0000-4000-8000-00000000bbbb';
    await log({ entity: 'tasks', action: 'INSERT', entityId: recordId, after: { description: 'Linked task', period: PERIOD } });
    const items = await feed.getFeed({ period: PERIOD }, admin, db);
    expect(items[0]!.link).toBe(`/tasks?period=${PERIOD}&highlight=${recordId}`);
  });
});

describe("'system' rows are excluded below a whitelist", () => {
  test('a trigger recompute is noise and does not appear', async () => {
    await log({
      actorId: null, // no actor ⇒ System Actor + source 'system'
      entity: 'content_calendar',
      action: 'UPDATE',
      after: { status: 'Posted', period: PERIOD },
    });
    expect(await feed.getFeed({ period: PERIOD }, admin, db)).toEqual([]);
  });

  test('a month lock IS whitelisted — it changes what everyone can do', async () => {
    await log({ actorId: null, entity: 'months', action: 'LOCK', entityId: null as unknown as string, after: { period: PERIOD } });
    const items = await feed.getFeed({ period: PERIOD }, admin, db);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toContain('locked');
    expect(items[0]!.actor).toBe('System');
  });

  test("a human's calendar edit DOES appear — only 'system' is filtered", async () => {
    await log({ entity: 'content_calendar', action: 'UPDATE', after: { status: 'Posted', period: PERIOD } });
    const items = await feed.getFeed({ period: PERIOD }, admin, db);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toBe('Feed Admin set a calendar day to Posted');
  });

  test("a bot-sourced write appears like any human one — it IS the human's action", async () => {
    await log({ entity: 'tasks', action: 'UPDATE', actorSource: 'bot', after: { status: 'Done', period: PERIOD } });
    const items = await feed.getFeed({ period: PERIOD }, admin, db);
    expect(items).toHaveLength(1);
    expect(items[0]!.actor).toBe('Feed Admin');
  });
});

describe('limit and period', () => {
  test('defaults to 10 and caps at 50', async () => {
    for (let i = 0; i < 12; i++) {
      await log({ entity: 'tasks', action: 'INSERT', after: { description: `Task ${i}`, period: PERIOD } });
    }
    expect(await feed.getFeed({ period: PERIOD }, admin, db)).toHaveLength(10);
    expect(await feed.getFeed({ period: PERIOD, limit: 5 }, admin, db)).toHaveLength(5);
    // 999 is clamped to 50, not honoured.
    expect((await feed.getFeed({ period: PERIOD, limit: 999 }, admin, db)).length).toBeLessThanOrEqual(50);
    // A zero or negative limit still returns at least one item rather than none.
    expect((await feed.getFeed({ period: PERIOD, limit: 0 }, admin, db)).length).toBe(1);
  });

  test('period filters on the payload, matching either side of the change', async () => {
    await log({ entity: 'tasks', action: 'INSERT', after: { description: 'This month', period: PERIOD } });
    await log({ entity: 'tasks', action: 'INSERT', after: { description: 'Last month', period: OTHER_PERIOD } });

    const thisMonth = await feed.getFeed({ period: PERIOD }, admin, db);
    expect(thisMonth).toHaveLength(1);
    expect(thisMonth[0]!.text).toContain('This month');

    const removed = await feed.getFeed({ period: OTHER_PERIOD }, admin, db);
    expect(removed).toHaveLength(1);
    expect(removed[0]!.text).toContain('Last month');
  });

  test('the limit is honoured even when many rows are skipped by their renderer', async () => {
    // 20 status-less updates (all skipped) followed by 3 real ones: the over-fetch
    // must still surface the 3 rather than returning an empty page.
    for (let i = 0; i < 20; i++) {
      await log({ entity: 'tasks', action: 'UPDATE', after: { remark: `noise ${i}`, period: PERIOD } });
    }
    for (let i = 0; i < 3; i++) {
      await log({ entity: 'tasks', action: 'UPDATE', after: { status: 'Done', period: PERIOD } });
    }
    const items = await feed.getFeed({ period: PERIOD, limit: 10 }, admin, db);
    expect(items).toHaveLength(3);
  });
});
