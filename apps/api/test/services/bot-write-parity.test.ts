import { Redis } from 'ioredis';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import { withActorSource } from '../../src/lib/bot/actor-context.js';
import { getBotTool } from '../../src/lib/bot/tools/registry.js';
import { BotService } from '../../src/services/BotService.js';
import { ContentCalendarService } from '../../src/services/ContentCalendarService.js';
import { ContentDropperService } from '../../src/services/ContentDropperService.js';
import { HolidayService } from '../../src/services/HolidayService.js';
import { TaskService } from '../../src/services/TaskService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { DB } from '@skaly/shared';
import type { Server } from 'socket.io';

/**
 * WRITE PARITY (Sprint 9 STEP 7) — the bot path and the REST path must produce the
 * SAME outcome for the same user. Sprint 8 established this for reads; writes are
 * where it matters more, because a divergence is a privilege escalation rather than
 * a leak.
 *
 * The tools are thin wrappers over the same service methods the routes call, so
 * "parity" here means asserting that thinness actually holds: every 403 / 423 / 409
 * / 400 arrives identically, and every inherited side effect (H-01's attendance
 * revert, ADR-006's fan-out) still fires.
 *
 * Also covers version capture (ADR-014 §2) and attribution (ADR-016) across tools.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const ADMIN = 'e4000000-0000-4000-8000-000000000001';
const MEMBER = 'e4000000-0000-4000-8000-000000000002';
const OTHER = 'e4000000-0000-4000-8000-000000000003';
const THIRD = 'e4000000-0000-4000-8000-000000000004';
const CLIENT = 'e4000000-0000-4000-8000-0000000000c1';
const PERIOD = '2096-04';
const LOCKED_PERIOD = '2096-03';

const admin: CurrentUser = { staffId: ADMIN, role: 'admin' };
const member: CurrentUser = { staffId: MEMBER, role: 'team_member' };

const tasks = new TaskService();
const dropper = new ContentDropperService();
const calendar = new ContentCalendarService();
const holidays = new HolidayService();

const io = { of: () => ({ to: () => ({ emit: () => undefined }) }) } as unknown as Server;
const bot = (): BotService => new BotService({} as Anthropic, redis, io);

/**
 * Run a mutation tool the way the confirmed turn-2 path does — validate, read,
 * execute inside the bot actor window. Deliberately NOT a re-implementation of
 * BotService: it calls the same descriptor pieces in the same order, so a parity
 * failure here is a real divergence rather than a test artefact.
 */
async function viaBot(name: string, input: Record<string, unknown>, user: CurrentUser) {
  const tool = getBotTool(name)!;
  const parsed = tool.inputSchema.parse(input) as Record<string, unknown>;
  const current = await tool.readCurrent!(parsed, user, db);
  return withActorSource('bot', () => tool.handler(parsed, user, db, current.version));
}

/** Capture a thrown error's code, or null on success. */
async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'UNKNOWN';
  }
}

