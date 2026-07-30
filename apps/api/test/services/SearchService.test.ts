import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { SearchService } from '../../src/services/SearchService.js';
import { TaskService } from '../../src/services/TaskService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type { DB } from '@skaly/shared';

/**
 * SearchService (ADR-015). Real Postgres — the point of these tests is the SQL:
 * `websearch_to_tsquery`, `ts_rank`, `similarity`, and the GIN indexes behind them
 * cannot be exercised against a mock.
 *
 * The headline assertion is PARITY: a team_member's task results equal what
 * TaskService returns for that same user. Filtering search harder than the service
 * fails safe, so it goes unnoticed — which is exactly why it needs a test.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const search = new SearchService();
const tasks = new TaskService();

const ADMIN = 'e6000000-0000-4000-8000-000000000001';
const MEMBER = 'e6000000-0000-4000-8000-000000000002';
const FREELANCER = 'e6000000-0000-4000-8000-000000000003';
const MANAGER = 'e6000000-0000-4000-8000-000000000004';
const CLIENT = 'e6000000-0000-4000-8000-0000000000c1';
const CLIENT_2 = 'e6000000-0000-4000-8000-0000000000c2';
const SHOOT = 'e6000000-0000-4000-8000-0000000000ff';
const PERIOD = '2094-06';
const OTHER_PERIOD = '2094-05';
const RECORD = 'e6000000-0000-4000-8000-0000000000r1'.replace('r', 'a');

const admin: CurrentUser = { staffId: ADMIN, role: 'admin' };
const member: CurrentUser = { staffId: MEMBER, role: 'team_member' };
const freelancer: CurrentUser = { staffId: FREELANCER, role: 'freelancer' };

/** A term unlikely to collide with any other suite's fixtures. */
const TERM = 'zibberwock';

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN, name: 'Zibberwock Admin', email: `a${ADMIN}@s.itest`, role: 'admin', active: true },
      { id: MEMBER, name: 'Zibberwocky Member', email: `m${MEMBER}@s.itest`, role: 'team_member', active: true },
      { id: FREELANCER, name: 'Search Freelancer', email: `f${FREELANCER}@s.itest`, role: 'freelancer', active: true },
      { id: MANAGER, name: 'Search Manager', email: `g${MANAGER}@s.itest`, role: 'manager', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('clients')
    .values([
      { id: CLIENT, name: 'Zibberwock', shoot_slots_per_month: 1, active: true },
      { id: CLIENT_2, name: 'Zibberwock Furniture Co', shoot_slots_per_month: 1, active: true },
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

  await cleanupRows();

  await db
    .insertInto('tasks')
    .values([
      { period: PERIOD, date: `${PERIOD}-05`, description: `Edit the ${TERM} reel`, created_by: ADMIN, client_id: CLIENT },
      { period: OTHER_PERIOD, date: `${OTHER_PERIOD}-05`, description: `Archive the ${TERM} shoot`, created_by: ADMIN },
      { period: PERIOD, date: `${PERIOD}-06`, description: 'An unrelated task', created_by: ADMIN },
    ])
    .execute();

  // A real shoot row assigned to the freelancer — the freelancer branch of
  // commentVisibility() is record-scoped, so it needs an actual slot to scope to.
  await db
    .insertInto('shoot_schedules')
    .values({ id: SHOOT, period: PERIOD, client_id: CLIENT, slot_index: 1, freelancer_id: FREELANCER })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  // Comments: one by the member, one admin reply on the SAME record, one admin
  // comment on a DIFFERENT record the member never touched, and one admin comment
  // on the freelancer's own shoot slot.
  await db
    .insertInto('comments')
    .values([
      { module: 'shoot_planner', record_id: RECORD, period: PERIOD, staff_id: MEMBER, content: `My ${TERM} note`, record_context: 'Slot 1' },
      { module: 'shoot_planner', record_id: RECORD, period: PERIOD, staff_id: ADMIN, content: `Admin reply about ${TERM}`, record_context: 'Slot 1' },
      { module: 'content_calendar', record_id: CLIENT_2, period: PERIOD, staff_id: ADMIN, content: `Private ${TERM} memo`, record_context: 'Cell' },
      { module: 'shoot_planner', record_id: SHOOT, period: PERIOD, staff_id: ADMIN, content: `Bring the ${TERM} lens`, record_context: 'Zibberwock / Slot 1' },
    ])
    .execute();
});

async function cleanupRows(): Promise<void> {
  await db.deleteFrom('comments').where('period', 'in', [PERIOD, OTHER_PERIOD]).execute();
  await db.deleteFrom('tasks').where('period', 'in', [PERIOD, OTHER_PERIOD]).execute();
  await db.deleteFrom('shoot_schedules').where('id', '=', SHOOT).execute();
}

afterAll(async () => {
  await cleanupRows();
  await db.deleteFrom('clients').where('id', 'in', [CLIENT, CLIENT_2]).execute();
  await db.deleteFrom('staff').where('id', 'in', [ADMIN, MEMBER, FREELANCER, MANAGER]).execute();
  await db.destroy();
});

describe('the empty-query guard', () => {
  test('a query under 2 characters returns four empty arrays without touching the DB', async () => {
    for (const q of ['', ' ', 'a', '  z  ']) {
      const r = await search.search(q, 'all_time', admin, db);
      expect(r, JSON.stringify(q)).toEqual({ tasks: [], clients: [], staff: [], comments: [] });
    }
  });

  test('the response always carries all four keys, even with no hits', async () => {
    const r = await search.search('qqqqzzzznomatch', 'all_time', admin, db);
    expect(Object.keys(r).sort()).toEqual(['clients', 'comments', 'staff', 'tasks']);
  });
});

describe('role scope is parity, not strictness (ADR-015 §2)', () => {
  test("a team_member's task hits equal what TaskService returns for them", async () => {
    // Auth-Matrix §4 grants team_member read on ALL tasks. Search must not filter
    // harder — that fails safe, so nobody notices it is wrong.
    const hits = await search.search(TERM, 'all_time', member, db);
    const viaService = await tasks.getTasks({ period: PERIOD }, member, db);

    const searchIdsInPeriod = hits.tasks.filter((t) => t.period === PERIOD).map((t) => t.id).sort();
    const serviceMatching = viaService
      .filter((t) => t.description.includes(TERM))
      .map((t) => t.id)
      .sort();
    expect(searchIdsInPeriod).toEqual(serviceMatching);
    expect(searchIdsInPeriod.length).toBeGreaterThan(0);
  });

  test('an admin and a team_member see the SAME tasks', async () => {
    const asAdmin = await search.search(TERM, 'all_time', admin, db);
    const asMember = await search.search(TERM, 'all_time', member, db);
    expect(asMember.tasks.map((t) => t.id).sort()).toEqual(asAdmin.tasks.map((t) => t.id).sort());
  });

  test('a freelancer gets NO tasks — the query is skipped entirely', async () => {
    const r = await search.search(TERM, 'all_time', freelancer, db);
    expect(r.tasks).toEqual([]);
    // But they still get staff and clients, which every role may read.
    expect(r.staff.length).toBeGreaterThan(0);
  });
});

describe('comments scoping — the real isolation surface', () => {
  test('an admin sees every matching comment', async () => {
    const r = await search.search(TERM, 'all_time', admin, db);
    expect(r.comments).toHaveLength(4);
  });

  test('a team_member sees their own comment AND the admin reply on that record', async () => {
    const r = await search.search(TERM, 'all_time', member, db);
    const contents = r.comments.map((c) => c.content).sort();
    expect(contents).toEqual([`Admin reply about ${TERM}`, `My ${TERM} note`].sort());
  });

  test("a team_member does NOT see an admin comment on a record they never touched", async () => {
    const r = await search.search(TERM, 'all_time', member, db);
    expect(r.comments.map((c) => c.content)).not.toContain(`Private ${TERM} memo`);
  });

  // The freelancer scope is BY SHOOT ROW, not by author (ADR-015 §2). They author
  // nothing here, and still must see the admin comment on their own slot —
  // 04-APPFLOW §13 notified them about it.
  test("a freelancer sees comments on their own shoot row, even ones they didn't write", async () => {
    const r = await search.search(TERM, 'all_time', freelancer, db);
    expect(r.comments.map((c) => c.content)).toEqual([`Bring the ${TERM} lens`]);
  });

  test('a freelancer sees NOTHING on a slot they are not assigned to', async () => {
    await db.updateTable('shoot_schedules').set({ freelancer_id: null }).where('id', '=', SHOOT).execute();
    try {
      const r = await search.search(TERM, 'all_time', freelancer, db);
      expect(r.comments).toEqual([]);
    } finally {
      await db.updateTable('shoot_schedules').set({ freelancer_id: FREELANCER }).where('id', '=', SHOOT).execute();
    }
  });
});

describe('scope is a no-op for clients and staff (ADR-015 §4)', () => {
  test('scope=current filters tasks and comments but leaves clients and staff intact', async () => {
    const all = await search.search(TERM, 'all_time', admin, db);
    const current = await search.search(TERM, 'current', admin, db);

    // Neither clients nor staff has a period column; filtering them would return
    // zero rows and read as a broken search.
    expect(current.clients.map((c) => c.id).sort()).toEqual(all.clients.map((c) => c.id).sort());
    expect(current.staff.map((s) => s.id).sort()).toEqual(all.staff.map((s) => s.id).sort());
    expect(current.clients.length).toBeGreaterThan(0);
    expect(current.staff.length).toBeGreaterThan(0);
  });

  test('scope=current does restrict tasks to the current period', async () => {
    // The fixtures live in 2094; the current period is not 2094, so a scoped search
    // finds none of them while an all_time one finds both.
    const all = await search.search(TERM, 'all_time', admin, db);
    const current = await search.search(TERM, 'current', admin, db);
    expect(all.tasks.length).toBe(2);
    expect(current.tasks).toEqual([]);
  });
});

describe('ranking uses the right strategy per index type (ADR-015 §3)', () => {
  test('trigram similarity puts an exact client-name match above a partial one', async () => {
    const r = await search.search('Zibberwock', 'all_time', admin, db);
    const names = r.clients.map((c) => c.name);
    expect(names).toContain('Zibberwock');
    expect(names).toContain('Zibberwock Furniture Co');
    // similarity('Zibberwock','Zibberwock') = 1; the longer name scores lower.
    expect(names[0]).toBe('Zibberwock');
  });

  test('a full-text search matches on stemmed words, not substrings', async () => {
    // 'archive' stems to the same lexeme as 'Archive'; a plain LIKE would need the
    // exact casing, and ts_rank would not order it at all.
    const r = await search.search(`${TERM} archive`, 'all_time', admin, db);
    expect(r.tasks.some((t) => t.description.includes('Archive'))).toBe(true);
  });

  test('websearch_to_tsquery survives punctuation that would throw plainto/to_tsquery', async () => {
    // The whole reason M-05 picks websearch_: a search box gets this typed into it.
    for (const q of [`${TERM} & | !`, `"${TERM} reel"`, `${TERM} -unrelated`, `${TERM})(`]) {
      await expect(search.search(q, 'all_time', admin, db), q).resolves.toBeDefined();
    }
  });

  test('a -exclusion actually excludes', async () => {
    const withReel = await search.search(`${TERM}`, 'all_time', admin, db);
    const without = await search.search(`${TERM} -reel`, 'all_time', admin, db);
    expect(withReel.tasks.length).toBe(2);
    expect(without.tasks.some((t) => t.description.includes('reel'))).toBe(false);
  });
});

describe('the staff projection is a security boundary', () => {
  test('staff hits carry exactly id, name, role, avatarUrl — never a SELECT *', async () => {
    const r = await search.search('Zibberwock', 'all_time', freelancer, db);
    expect(r.staff.length).toBeGreaterThan(0);
    for (const s of r.staff) {
      // The staff row carries DOB, mobile and CV keys (NFR §4.2) and this endpoint
      // is readable by every role.
      expect(Object.keys(s).sort()).toEqual(['avatarUrl', 'id', 'name', 'role']);
    }
  });

  test('inactive and soft-deleted staff and clients are excluded', async () => {
    await db.updateTable('staff').set({ active: false }).where('id', '=', MEMBER).execute();
    await db.updateTable('clients').set({ deleted_at: new Date() }).where('id', '=', CLIENT_2).execute();
    try {
      const r = await search.search('Zibberwock', 'all_time', admin, db);
      expect(r.staff.map((s) => s.id)).not.toContain(MEMBER);
      expect(r.clients.map((c) => c.id)).not.toContain(CLIENT_2);
    } finally {
      await db.updateTable('staff').set({ active: true }).where('id', '=', MEMBER).execute();
      await db.updateTable('clients').set({ deleted_at: null }).where('id', '=', CLIENT_2).execute();
    }
  });

  test('soft-deleted tasks are excluded', async () => {
    const target = await db
      .selectFrom('tasks')
      .select('id')
      .where('description', 'like', `%${TERM} reel%`)
      .executeTakeFirstOrThrow();
    await db.updateTable('tasks').set({ deleted_at: new Date() }).where('id', '=', target.id).execute();
    try {
      const r = await search.search(TERM, 'all_time', admin, db);
      expect(r.tasks.map((t) => t.id)).not.toContain(target.id);
    } finally {
      await db.updateTable('tasks').set({ deleted_at: null }).where('id', '=', target.id).execute();
    }
  });
});
