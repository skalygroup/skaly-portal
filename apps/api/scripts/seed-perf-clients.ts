/**
 * Perf-gate fixture: top the current period up to N active non-internal clients,
 * each with its full row set, by calling the SAME generators the app uses
 * (backfillClientPeriodRows) — never hand-written SQL, or the fixture would stop
 * resembling production the moment a generator changes.
 *
 * Two numbers matter, for two different questions (NFR §1.1 / Impl-Plan §10):
 *   20 — the contractual bar. NFR §1.1 states the calendar target as "31×20
 *        cells", so FCP/TTI must be measured at 20.
 *   40 — what makes virtualisation *provable*. At 20 clients (~1800px track in a
 *        ~1200px viewport) roughly 16 of 20 columns render — only four culled,
 *        which is weak evidence. At 40, ~16 of 40 render and the DOM assertion
 *        is unambiguous.
 *
 *   pnpm --filter @skaly/api exec tsx scripts/seed-perf-clients.ts 40
 *   pnpm --filter @skaly/api exec tsx scripts/seed-perf-clients.ts --clean
 *
 * Named 'Perf Client NN' so --clean can remove exactly what it created and
 * nothing else. Dev/staging only — it refuses to run against NODE_ENV=production.
 */
import { db, pool } from '../src/lib/db.js';
import { currentIstPeriod } from '../src/services/BaseService.js';
import { backfillClientPeriodRows, generatePeriodRows } from '../src/services/period-generation.js';

const PREFIX = 'Perf Client ';
const TASK_PREFIX = 'Perf task ';