async function makeTask(over: Partial<{ status: string; period: string; assignee: string; dependencyId: string }> = {}) {
  const period = over.period ?? PERIOD;
  const row = await db
    .insertInto('tasks')
    .values({
      period,
      date: `${period}-08`,
      description: 'Parity task',
      status: over.status ?? 'To Do',
      created_by: ADMIN,
      dependency_id: over.dependencyId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (over.assignee) {
    await db.insertInto('task_assignees').values({ task_id: row.id, staff_id: over.assignee }).execute();
  }
  return row.id;
}

async function cleanup(): Promise<void> {
  // Scoped to THIS suite's tasks. An unfiltered delete here would wipe every other
  // suite's assignee rows.
  await db
    .deleteFrom('task_assignees')
    .where((eb) =>
      eb(
        'task_id',
        'in',
        eb.selectFrom('tasks').select('id').where('period', 'in', [PERIOD, LOCKED_PERIOD]),
      ),
    )
    .execute();
  await db.deleteFrom('notifications').where('staff_id', 'in', [ADMIN, MEMBER, OTHER, THIRD]).execute();
  await db.deleteFrom('tasks').where('period', 'in', [PERIOD, LOCKED_PERIOD]).execute();
  await db.deleteFrom('audit_log').where('staff_id', 'in', [ADMIN, MEMBER, OTHER, THIRD]).execute();
  // Holiday mutations now write notification rows for every active staff member
  // (Sprint 10, ADR-020); those FK staff and block its deletion.
  await db.deleteFrom('notifications').where('staff_id', 'in', [ADMIN, MEMBER, OTHER, THIRD]).execute();
  await db.deleteFrom('attendance_logs').where('period', 'in', [PERIOD, LOCKED_PERIOD]).execute();
  await db.deleteFrom('holidays').where('period', 'in', [PERIOD, LOCKED_PERIOD]).execute();
  await db.deleteFrom('content_calendar').where('period', 'in', [PERIOD, LOCKED_PERIOD]).execute();
  await db.deleteFrom('content_pipelines').where('period', 'in', [PERIOD, LOCKED_PERIOD]).execute();
  await redis.del(`bot:pending:${ADMIN}`, `bot:session:${ADMIN}`, `perms:${ADMIN}`, `perms:${MEMBER}`);
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN, name: 'WP Admin', email: `a${ADMIN}@wp.itest`, role: 'admin', active: true },
      { id: MEMBER, name: 'WP Member', email: `m${MEMBER}@wp.itest`, role: 'team_member', active: true },
      { id: OTHER, name: 'WP Other', email: `o${OTHER}@wp.itest`, role: 'team_member', active: true },
      { id: THIRD, name: 'WP Third', email: `t${THIRD}@wp.itest`, role: 'team_member', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('clients')
    .values({ id: CLIENT, name: 'WP Client', shoot_slots_per_month: 2, pieces_per_visit: 1, active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('months')
    .values([
      { period: PERIOD, label: PERIOD, locked: false },
      { period: LOCKED_PERIOD, label: LOCKED_PERIOD, locked: true },
    ])
    .onConflict((oc) => oc.column('period').doUpdateSet((eb) => ({ locked: eb.ref('excluded.locked') })))
    .execute();
  await cleanup();
});

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await db.deleteFrom('clients').where('id', '=', CLIENT).execute();
  await db.deleteFrom('staff').where('id', 'in', [ADMIN, MEMBER, OTHER, THIRD]).execute();
  await redis.quit();
  await db.destroy();
});

describe('write parity — permission outcomes are identical either way', () => {
  test('team_member update_task_status on an UNASSIGNED task → 403 both ways', async () => {
    const taskA = await makeTask();
    const restCode = await codeOf(() =>
      db.transaction().execute((trx) => tasks.update(taskA, { status: 'Done' }, member, trx)),
    );

    const taskB = await makeTask();
    const botCode = await codeOf(() => viaBot('update_task_status', { taskId: taskB, status: 'Done' }, member));

    expect(restCode).toBe('PERMISSION_DENIED');
    expect(botCode).toBe(restCode);
  });

  test('team_member update_task_status on their OWN assigned task → succeeds both ways', async () => {
    const taskA = await makeTask({ assignee: MEMBER });
    const rest = await db.transaction().execute((trx) => tasks.update(taskA, { status: 'Done' }, member, trx));

    const taskB = await makeTask({ assignee: MEMBER });
    const botResult = await viaBot('update_task_status', { taskId: taskB, status: 'Done' }, member);

    expect(rest.status).toBe('Done');
    expect(botResult.text).toContain('Done');
    const row = await db.selectFrom('tasks').select('status').where('id', '=', taskB).executeTakeFirstOrThrow();
    expect(row.status).toBe('Done');
  });

  test('team_member set_deadline on their own task → 403 both ways (status+result only)', async () => {
    // Auth-Matrix §4: a team_member may edit status and result on an assigned task,
    // nothing else. The bot must not widen that.
    const taskA = await makeTask({ assignee: MEMBER });
    const restCode = await codeOf(() =>
      db.transaction().execute((trx) => tasks.update(taskA, { deadline: `${PERIOD}-20` }, member, trx)),
    );

    const taskB = await makeTask({ assignee: MEMBER });
    const botCode = await codeOf(() => viaBot('set_deadline', { taskId: taskB, deadline: `${PERIOD}-20` }, member));

    expect(restCode).toBe('PERMISSION_DENIED');
    expect(botCode).toBe(restCode);
  });

  test('a locked period → 423 PERIOD_LOCKED both ways', async () => {
    const taskA = await makeTask({ period: LOCKED_PERIOD });
    const restCode = await codeOf(() =>
      db.transaction().execute((trx) => tasks.update(taskA, { status: 'Done' }, admin, trx)),
    );

    const taskB = await makeTask({ period: LOCKED_PERIOD });
    const botCode = await codeOf(() => viaBot('update_task_status', { taskId: taskB, status: 'Done' }, admin));

    expect(restCode).toBe('PERIOD_LOCKED');
    expect(botCode).toBe(restCode);
  });

  test('an unresolved dependency → 400 DEPENDENCY_UNRESOLVED with the same details', async () => {
    const blocker = await makeTask({ status: 'To Do' });

    const dependentA = await makeTask({ dependencyId: blocker });
    let restDetails: unknown;
    try {
      await db.transaction().execute((trx) => tasks.update(dependentA, { status: 'Done' }, admin, trx));
    } catch (err) {
      restDetails = (err as { code: string; details: unknown }).details;
      expect((err as { code: string }).code).toBe('DEPENDENCY_UNRESOLVED');
    }

    const dependentB = await makeTask({ dependencyId: blocker });
    let botDetails: unknown;
    try {
      await viaBot('update_task_status', { taskId: dependentB, status: 'Done' }, admin);
    } catch (err) {
      botDetails = (err as { code: string; details: unknown }).details;
      expect((err as { code: string }).code).toBe('DEPENDENCY_UNRESOLVED');
    }

    // The SAME details payload — the tool did not reshape the error.
    expect(botDetails).toEqual(restDetails);
    expect(restDetails).toBeTruthy();
  });

  test('update_pipeline_stage out of order → the same sequence error both ways', async () => {
    const rowA = await db
      .insertInto('content_pipelines')
      .values({ period: PERIOD, client_id: CLIENT, version: 1 })
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow();
    // finals with no raw — a skip.
    const restCode = await codeOf(() => dropper.updateStage(rowA.id, 'finals', admin, rowA.version, db));

    await db.deleteFrom('content_pipelines').where('id', '=', rowA.id).execute();
    const rowB = await db
      .insertInto('content_pipelines')
      .values({ period: PERIOD, client_id: CLIENT, version: 1 })
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow();
    const botCode = await codeOf(() => viaBot('update_pipeline_stage', { pipelineId: rowB.id, stage: 'finals' }, admin));

    expect(restCode).toBeTruthy();
    expect(botCode).toBe(restCode);
  });
});

describe('write parity — inherited side effects still fire', () => {
  test('remove_holiday reverts the attendance rows (the H-01 cascade)', async () => {
    const date = `${PERIOD}-14`;
    await db
      .insertInto('attendance_logs')
      .values([
        { period: PERIOD, staff_id: ADMIN, date, day_type: 'working', present: false, version: 1 },
        { period: PERIOD, staff_id: MEMBER, date, day_type: 'working', present: false, version: 1 },
      ])
      .execute();

    const holiday = await db
      .transaction()
      .execute((trx) => holidays.create({ period: PERIOD, date, name: 'Parity Day', currentUser: admin, trx }));

    const flipped = await db
      .selectFrom('attendance_logs')
      .select('day_type')
      .where('period', '=', PERIOD)
      .where('date', '=', date)
      .execute();
    expect(flipped.every((r) => r.day_type === 'holiday')).toBe(true);

    // Through the BOT tool, not the service directly.
    await viaBot('remove_holiday', { holidayId: holiday.id }, admin);

    const reverted = await db
      .selectFrom('attendance_logs')
      .select('day_type')
      .where('period', '=', PERIOD)
      .where('date', '=', date)
      .execute();
    // The whole point of H-01: a half-applied removal leaves a phantom gold,
    // non-interactive day. The bot tool must inherit the revert, not skip it.
    expect(reverted.every((r) => r.day_type === 'working')).toBe(true);

    const row = await db
      .selectFrom('holidays')
      .select(['active', 'removed_at'])
      .where('id', '=', holiday.id)
      .executeTakeFirstOrThrow();
    expect(row.active).toBe(false);
    expect(row.removed_at).not.toBeNull();
  });

  test('create_task with 3 assignees fans out exactly 3 task_assigned rows (ADR-006)', async () => {
    const result = await viaBot(
      'create_task',
      { description: 'Fan-out task', date: `${PERIOD}-09`, assigneeIds: [MEMBER, OTHER, THIRD] },
      admin,
    );
    expect(result.text).toContain('Fan-out task');

    const created = await db
      .selectFrom('tasks')
      .select('id')
      .where('description', '=', 'Fan-out task')
      .executeTakeFirstOrThrow();

    const assignees = await db
      .selectFrom('task_assignees')
      .select('staff_id')
      .where('task_id', '=', created.id)
      .execute();
    expect(assignees).toHaveLength(3);

    // Scoped to this suite's staff — the notifications table is shared.
    const notes = await db
      .selectFrom('notifications')
      .select(['staff_id', 'type'])
      .where('type', '=', 'task_assigned')
      .where('staff_id', 'in', [ADMIN, MEMBER, OTHER, THIRD])
      .execute();
    // One per newly-added, NON-ACTOR assignee — the actor (admin) is not notified.
    expect(notes).toHaveLength(3);
    expect(notes.map((n) => n.staff_id).sort()).toEqual([MEMBER, OTHER, THIRD].sort());
    expect(notes.map((n) => n.staff_id)).not.toContain(ADMIN);
  });
});

describe('version capture across the two turns (ADR-014 §2)', () => {
  async function makeCell(status = 'Under Progress') {
    return db
      .insertInto('content_calendar')
      .values({ period: PERIOD, client_id: CLIENT, date: `${PERIOD}-11`, status, version: 1 })
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow();
  }

  test('turn 1 captures the version it saw', async () => {
    const cell = await makeCell();
    // Bump it to 3 the way a couple of real edits would.
    await calendar.updateCell(cell.id, { status: 'Ready' }, admin, 1, db);
    await calendar.updateCell(cell.id, { status: 'Under Progress' }, admin, 2, db);

    const tool = getBotTool('update_calendar_cell')!;
    const current = await tool.readCurrent!({ cellId: cell.id, status: 'Posted' }, admin, db);
    expect(current.version).toBe(3);
  });

  test('an interleaving human edit produces an honest 409, and the cell is NOT overwritten', async () => {
    const cell = await makeCell('Under Progress');

    // TURN 1 — capture the version behind the summary.
    const tool = getBotTool('update_calendar_cell')!;
    const captured = await tool.readCurrent!({ cellId: cell.id, status: 'Posted' }, admin, db);
    expect(captured.version).toBe(1);

    // A human edits the same cell while the user reads the card.
    await calendar.updateCell(cell.id, { status: 'Rescheduled' }, admin, 1, db);

    // TURN 2 — confirm, with the version captured at turn 1.
    const code = await codeOf(() =>
      withActorSource('bot', () =>
        tool.handler({ cellId: cell.id, status: 'Posted' }, admin, db, captured.version),
      ),
    );

    // Without turn-1 capture this test passes silently and WRONGLY: a
    // read-then-write bot would re-read version 2 and overwrite the human's edit.
    expect(code).toBe('STALE_DATA');
    const row = await db
      .selectFrom('content_calendar')
      .select(['status', 'version'])
      .where('id', '=', cell.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('Rescheduled');
    expect(row.version).toBe(2);
  });

  test('with no interleaving edit, confirm succeeds and the auto-reset fires (ADR-013 case 2)', async () => {
    const cell = await makeCell('Under Progress');
    await db.updateTable('content_calendar').set({ source: 'pipeline_trigger' }).where('id', '=', cell.id).execute();

    const tool = getBotTool('update_calendar_cell')!;
    const captured = await tool.readCurrent!({ cellId: cell.id, status: 'Posted' }, admin, db);
    await withActorSource('bot', () =>
      tool.handler({ cellId: cell.id, status: 'Posted' }, admin, db, captured.version),
    );

    const row = await db
      .selectFrom('content_calendar')
      .select(['status', 'version', 'source'])
      .where('id', '=', cell.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('Posted');
    expect(row.version).toBe(2);
    // updateCell's same-statement source reset — the bot goes through it, never a
    // raw write, so provenance flips to manual exactly as a UI edit would.
    expect(row.source).toBe('manual');
  });

  test('update_pipeline_stage captures a version too; the unversioned tools capture none', async () => {
    const pipeline = await db
      .insertInto('content_pipelines')
      .values({ period: PERIOD, client_id: CLIENT, version: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const versioned = await getBotTool('update_pipeline_stage')!.readCurrent!(
      { pipelineId: pipeline.id, stage: 'raw' },
      admin,
      db,
    );
    expect(versioned.version).toBe(1);

    // ADR-008: tasks and shoot_schedules are unversioned and must send nothing.
    const task = await makeTask();
    const unversioned = await getBotTool('update_task_status')!.readCurrent!(
      { taskId: task, status: 'Done' },
      admin,
      db,
    );
    expect(unversioned.version).toBeUndefined();
  });
});

describe('attribution across tools (ADR-016)', () => {
  const auditFor = async (recordId: string) =>
    db
      .selectFrom('audit_log')
      .select(['staff_id', 'changed_by_source', 'table_name'])
      .where('record_id', '=', recordId)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();

  test("update_task_status audits 'bot' + the human caller", async () => {
    const task = await makeTask();
    await viaBot('update_task_status', { taskId: task, status: 'In Progress' }, admin);
    expect(await auditFor(task)).toMatchObject({
      changed_by_source: 'bot',
      staff_id: ADMIN,
      table_name: 'tasks',
    });
  });

  test("update_calendar_cell audits 'bot' + the human caller", async () => {
    const cell = await db
      .insertInto('content_calendar')
      .values({ period: PERIOD, client_id: CLIENT, date: `${PERIOD}-12`, status: 'Under Progress', version: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await viaBot('update_calendar_cell', { cellId: cell.id, status: 'Posted' }, admin);
    expect(await auditFor(cell.id)).toMatchObject({
      changed_by_source: 'bot',
      staff_id: ADMIN,
      table_name: 'content_calendar',
    });
  });

  test("add_holiday audits 'bot' + the human caller", async () => {
    await viaBot('add_holiday', { date: `${PERIOD}-16`, name: 'Attributed Day' }, admin);
    const holiday = await db
      .selectFrom('holidays')
      .select('id')
      .where('name', '=', 'Attributed Day')
      .executeTakeFirstOrThrow();
    expect(await auditFor(holiday.id)).toMatchObject({ changed_by_source: 'bot', staff_id: ADMIN });
  });

  test('never the System Actor, and never \'user\' — the enum has three values for a reason', async () => {
    const task = await makeTask();
    await viaBot('update_task_status', { taskId: task, status: 'In Progress' }, admin);
    const row = await auditFor(task);
    expect(row.changed_by_source).not.toBe('user');
    expect(row.changed_by_source).not.toBe('system');
    // The System Actor is reserved for genuinely unattended writes.
    expect(row.staff_id).not.toBe('00000000-0000-0000-0000-000000000000');
  });

  test('the same tool called OUTSIDE the bot window audits as a hand edit', async () => {
    const task = await makeTask();
    // No withActorSource — this is what a REST call looks like.
    await db.transaction().execute((trx) => tasks.update(task, { status: 'In Progress' }, admin, trx));
    expect((await auditFor(task)).changed_by_source).toBe('user');
  });

  test('a bot session with no pending record does not leave the actor window open', async () => {
    const s = bot();
    await s.setPending(ADMIN, {
      confirmationId: 'e4000000-0000-4000-8000-00000000000f',
      toolName: 'update_task_status',
      input: {},
      summary: { action: 'x', entity: 'Task', target: 'y', changes: [] },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await s.clearPending(ADMIN);

    const task = await makeTask();
    await db.transaction().execute((trx) => tasks.update(task, { status: 'Blocked' }, admin, trx));
    expect((await auditFor(task)).changed_by_source).toBe('user');
  });
});
