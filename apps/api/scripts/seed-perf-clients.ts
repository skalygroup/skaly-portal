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
import { backfillClientPeriodRows } from '../src/services/period-generation.js';

const PREFIX = 'Perf Client ';

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

  const cells = await db
    .selectFrom('content_calendar')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('period', '=', period)
    .executeTakeFirstOrThrow();
  console.log(`Done. Period ${period} now holds ${cells.n} calendar cells.`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
