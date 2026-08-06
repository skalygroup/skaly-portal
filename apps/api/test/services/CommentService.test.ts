import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import { CommentService } from '../../src/services/CommentService.js';
import { SearchService } from '../../src/services/SearchService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type { CommentModule, DB } from '@skaly/shared';

/**
 * CommentService (ADR-032) — the write path the `comments` table has been waiting
 * three sprints for, and the second consumer of `commentVisibility()`.
 *
 * Real Postgres: the visibility rule is a SQL fragment with correlated EXISTS
 * subqueries and a GENERATED tsvector behind it. A mock would assert the shape of
 * a query rather than which rows come back, which is the only interesting part.
 *
 * The headline assertion is PARITY (ADR-015's Rule): search returns exactly the
 * comments the module panel shows the same user. It was seeded-only until now —
 * and the seed agreed with a bug, which is why it is written here against rows
 * the service itself wrote.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const comments = new CommentService();
const search = new SearchService();

const ADMIN = 'ec000000-0000-4000-8000-0000000000a1';
const MANAGER = 'ec000000-0000-4000-8000-0000000000a2';
const MEMBER = 'ec000000-0000-4000-8000-0000000000b1';
const PEER = 'ec000000-0000-4000-8000-0000000000b2';
const FREELANCER = 'ec000000-0000-4000-8000-0000000000c1';
const OTHER_FREELANCER = 'ec000000-0000-4000-8000-0000000000c2';

/** record_id IS a client id (audit H-06) — a grid row is a client-month. */
const CLIENT = 'ec000000-0000-4000-8000-0000000000d1';
const OTHER_CLIENT = 'ec000000-0000-4000-8000-0000000000d2';
const SLOT = 'ec000000-0000-4000-8000-0000000000e1';
const OTHER_SLOT = 'ec000000-0000-4000-8000-0000000000e2';

const PERIOD = '2093-04';
const LOCKED_PERIOD = '2093-03';

const admin: CurrentUser = { staffId: ADMIN, role: 'admin' };
const manager: CurrentUser = { staffId: MANAGER, role: 'manager' };
const member: CurrentUser = { staffId: MEMBER, role: 'team_member' };
const peer: CurrentUser = { staffId: PEER, role: 'team_member' };
const freelancer: CurrentUser = { staffId: FREELANCER, role: 'freelancer' };
const otherFreelancer: CurrentUser = { staffId: OTHER_FREELANCER, role: 'freelancer' };

/** Unlikely to collide with another suite's full-text fixtures. */
const TERM = 'quibblewax';

