/**
 * NFR §3.1 — rollover at representative volume, MEASURED (Sprint 13 STEP 10).
 *
 * Two claims, one run:
 *
 *   1. The whole rollover completes in under 5 minutes at 20 clients.
 *   2. ⭐ THE API STAYS RESPONSIVE THROUGHOUT. This is the half that is easy to
 *      assert and hard to earn: `REFRESH MATERIALIZED VIEW` without CONCURRENTLY
 *      takes ACCESS EXCLUSIVE, so every dashboard read blocks behind it for the
 *      refresh's whole duration. The probe below hammers /v1/health and a real
 *      dashboard read WHILE the rollover runs and reports the worst latency it
 *      saw — a plain refresh shows up here as a multi-second max, not as a
 *      failure, which is exactly why "the tests passed" would not have caught it.
 *
 * The Tier 1 / Tier 2 split is printed separately because they fail for
 * different reasons and are fixed in different places: Tier 1 grows with clients
 * × days, Tier 2 with the size of the underlying tables.
 *
 *   pnpm --filter @skaly/api exec tsx scripts/seed-perf-clients.ts 20
 *   pnpm --filter @skaly/api exec tsx scripts/measure-rollover-nfr.ts
 *   pnpm --filter @skaly/api exec tsx scripts/measure-rollover-nfr.ts --clean
 *
 * Runs against a FAR-FUTURE period so it never touches the live month, and
 * removes what it created unless told otherwise.
 */
import { sql } from 'kysely';

import { db } from '../src/lib/db.js';
import { logger } from '../src/lib/logger.js';
import { RolloverService } from '../src/services/RolloverService.js';

/** Never the live month — this creates a full period's rows for every client. */
const PERIOD = process.env.ROLLOVER_PERIOD ?? '2086-11';
const BUDGET_MS = 5 * 60 * 1000; // NFR §3.1
/** NFR §1.2's dashboard budget, which is what the probe is measured against. */
const DASHBOARD_BUDGET_MS = 200;

async function cleanup(): Promise<void> {
  await db.deleteFrom('notifications').where(sql<boolean>`payload->>'period' = ${PERIOD}`).execute();
  await db
    .deleteFrom('audit_log')
    .where('table_name', '=', 'months')
    .where(sql<boolean>`new_value->>'period' = ${PERIOD}`)
    .execute();
  for (const t of ['content_calendar', 'shoot_schedules', 'content_pipelines', 'attendance_logs'] as const) {
    await db.deleteFrom(t).where('period', '=', PERIOD).execute();
  }
  await db.deleteFrom('months').where('period', '=', PERIOD).execute();
}

/**
 * Read the dashboard view on a loop until told to stop, returning the latencies.
 *
 * Deliberately the VIEW, not `/v1/health`: health touches `months` and Redis and
 * would stay green through an ACCESS EXCLUSIVE lock on the matviews. The probe
 * has to read the exact object Tier 2 is refreshing, or it proves nothing.
 */
function probeDashboard(stop: { now: boolean }): Promise<number[]> {
  const samples: number[] = [];
  return (async () => {
    while (!stop.now) {
      const t = performance.now();
      await sql`SELECT * FROM dashboard_org_stats LIMIT 50`.execute(db);
      samples.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 25));
    }
    return samples;
  })();
}

async function main(): Promise<void> {
  if (process.argv.includes('--clean')) {
    await cleanup();
    console.log(`[rollover-nfr] cleaned ${PERIOD}`);
    return;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run the rollover perf fixture against production.');
  }

  await cleanup(); // a rerun must measure a real rollover, not an already_completed no-op

  const clients = await db
    .selectFrom('clients')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('active', '=', true)
    .where('deleted_at', 'is', null)
    .where('is_internal', '=', false)
    .executeTakeFirstOrThrow();

  console.log(`[rollover-nfr] period ${PERIOD} · ${Number(clients.n)} active clients`);

  const stop = { now: false };
  const probe = probeDashboard(stop);

  const svc = new RolloverService();
  const started = performance.now();
  const result = await svc.run(db, PERIOD, logger);
  const totalMs = performance.now() - started;

  stop.now = true;
  const samples = await probe;

  // Tier 2's own cost, measured by re-running just the refresh — the run above
  // reports one number, and the split is what tells you where to look.
  const t2 = performance.now();
  await sql`REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_org_stats`.execute(db);
  await sql`REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_staff_task_stats`.execute(db);
  const tier2Ms = performance.now() - t2;

  const sorted = [...samples].sort((a, b) => a - b);
  const max = sorted.at(-1) ?? 0;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;

  console.log(`
  status          ${result.status} · views refreshed: ${result.viewsRefreshed}
  clients         ${result.clients}
  TOTAL           ${Math.round(totalMs)}ms
  └─ Tier 2 (≈)   ${Math.round(tier2Ms)}ms      (the rest is Tier 1)

  ⭐ dashboard reads DURING the rollover — ${samples.length} samples
     p95 ${Math.round(p95)}ms · max ${Math.round(max)}ms

  NFR §3.1  < 5 min:              ${totalMs < BUDGET_MS ? 'PASS' : 'FAIL'}  (${Math.round(totalMs)}ms / ${BUDGET_MS}ms)
  NFR §3.1  API operational:      ${max < DASHBOARD_BUDGET_MS * 5 ? 'PASS' : 'FAIL'}  (worst read ${Math.round(max)}ms)
`);

  // A read that blocked for seconds is the ACCESS EXCLUSIVE signature — the one
  // thing CONCURRENTLY exists to prevent, and the reason this probe is here.
  if (max >= DASHBOARD_BUDGET_MS * 5) {
    console.error('[rollover-nfr] a dashboard read blocked — is the REFRESH still CONCURRENTLY?');
  }

  await cleanup();
}

main()
  .catch((err) => {
    console.error('[rollover-nfr] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // destroy() ends the underlying pool — calling pool.end() after it throws
    // 'Called end on pool more than once' and masks the real result.
    await db.destroy();
  });
