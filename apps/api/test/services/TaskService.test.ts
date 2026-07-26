import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterEach, afterAll } from 'vitest';

import { type CurrentUser } from '../../src/services/AttendanceService.js';
import { TaskService } from '../../src/services/TaskService.js';

import type { DB } from '@skaly/shared';

// Integration smoke: real local Postgres (docker), no socket server. getIo()
// throws when sockets aren't initialised and NotificationService swallows it, so
// the DB writes still commit. STEP 5 writes the full suite; this is a smoke set.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const svc = new TaskService();

// ── Fixtures ────────────────────────────────────────────────────────────────
// Dedicated period, used by no other suite — this test permanently unlocks it,
// so it must not collide with another suite's locked fixture (e.g. attendance's 2000-08).
const PERIOD = '2000-12';
const DATE = '2000-12-10';
// A permanently-locked period for the 423 gate tests (own to this suite — no
// other test touches 2000-10).
const LOCKED_PERIOD = '2000-10';
const LOCKED_DATE = '2000-10-10';
const DOMAIN = '@task.itest';

// Persistent fixture actors: writes append audit_log rows that FK staff, so these
// are upserted and NEVER deleted (audit_log has no DELETE grant).
const ACTOR_ID = 'c0000000-0000-4000-8000-00000000c001';
const ASSIGNEE_1 = 'c0000000-0000-4000-8000-00000000c002';
const ASSIGNEE_2 = 'c0000000-0000-4000-8000-00000000c003';
const ASSIGNEE_3 = 'c0000000-0000-4000-8000-00000000c004';
const ALL_STAFF = [ACTOR_ID, ASSIGNEE_1, ASSIGNEE_2, ASSIGNEE_3];
const currentUser: CurrentUser = { staffId: ACTOR_ID, role: 'admin' };
// team_member acting as themselves (ASSIGNEE_1) — for the ownership backstop tests.
const memberUser: CurrentUser = { staffId: ASSIGNEE_1, role: 'team_member' };

async function cleanupData() {
  // Null the self-FK first so a period-wide delete can't violate dependency_id.
  await db.updateTable('tasks').set({ dependency_id: null }).where('period', 'in', [PERIOD, LOCKED_PERIOD]).execute();
  await db.deleteFrom('tasks').where('period', 'in', [PERIOD, LOCKED_PERIOD]).execute(); // cascades assignees + attachments
  await db
    .deleteFrom('notifications')
    .where('staff_id', 'in', ALL_STAFF)
    .where('type', 'in', ['task_assigned', 'dependency_resolved'])
    .execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ACTOR_ID, name: 'Task Actor', email: `actor-${ACTOR_ID}${DOMAIN}`, role: 'admin', active: true },
      { id: ASSIGNEE_1, name: 'Assignee One', email: `a1-${ASSIGNEE_1}${DOMAIN}`, role: 'team_member', active: true },
      { id: ASSIGNEE_2, name: 'Assignee Two', email: `a2-${ASSIGNEE_2}${DOMAIN}`, role: 'team_member', active: true },
      { id: ASSIGNEE_3, name: 'Assignee Three', email: `a3-${ASSIGNEE_3}${DOMAIN}`, role: 'team_member', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  // Upsert to force the right lock state — rows may pre-exist (seed/other suite).
  await db
    .insertInto('months')
    .values([
      { period: PERIOD, label: PERIOD, locked: false },
      { period: LOCKED_PERIOD, label: LOCKED_PERIOD, locked: true },
    ])
    .onConflict((oc) => oc.column('period').doUpdateSet((eb) => ({ locked: eb.ref('excluded.locked') })))
    .execute();

  await cleanupData();
});

afterEach(cleanupData);

afterAll(async () => {
  await cleanupData();
  await db.destroy();
});

function create(input: Parameters<TaskService['create']>[0]) {
  return db.transaction().execute((trx) => svc.create(input, currentUser, trx));
}
function update(id: string, patch: Parameters<TaskService['update']>[1], user: CurrentUser = currentUser) {
  return db.transaction().execute((trx) => svc.update(id, patch, user, trx));
}
function assign(id: string, staffIds: string[]) {
  return db.transaction().execute((trx) => svc.assign(id, staffIds, currentUser, trx));
}
function remove(id: string, user: CurrentUser = currentUser) {
  return db.transaction().execute((trx) => svc.remove(id, user, trx));
}
/** Count task_assigned / dependency_resolved notifications for a task, by type. */
async function notifCount(taskId: string, type: 'task_assigned' | 'dependency_resolved') {
  const rows = await db
    .selectFrom('notifications')
    .select('staff_id')
    .where('type', '=', type)
    .where('staff_id', 'in', ALL_STAFF)
    .where(sql`payload->>'taskId'`, '=', taskId)
    .execute();
  return rows.map((r) => r.staff_id).sort();
}