/** The grid row under test. Typed, not `as const` — every helper below varies it. */
interface RowRef {
  module: CommentModule;
  recordId: string;
  period: string;
}
const row: RowRef = { module: 'shoot_planner', recordId: CLIENT, period: PERIOD };

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN, name: 'Comment Admin', email: `a${ADMIN}@c.itest`, role: 'admin', active: true },
      { id: MANAGER, name: 'Comment Manager', email: `g${MANAGER}@c.itest`, role: 'manager', active: true },
      { id: MEMBER, name: 'Comment Member', email: `m${MEMBER}@c.itest`, role: 'team_member', active: true },
      { id: PEER, name: 'Comment Peer', email: `p${PEER}@c.itest`, role: 'team_member', active: true },
      { id: FREELANCER, name: 'Comment Freelancer', email: `f${FREELANCER}@c.itest`, role: 'freelancer', active: true },
      { id: OTHER_FREELANCER, name: 'Other Freelancer', email: `o${OTHER_FREELANCER}@c.itest`, role: 'freelancer', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await db
    .insertInto('clients')
    .values([
      { id: CLIENT, name: 'Quibblewax Interiors', shoot_slots_per_month: 2, active: true },
      { id: OTHER_CLIENT, name: 'Quibblewax Rivals', shoot_slots_per_month: 1, active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await db
    .insertInto('months')
    .values([
      { period: PERIOD, label: PERIOD, locked: false },
      { period: LOCKED_PERIOD, label: LOCKED_PERIOD, locked: true },
    ])
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();

  // One slot per client-row, each assigned to a different freelancer — the
  // isolation surface: FREELANCER holds CLIENT, OTHER_FREELANCER holds OTHER_CLIENT.
  await db
    .insertInto('shoot_schedules')
    .values([
      { id: SLOT, period: PERIOD, client_id: CLIENT, slot_index: 1, freelancer_id: FREELANCER },
      { id: OTHER_SLOT, period: PERIOD, client_id: OTHER_CLIENT, slot_index: 1, freelancer_id: OTHER_FREELANCER },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
});

async function clearComments(): Promise<void> {
  await db.deleteFrom('comments').where('period', 'in', [PERIOD, LOCKED_PERIOD]).execute();
  await db.deleteFrom('notifications').where('type', '=', 'new_comment').execute();
}

beforeEach(clearComments);

afterAll(async () => {
  await clearComments();
  await db.deleteFrom('shoot_schedules').where('id', 'in', [SLOT, OTHER_SLOT]).execute();
  await db.destroy(); // ends the pool it owns — a second pool.end() throws
});

const post = (user: CurrentUser, content: string, over: Partial<RowRef> = {}) =>
  db.transaction().execute((trx) => comments.create({ ...row, ...over, content }, user, trx));

const contentsFor = async (user: CurrentUser, over: Partial<RowRef> = {}) =>
  (await comments.list({ ...row, ...over }, user, db)).map((c) => c.content).sort();

describe('create', () => {
  test('inserts the comment and returns it with the author joined', async () => {
    const created = await post(member, `The ${TERM} backdrop is wrong`);

    expect(created.content).toBe(`The ${TERM} backdrop is wrong`);
    expect(created.author).toEqual({ staffId: MEMBER, name: 'Comment Member', role: 'team_member' });
    expect(created.acknowledgedBy).toBeNull();
  });

  test('populates record_context server-side as "Client / Module"', async () => {
    const created = await post(admin, 'context check');
    expect(created.recordContext).toBe('Quibblewax Interiors / Shoot Planner');
  });

  test('search_vector is GENERATED — it populates itself and cannot be written', async () => {
    const created = await post(admin, `a ${TERM} tsvector`);

    const found = await db
      .selectFrom('comments')
      .select('id')
      .where('id', '=', created.id)
      .where(sql<boolean>`search_vector @@ websearch_to_tsquery('english', ${TERM})`)
      .executeTakeFirst();
    expect(found, 'the GENERATED column indexed the content on insert').toBeDefined();

    await expect(
      sql`UPDATE comments SET search_vector = NULL WHERE id = ${created.id}`.execute(db),
    ).rejects.toThrow();
  });

  test('a record that does not exist for that module+period is a 404', async () => {
    // A real client with no shoot row in this period — record_id is a soft
    // reference, so nothing but the service's own check catches this.
    await db.deleteFrom('shoot_schedules').where('id', '=', OTHER_SLOT).execute();
    try {
      await expect(post(admin, 'nowhere', { recordId: OTHER_CLIENT })).rejects.toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
      });
    } finally {
      await db
        .insertInto('shoot_schedules')
        .values({ id: OTHER_SLOT, period: PERIOD, client_id: OTHER_CLIENT, slot_index: 1, freelancer_id: OTHER_FREELANCER })
        .execute();
    }
  });

  test('a locked period refuses the write (423) — the boundary is server-side', async () => {
    await expect(post(admin, 'too late', { period: LOCKED_PERIOD })).rejects.toMatchObject({
      code: 'PERIOD_LOCKED',
    });
  });

  test('a freelancer cannot comment on a row they hold no slot in', async () => {
    await expect(post(freelancer, 'not mine', { recordId: OTHER_CLIENT })).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });
});

/**
 * 04-APPFLOW §13, NOT the sprint guide's "assignee + prior commenters": every
 * admin and manager always, plus freelancers assigned to that shoot row, never
 * the author.
 */
describe('new_comment fan-out (ADR-006, APPFLOW §13)', () => {
  const recipients = async (): Promise<string[]> => {
    const rows = await db
      .selectFrom('notifications')
      .select('staff_id')
      .where('type', '=', 'new_comment')
      .execute();
    return rows.map((r) => r.staff_id).sort();
  };

  test('reaches every admin/manager and the assigned freelancer, never the author', async () => {
    await post(member, 'fan out from a team member');

    const got = await recipients();
    expect(got).toContain(ADMIN);
    expect(got).toContain(MANAGER);
    expect(got, 'the freelancer holding a slot in this row').toContain(FREELANCER);
    expect(got, 'the author').not.toContain(MEMBER);
    expect(got, 'a team_member who is not a participant').not.toContain(PEER);
    expect(got, 'a freelancer on a different client row').not.toContain(OTHER_FREELANCER);
  });

  test('an admin author is not notified of their own comment', async () => {
    await post(admin, 'my own comment');

    const got = await recipients();
    expect(got).not.toContain(ADMIN);
    expect(got).toContain(MANAGER);
  });

  test('one notification per recipient, never combined', async () => {
    await post(admin, 'first');
    await post(admin, 'second');

    const got = await recipients();
    expect(got.filter((id) => id === MANAGER)).toHaveLength(2);
  });

  test('the deep link is an in-app route, never a URL (M-08)', async () => {
    await post(member, 'link check');

    const notif = await db
      .selectFrom('notifications')
      .select(sql<string>`payload->>'url'`.as('url'))
      .where('type', '=', 'new_comment')
      .executeTakeFirstOrThrow();

    expect(notif.url.startsWith('/')).toBe(true);
    expect(notif.url).not.toMatch(/^https?:|^\/\//);
    expect(notif.url).toContain(CLIENT);
  });

  test('a comment on content_calendar notifies no freelancer', async () => {
    await db
      .insertInto('content_calendar')
      .values({ period: PERIOD, client_id: CLIENT, date: `${PERIOD}-01`, status: 'Ready' })
      .onConflict((oc) => oc.doNothing())
      .execute();

    await post(admin, 'calendar note', { module: 'content_calendar' });

    const got = await recipients();
    expect(got).not.toContain(FREELANCER);
    expect(got).toContain(MANAGER);
  });
});

describe('visibility (ADR-032) — applied by list, not by the route', () => {
  beforeEach(async () => {
    await post(member, `member own ${TERM}`);
    await post(peer, `peer private ${TERM}`);
    await post(manager, `manager reply ${TERM}`);
    await post(admin, `admin reply ${TERM}`);
  });

  test('an admin sees every comment on the row', async () => {
    expect(await contentsFor(admin)).toHaveLength(4);
  });

  test('a manager sees every comment on the row', async () => {
    expect(await contentsFor(manager)).toHaveLength(4);
  });

  test('a team_member sees own + supervisors, and NOT a peer team_member', async () => {
    const got = await contentsFor(member);

    expect(got).toEqual([`admin reply ${TERM}`, `manager reply ${TERM}`, `member own ${TERM}`].sort());
    expect(got, 'a peer team_member is not a supervisor').not.toContain(`peer private ${TERM}`);
  });

  test("a team_member sees nothing on a record they have not commented on", async () => {
    // The same-record qualifier: supervisors' comments are visible as REPLIES, not
    // as a blanket grant over every manager comment in the portal.
    await db
      .insertInto('content_calendar')
      .values({ period: PERIOD, client_id: OTHER_CLIENT, date: `${PERIOD}-02`, status: 'Ready' })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await post(admin, `elsewhere ${TERM}`, { module: 'content_calendar', recordId: OTHER_CLIENT });

    const got = await contentsFor(member, { module: 'content_calendar', recordId: OTHER_CLIENT });
    expect(got).toEqual([]);
  });

  test('a freelancer sees every comment on their own shoot row, including ones they did not write', async () => {
    const got = await contentsFor(freelancer);
    expect(got).toHaveLength(4);
  });

  test('a freelancer sees nothing on a shoot row they hold no slot in', async () => {
    expect(await contentsFor(otherFreelancer)).toEqual([]);
  });

  test('a freelancer loses the row when the assignment ends', async () => {
    await db.updateTable('shoot_schedules').set({ freelancer_id: null }).where('id', '=', SLOT).execute();
    try {
      expect(await contentsFor(freelancer)).toEqual([]);
    } finally {
      await db.updateTable('shoot_schedules').set({ freelancer_id: FREELANCER }).where('id', '=', SLOT).execute();
    }
  });

  test('comments come back oldest first — a conversation reads top-down', async () => {
    const list = await comments.list(row, admin, db);
    const times = list.map((c) => Date.parse(c.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

/**
 * ADR-015's Rule, finally real: search rows == list rows, for the same user, over
 * rows the write path produced. This is the test that proves "written once" held —
 * it fails the moment either service grows its own copy of the predicate.
 */
describe('search/list parity (ADR-015 Rule, ADR-032)', () => {
  beforeEach(async () => {
    await post(member, `member own ${TERM}`);
    await post(peer, `peer private ${TERM}`);
    await post(manager, `manager reply ${TERM}`);
  });

  const searchIds = async (user: CurrentUser): Promise<string[]> =>
    (await search.search(TERM, 'all_time', user, db)).comments
      .filter((c) => c.period === PERIOD)
      .map((c) => c.id)
      .sort();

  const listIds = async (user: CurrentUser): Promise<string[]> =>
    (await comments.list(row, user, db)).map((c) => c.id).sort();

  test.each([
    ['admin', admin],
    ['manager', manager],
    ['team_member', member],
    ['team_member peer', peer],
    ['freelancer', freelancer],
    ['freelancer on another row', otherFreelancer],
  ])('%s: search returns exactly what the panel shows', async (_label, user) => {
    expect(await searchIds(user)).toEqual(await listIds(user));
  });

  test('the predicate actually discriminates — the roles do not all see the same set', async () => {
    // Guards against a parity test that passes because both sides return
    // everything (or nothing) for everyone.
    expect((await listIds(admin)).length).toBeGreaterThan((await listIds(member)).length);
    expect((await listIds(member)).length).toBeGreaterThan(0);
  });
});

describe('acknowledge', () => {
  test('a manager acknowledges, and the acknowledger is joined on read', async () => {
    const created = await post(member, 'please confirm');

    const res = await db
      .transaction()
      .execute((trx) => comments.acknowledge(created.id, true, manager, trx));
    expect(res.acknowledgedBy).toBe(MANAGER);
    expect(res.acknowledgedAt).not.toBeNull();

    const [listed] = await comments.list(row, admin, db);
    expect(listed?.acknowledgedBy).toEqual({ staffId: MANAGER, name: 'Comment Manager' });
  });

  test('re-acknowledging keeps the FIRST acknowledger', async () => {
    const created = await post(member, 'twice');
    await db.transaction().execute((trx) => comments.acknowledge(created.id, true, manager, trx));
    const second = await db
      .transaction()
      .execute((trx) => comments.acknowledge(created.id, true, admin, trx));

    expect(second.acknowledgedBy).toBe(MANAGER);
  });

  test('acknowledged:false clears it', async () => {
    const created = await post(member, 'undo');
    await db.transaction().execute((trx) => comments.acknowledge(created.id, true, manager, trx));
    const cleared = await db
      .transaction()
      .execute((trx) => comments.acknowledge(created.id, false, manager, trx));

    expect(cleared.acknowledgedBy).toBeNull();
    expect(cleared.acknowledgedAt).toBeNull();
  });

  test('a team_member may not acknowledge (admin/manager only)', async () => {
    const created = await post(member, 'not yours to note');
    await expect(
      db.transaction().execute((trx) => comments.acknowledge(created.id, true, member, trx)),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  test('a comment that does not exist is a 404', async () => {
    await expect(
      db
        .transaction()
        .execute((trx) => comments.acknowledge(OTHER_SLOT, true, admin, trx)),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});
