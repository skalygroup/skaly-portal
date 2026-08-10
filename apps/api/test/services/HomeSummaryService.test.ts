import { SYSTEM_ACTOR_UUID } from '@skaly/shared';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { HomeSummaryService } from '../../src/services/HomeSummaryService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type { DB } from '@skaly/shared';

/**
 * The home page's numbers, and WHOSE numbers they are.
 *
 * ⚠️ THE SCOPING IS THE POINT, not the arithmetic. A team member's tiles must
 * show their own tasks and their own attendance; if this service ever widened to
 * the organisation, the home page would quietly become an org-wide reporting
 * surface for everyone with a login — and it would look completely normal,
 * because a number carries no evidence of what it counted.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const PERIOD = '2089-05';
const ADMIN: CurrentUser = { staffId: 'd0000000-0000-4000-8000-0000000000a1', role: 'admin' };
const MEMBER: CurrentUser = { staffId: 'd0000000-0000-4000-8000-0000000000b2', role: 'team_member' };
const FREELANCER: CurrentUser = { staffId: 'd0000000-0000-4000-8000-0000000000c3', role: 'freelancer' };
const CLIENT_ID = 'd0000000-0000-4000-8000-0000000000d4';

const svc = new HomeSummaryService();

async function cleanup() {
  // ⚠️ SCOPED TO THIS SUITE'S TASKS. The first draft of this was a bare
  // `deleteFrom('task_assignees')` with no WHERE, which emptied the whole table
  // in the shared dev database — every other suite's fixtures and the developer's
  // own seed data with them. A period-scoped DELETE on `tasks` reads as safe and
  // makes the unscoped one beside it look safe too; it is not.
  await db
    .deleteFrom('task_assignees')
    .where('task_id', 'in', (eb) =>
      eb.selectFrom('tasks').select('id').where('period', '=', PERIOD),
    )
    .execute();
  await db.deleteFrom('tasks').where('period', '=', PERIOD).execute();
  await db.deleteFrom('attendance_logs').where('period', '=', PERIOD).execute();
  await db.deleteFrom('shoot_schedules').where('period', '=', PERIOD).execute();
  await db.deleteFrom('months').where('period', '=', PERIOD).execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: SYSTEM_ACTOR_UUID, name: 'System', email: 'system@skaly.internal', role: 'admin', active: true },
      { id: ADMIN.staffId, name: 'Home Admin', email: 'home-admin@test.skaly.in', role: 'admin', active: true },
      { id: MEMBER.staffId, name: 'Home Member', email: 'home-member@test.skaly.in', role: 'team_member', active: true },
      { id: FREELANCER.staffId, name: 'Home Freelancer', email: 'home-free@test.skaly.in', role: 'freelancer', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('clients')
    .values({ id: CLIENT_ID, name: 'Home Test Client', shoot_slots_per_month: 2, pieces_per_visit: 1, active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();

  await cleanup();
  await db.insertInto('months').values({ period: PERIOD, label: PERIOD, locked: false }).execute();

  // Two tasks: one assigned to the member (overdue), one to nobody.
  const [mine, theirs] = await db
    .insertInto('tasks')
    .values([
      {
        period: PERIOD,
        date: `${PERIOD}-01`,
        client_id: CLIENT_ID,
        description: 'Member task, overdue',
        status: 'To Do',
        // A genuinely past date, NOT one inside this far-future fixture period.
        // 'overdue' is measured against TODAY, so a 2089 deadline is not overdue
        // in 2026 — the first draft of this test asserted otherwise and was wrong.
        deadline: '2020-01-01',
        created_by: ADMIN.staffId,
      },
      {
        period: PERIOD,
        date: `${PERIOD}-01`,
        client_id: CLIENT_ID,
        description: 'Unassigned task',
        status: 'In Progress',
        deadline: '2089-05-28',
        created_by: ADMIN.staffId,
      },
    ])
    .returning('id')
    .execute();
  await db
    .insertInto('task_assignees')
    .values({ task_id: mine!.id, staff_id: MEMBER.staffId })
    .execute();
  void theirs;

  // Attendance: the member present 1 of 2 working days; the admin present 2 of 2.
  await db
    .insertInto('attendance_logs')
    .values([
      { period: PERIOD, staff_id: MEMBER.staffId, date: `${PERIOD}-01`, day_type: 'working', present: true, version: 1 },
      { period: PERIOD, staff_id: MEMBER.staffId, date: `${PERIOD}-02`, day_type: 'working', present: false, version: 1 },
      { period: PERIOD, staff_id: ADMIN.staffId, date: `${PERIOD}-01`, day_type: 'working', present: true, version: 1 },
      { period: PERIOD, staff_id: ADMIN.staffId, date: `${PERIOD}-02`, day_type: 'working', present: true, version: 1 },
      // A Sunday nobody was expected in on — it must not drag the percentage down.
      { period: PERIOD, staff_id: MEMBER.staffId, date: `${PERIOD}-03`, day_type: 'sunday', present: false, version: 1 },
    ])
    .execute();

  await db
    .insertInto('shoot_schedules')
    .values([
      { period: PERIOD, client_id: CLIENT_ID, slot_index: 1, slot_status: 'Confirmed', slot_date: '2089-05-20', freelancer_id: FREELANCER.staffId, pieces_expected: 1 },
      { period: PERIOD, client_id: CLIENT_ID, slot_index: 2, slot_status: 'Unset', pieces_expected: 1 },
    ])
    .execute();
});

afterAll(async () => {
  await cleanup();
  await db.deleteFrom('staff').where('id', 'in', [ADMIN.staffId, MEMBER.staffId, FREELANCER.staffId]).execute();
  await db.deleteFrom('clients').where('id', '=', CLIENT_ID).execute();
  await db.destroy();
});

describe('⭐ the numbers are scoped to the role', () => {
  test('an admin sees the ORGANISATION — both tasks, everyone’s attendance', async () => {
    const s = await svc.get(PERIOD, ADMIN, db);

    expect(s.scope).toBe('organisation');
    expect(s.tasks?.todo).toBe(1);
    expect(s.tasks?.inProgress).toBe(1);
    // 3 of 4 working-day rows present, across both people.
    expect(s.attendance?.workingDays).toBe(4);
    expect(s.attendance?.presentDays).toBe(3);
  });

  test('⭐ a team member sees ONLY their own — not the unassigned task', async () => {
    const s = await svc.get(PERIOD, MEMBER, db);

    expect(s.scope).toBe('own');
    expect(s.tasks?.todo).toBe(1);
    expect(s.tasks?.inProgress, 'the unassigned task is not theirs').toBe(0);
    expect(s.attendance?.workingDays, 'their own two working days').toBe(2);
    expect(s.attendance?.presentDays).toBe(1);
    expect(s.attendance?.pct).toBe(50);
  });

  test('a freelancer gets no task or attendance blocks at all', async () => {
    const s = await svc.get(PERIOD, FREELANCER, db);

    // Not zeroes — NULL. A freelancer has no attendance row and no task list, and
    // "0 tasks" would render a tile claiming they are all caught up.
    expect(s.tasks).toBeNull();
    expect(s.attendance).toBeNull();
    expect(s.shoots).not.toBeNull();
  });

  test('a freelancer’s shoots are their OWN rows (ADR-011 isolation)', async () => {
    const free = await svc.get(PERIOD, FREELANCER, db);
    const admin = await svc.get(PERIOD, ADMIN, db);

    expect(free.shoots?.confirmed).toBe(1);
    // The unset slot belongs to nobody, so the admin sees it and they do not.
    expect(free.shoots?.unset).toBe(0);
    expect(admin.shoots?.unset).toBe(1);
  });

  test('pendingSignups is admin-only', async () => {
    expect((await svc.get(PERIOD, ADMIN, db)).pendingSignups).not.toBeNull();
    expect((await svc.get(PERIOD, MEMBER, db)).pendingSignups).toBeNull();
    expect((await svc.get(PERIOD, FREELANCER, db)).pendingSignups).toBeNull();
  });
});

describe('the figures say what they mean', () => {
  test('⭐ attendance % counts WORKING days only — Sundays never drag it down', async () => {
    const s = await svc.get(PERIOD, MEMBER, db);
    // The member has 3 rows but only 2 working ones. Counting all three would
    // report 33% for somebody who missed a single day.
    expect(s.attendance?.workingDays).toBe(2);
    expect(s.attendance?.pct).toBe(50);
  });

  test('a month with no working days reports null, not 0%', async () => {
    // 0% and "no data yet" are different answers, and only one of them is true
    // on the 1st of a month before anything is generated.
    const s = await svc.get('2089-06', ADMIN, db);
    expect(s.attendance?.workingDays).toBe(0);
    expect(s.attendance?.pct).toBeNull();
  });

  test('overdue counts past-deadline work that is not finished', async () => {
    const s = await svc.get(PERIOD, ADMIN, db);
    // One task carries a 2020 deadline; the other is due in 2089, i.e. not yet.
    expect(s.tasks?.overdue).toBe(1);
  });

  test('nextDate is the next CONFIRMED shoot, and null when there is none', async () => {
    const admin = await svc.get(PERIOD, ADMIN, db);
    // 2089 is in the future, so the confirmed slot is still upcoming.
    expect(admin.shoots?.nextDate).toBe('2089-05-20');
    expect((await svc.get('2089-06', ADMIN, db)).shoots?.nextDate).toBeNull();
  });
});