describe('create + ADR-006 fan-out', () => {
  test('creates a To Do task with its assignees and fires one task_assigned per non-actor assignee', async () => {
    const task = await create({
      period: PERIOD,
      date: DATE,
      description: 'Edit the Naaz Furniture reel',
      assigneeIds: [ASSIGNEE_1, ASSIGNEE_2],
    });

    expect(task.status).toBe('To Do');
    expect(task.assignees.map((a) => a.id).sort()).toEqual([ASSIGNEE_1, ASSIGNEE_2].sort());
    expect(task.attachmentCount).toBe(0);
    expect(task.dependencyBlocked).toBe(false);

    const notifs = await db
      .selectFrom('notifications')
      .select(['staff_id', 'type', 'payload'])
      .where('type', '=', 'task_assigned')
      .where('staff_id', 'in', [ACTOR_ID, ASSIGNEE_1, ASSIGNEE_2])
      .execute();

    expect(notifs).toHaveLength(2); // N for N, actor excluded, never combined
    expect(notifs.map((n) => n.staff_id).sort()).toEqual([ASSIGNEE_1, ASSIGNEE_2].sort());
    const payload = notifs[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ taskId: task.id, assignedBy: ACTOR_ID });
  });
});

describe('update — Done-block (ADR-009)', () => {
  test('blocks Done while the dependency is unresolved, then allows it once resolved', async () => {
    const dep = await create({ period: PERIOD, date: DATE, description: 'Shoot the footage', assigneeIds: [] });
    const task = await create({
      period: PERIOD,
      date: DATE,
      description: 'Edit the footage',
      assigneeIds: [],
      dependencyId: dep.id,
    });

    // dep is 'To Do' (≠ Done) → the transition is blocked with details.
    await expect(svc.updateStatus(currentUser, task.id, 'Done', db)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNRESOLVED',
      statusCode: 400,
      details: { dependencyTask: { id: dep.id, status: 'To Do' } },
    });

    // Resolve the dependency, then the same transition succeeds.
    await svc.updateStatus(currentUser, dep.id, 'Done', db);
    const done = await svc.updateStatus(currentUser, task.id, 'Done', db);
    expect(done.status).toBe('Done');
  });
});