/** NFR §2.2's task volume for one period. */
const PERF_TASK_COUNT = 100;

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-perf-clients is a dev/staging fixture — refusing to run in production.');
  }

  const period = currentIstPeriod();

  if (process.argv.includes('--clean')) {
    const ids = (
      await db.selectFrom('clients').select('id').where('name', 'like', `${PREFIX}%`).execute()
    ).map((c) => c.id);
    if (ids.length === 0) {
      console.log('Nothing to clean.');
      return;
    }
    // Tasks first — they FK the client, and the assignees FK the task.
    const taskIds = (
      await db.selectFrom('tasks').select('id').where('description', 'like', `${TASK_PREFIX}%`).execute()
    ).map((t) => t.id);
    if (taskIds.length > 0) {
      await db.deleteFrom('task_assignees').where('task_id', 'in', taskIds).execute();
      await db.deleteFrom('tasks').where('id', 'in', taskIds).execute();
    }
    // Children first — all three FK the client.
    await db.deleteFrom('content_calendar').where('client_id', 'in', ids).execute();
    await db.deleteFrom('shoot_schedules').where('client_id', 'in', ids).execute();
    await db.deleteFrom('content_pipelines').where('client_id', 'in', ids).execute();
    await db.deleteFrom('clients').where('id', 'in', ids).execute();
    console.log(`Removed ${ids.length} perf clients and their rows.`);
    return;
  }

  const target = Number(process.argv[2] ?? 40);
  if (!Number.isInteger(target) || target < 1) throw new Error(`Bad target: ${process.argv[2]}`);

  const existing = await db
    .selectFrom('clients')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('active', '=', true)
    .where('deleted_at', 'is', null)
    .where('is_internal', '=', false)
    .executeTakeFirstOrThrow();

  const have = Number(existing.n);
  const toAdd = Math.max(0, target - have);
  console.log(`${have} active non-internal clients; target ${target} → adding ${toAdd}.`);

  for (let i = 0; i < toAdd; i++) {
    await db.transaction().execute(async (trx) => {
      const client = await trx
        .insertInto('clients')
        .values({
          name: `${PREFIX}${String(have + i + 1).padStart(2, '0')}`,
          shoot_slots_per_month: 4,
          pieces_per_visit: 3,
          active: true,
          is_internal: false,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      // The real backfill — slots + pipeline row + a full month of cells.
      await backfillClientPeriodRows(client.id, period, trx);
    });
  }

  // ── The rest of the period's volume ────────────────────────────────────────
  // A report is not a calendar query (NFR §1.2): `org_monthly` reads
  // dashboard_org_stats (attendance), dashboard_staff_task_stats (tasks ×
  // assignees), tasks, slots, pipelines and cells. Seeding clients alone leaves
  // every one of those aggregates reading zero rows, and a p95 taken on that is
  // a measurement of an empty month.
  //
  // generatePeriodRows is the app's OWN generator — the same one the seed and
  // Sprint 13's rollover call — and it is idempotent, so this fills whatever the
  // top-up above did not without duplicating what already exists.
  await db.transaction().execute((trx) => generatePeriodRows(period, trx));

  // Attendance is generated all-absent. Left that way, attendance_pct is 0 and
  // the view aggregates a degenerate column; ~85% present is what a real month
  // looks like and costs the same to read.
  await db
    .updateTable('attendance_logs')
    .set({ present: true })
    .where('period', '=', period)
    .where('day_type', '=', 'working')
    .where(({ eb, fn }) => eb(fn('random', []), '<', 0.85))
    .execute();

  await seedTasks(period);

  const [cells, tasks, attendance] = await Promise.all([
    countIn('content_calendar', period),
    countIn('tasks', period),
    countIn('attendance_logs', period),
  ]);
  console.log(
    `Done. Period ${period} now holds ${cells} calendar cells · ${tasks} tasks · ${attendance} attendance rows.`,
  );
}

function countIn(table: 'content_calendar' | 'tasks' | 'attendance_logs', period: string) {
  return db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('period', '=', period)
    .executeTakeFirstOrThrow()
    .then((r) => Number(r.n));
}

/**
 * Top the period up to PERF_TASK_COUNT tasks, each with one assignee.
 *
 * Assignees are the point: `dashboard_staff_task_stats` is a JOIN through
 * `task_assignees`, so unassigned tasks would leave that view empty however many
 * task rows existed.
 */
async function seedTasks(period: string): Promise<void> {
  const have = await countIn('tasks', period);
  const toAdd = Math.max(0, PERF_TASK_COUNT - have);
  if (toAdd === 0) return;

  const staff = await db
    .selectFrom('staff')
    .select('id')
    .where('active', '=', true)
    .where('deleted_at', 'is', null)
    .execute();
  const clients = await db
    .selectFrom('clients')
    .select('id')
    .where('active', '=', true)
    .where('is_internal', '=', false)
    .where('deleted_at', 'is', null)
    .execute();
  if (staff.length === 0 || clients.length === 0) {
    console.log('No active staff or clients — skipping tasks.');
    return;
  }

  const statuses = ['To Do', 'In Progress', 'Blocked', 'Done', 'Cancelled'] as const;
  const [year, month] = period.split('-').map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  /**
   * The LAST day of the period, for every task.
   *
   * Not the task's own date, which is what this seeded first: `TaskService`'s
   * overdue sweep is global and un-scoped, so a hundred fixture tasks with
   * yesterday's deadline made it send a hundred real notifications and broke a
   * suite that (correctly) expects to be the only overdue task in the database.
   * A fixture for measuring report volume has no business producing bell rows.
   */
  const deadline = `${period}-${String(daysInMonth).padStart(2, '0')}`;

  await db.transaction().execute(async (trx) => {
    for (let i = 0; i < toAdd; i++) {
      const date = `${period}-${String((i % daysInMonth) + 1).padStart(2, '0')}`;
      const task = await trx
        .insertInto('tasks')
        .values({
          period,
          date,
          client_id: clients[i % clients.length]!.id,
          description: `${TASK_PREFIX}${i + 1}`,
          status: statuses[i % statuses.length]!,
          priority: 'Medium',
          deadline,
          created_by: staff[0]!.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('task_assignees')
        .values({ task_id: task.id, staff_id: staff[i % staff.length]!.id })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  });
  console.log(`Added ${toAdd} tasks with assignees.`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