describe('assertNoDependencyCycle (ADR-009)', () => {
  test('rejects an edge that would close a cycle', async () => {
    const a = await create({ period: PERIOD, date: DATE, description: 'Task A', assigneeIds: [] });
    const b = await create({ period: PERIOD, date: DATE, description: 'Task B', assigneeIds: [], dependencyId: a.id });

    // B already depends on A; making A depend on B closes A→B→A.
    await expect(
      db.transaction().execute((trx) => svc.update(a.id, { dependencyId: b.id }, currentUser, trx)),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  test('rejects an edge that would close a 3-node chain (c→b→a, then a→c)', async () => {
    // "X→Y" = X depends on Y. Chain: c depends on b depends on a (a is the leaf).
    const a = await create({ period: PERIOD, date: DATE, description: 'A', assigneeIds: [] });
    const b = await create({ period: PERIOD, date: DATE, description: 'B', assigneeIds: [], dependencyId: a.id });
    const c = await create({ period: PERIOD, date: DATE, description: 'C', assigneeIds: [], dependencyId: b.id });
    // Point the leaf a at the root c → a→c→b→a closes the loop.
    await expect(update(a.id, { dependencyId: c.id })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
  });

  test('allows pointing a fresh task at an existing leaf', async () => {
    const leaf = await create({ period: PERIOD, date: DATE, description: 'Leaf', assigneeIds: [] });
    const fresh = await create({ period: PERIOD, date: DATE, description: 'Fresh', assigneeIds: [] });
    const updated = await update(fresh.id, { dependencyId: leaf.id });
    expect(updated.dependencyId).toBe(leaf.id);
  });
});

describe('H-03 fan-out (ADR-006) — one task_assigned per newly-added non-actor assignee', () => {
  test('3 assignees → exactly 3; assign 2 more (1 dup) → exactly 1 new; assign self → 0', async () => {
    const task = await create({
      period: PERIOD,
      date: DATE,
      description: 'Multi-assignee reel',
      assigneeIds: [ASSIGNEE_1, ASSIGNEE_2, ASSIGNEE_3],
    });
    expect(await notifCount(task.id, 'task_assigned')).toEqual([ASSIGNEE_1, ASSIGNEE_2, ASSIGNEE_3].sort());

    // Drop ASSIGNEE_3 and clear the notification slate, so a re-assign of
    // [ASSIGNEE_3 (genuinely new), ASSIGNEE_1 (already assigned → dup)] must fire
    // exactly ONE — only the genuinely-new, non-actor assignee.
    await db.transaction().execute((trx) => svc.unassign(task.id, ASSIGNEE_3, currentUser, trx));
    await db.deleteFrom('notifications').where('staff_id', 'in', ALL_STAFF).where('type', '=', 'task_assigned').execute();

    await assign(task.id, [ASSIGNEE_3, ASSIGNEE_1]);
    expect(await notifCount(task.id, 'task_assigned')).toEqual([ASSIGNEE_3]);
  });

  test('assigning the actor to their own task fires 0 notifications', async () => {
    const task = await create({ period: PERIOD, date: DATE, description: 'Self task', assigneeIds: [] });
    await assign(task.id, [ACTOR_ID]);
    expect(await notifCount(task.id, 'task_assigned')).toEqual([]);
  });
});

describe('dependency_resolved (ADR-009)', () => {
  test('moving a dependency to Done notifies each assignee of the dependent (actor-excluded), status unchanged', async () => {
    const dep = await create({ period: PERIOD, date: DATE, description: 'Dependency', assigneeIds: [] });
    const dependent = await create({
      period: PERIOD,
      date: DATE,
      description: 'Waiting task',
      assigneeIds: [ASSIGNEE_1, ACTOR_ID], // ACTOR is the one who resolves → excluded
      dependencyId: dep.id,
    });

    await update(dep.id, { status: 'Done' });

    // One dependency_resolved to ASSIGNEE_1 only (actor excluded).
    expect(await notifCount(dependent.id, 'dependency_resolved')).toEqual([ASSIGNEE_1]);
    // The dependent's own status is NOT auto-changed.
    const still = await svc.getTask(dependent.id, currentUser, db);
    expect(still.status).toBe('To Do');
  });
});

describe('ownership backstop (Testing-Strategy §5)', () => {
  test('team_member updating an unassigned task → 403', async () => {
    const task = await create({ period: PERIOD, date: DATE, description: 'Not yours', assigneeIds: [] });
    await expect(update(task.id, { status: 'In Progress' }, memberUser)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
    });
  });

  test('team_member editing a non-status/result field on their own task → 403', async () => {
    const task = await create({ period: PERIOD, date: DATE, description: 'Mine', assigneeIds: [ASSIGNEE_1] });
    await expect(update(task.id, { description: 'renamed' }, memberUser)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
    });
  });

  test('team_member updating status/result on their own assigned task → success', async () => {
    const task = await create({ period: PERIOD, date: DATE, description: 'Mine', assigneeIds: [ASSIGNEE_1] });
    const updated = await update(task.id, { status: 'In Progress', result: 'started' }, memberUser);
    expect(updated.status).toBe('In Progress');
    expect(updated.result).toBe('started');
  });

  test('admin may edit any field on any task', async () => {
    const task = await create({ period: PERIOD, date: DATE, description: 'Any', assigneeIds: [] });
    const updated = await update(task.id, { description: 'admin-renamed', priority: 'Urgent' });
    expect(updated.description).toBe('admin-renamed');
    expect(updated.priority).toBe('Urgent');
  });
});

describe('soft delete', () => {
  test('remove stamps deleted_at, getTasks excludes it, assignee rows survive', async () => {
    const task = await create({ period: PERIOD, date: DATE, description: 'To delete', assigneeIds: [ASSIGNEE_1] });
    await remove(task.id);

    const list = await svc.getTasks({ period: PERIOD }, currentUser, db);
    expect(list.find((t) => t.id === task.id)).toBeUndefined();

    const assignees = await db
      .selectFrom('task_assignees')
      .select('staff_id')
      .where('task_id', '=', task.id)
      .execute();
    expect(assignees.map((a) => a.staff_id)).toEqual([ASSIGNEE_1]);
  });
});

describe('period lock → 423', () => {
  // Insert directly (bypassing create's lock gate) so update/remove can be tested.
  async function seedLockedTask(): Promise<string> {
    const row = await db
      .insertInto('tasks')
      .values({ period: LOCKED_PERIOD, date: LOCKED_DATE, description: 'Locked', created_by: ACTOR_ID })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  test('create in a locked period → 423', async () => {
    await expect(
      create({ period: LOCKED_PERIOD, date: LOCKED_DATE, description: 'nope', assigneeIds: [] }),
    ).rejects.toMatchObject({ code: 'PERIOD_LOCKED', statusCode: 423 });
  });

  test('update in a locked period → 423', async () => {
    const id = await seedLockedTask();
    await expect(update(id, { status: 'Done' })).rejects.toMatchObject({ code: 'PERIOD_LOCKED', statusCode: 423 });
  });

  test('delete in a locked period → 423', async () => {
    const id = await seedLockedTask();
    await expect(remove(id)).rejects.toMatchObject({ code: 'PERIOD_LOCKED', statusCode: 423 });
  });
});
