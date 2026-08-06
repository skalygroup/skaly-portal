/**
 * ADR-027's two load properties, re-checked at representative volume (STEP 10).
 *
 * `measure-report-nfr.ts` answers the LATENCY question one render at a time.
 * This answers the two that only appear under a batch:
 *
 *   1. The API stays responsive while renders run. That is the whole reason the
 *      render moved to a worker thread — so `GET /v1/health` is injected against
 *      the REAL app, on the REAL event loop, while the batch is in flight. If a
 *      render ever came back onto the main thread, this is the number that moves.
 *      Injected rather than fetched over TCP on purpose: it isolates the event
 *      loop from the network, which is the property under test.
 *
 *   2. More requests than the cap QUEUE rather than spawning unbounded threads.
 *      `running` is private, so the count is taken where the threads actually
 *      appear — `spawn` is a public field, so wrapping it counts every worker
 *      that is created and every one that exits. Peak > MAX_CONCURRENT_RENDERS
 *      means the queue is not holding.
 *
 *   pnpm --filter @skaly/api exec tsx scripts/measure-report-load.ts [requests]
 *
 * Seed representative volume first, or this measures an empty month:
 *   pnpm --filter @skaly/api exec tsx scripts/seed-perf-clients.ts 20
 */
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.js';
import { db, pool } from '../src/lib/db.js';
import { currentIstPeriod } from '../src/services/BaseService.js';
import { ReportService } from '../src/services/ReportService.js';

import type { CurrentUser } from '../src/services/AttendanceService.js';
import type { ReportWorkerInput } from '../src/workers/report-worker.js';
import type { Worker } from 'node:worker_threads';

const EMAIL = 'nfr-load@perf.local';

/** ReportService's cap (ADR-027). Duplicated as an EXPECTATION, not a source of
 *  truth — the point is to fail if the service's own value stops holding. */
const EXPECTED_CAP = 2;

/** How responsive is responsive. A health probe that has to wait behind a render
 *  is the failure this bound catches; anything near the render's seconds is a
 *  blocked event loop. */
const HEALTH_P95_BUDGET_MS = 250;

const HEALTH_SAMPLE_INTERVAL_MS = 100;

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function terminal(reportId: string, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db
      .selectFrom('reports')
      .select(['status', 'error_message'])
      .where('id', '=', reportId)
      .executeTakeFirst();
    if (row && row.status !== 'pending') return row;
    if (Date.now() > deadline) throw new Error(`report ${reportId} still pending after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('measure-report-load renders real reports — refusing to run in production.');
  }

  const requests = Number(process.argv[2] ?? 8);
  if (!Number.isInteger(requests) || requests < 1) throw new Error(`Bad request count: ${process.argv[2]}`);

  const period = currentIstPeriod();
  await db
    .insertInto('months')
    .values({ period, label: period, locked: false })
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();

  const actor =
    (await db.selectFrom('staff').select('id').where('email', '=', EMAIL).executeTakeFirst()) ??
    (await db
      .insertInto('staff')
      .values({ id: randomUUID(), name: 'NFR Load', email: EMAIL, role: 'admin', active: true })
      .returning('id')
      .executeTakeFirstOrThrow());
  await db.updateTable('staff').set({ active: true, deleted_at: null }).where('id', '=', actor.id).execute();
  const admin: CurrentUser = { staffId: actor.id, role: 'admin' };

  const app = await buildApp();

  const svc = new ReportService();
  const realSpawn = svc.spawn;
  let active = 0;
  let peak = 0;
  svc.spawn = (input: ReportWorkerInput): Worker => {
    active += 1;
    peak = Math.max(peak, active);
    const worker = realSpawn(input);
    worker.once('exit', () => {
      active -= 1;
    });
    return worker;
  };

  // ── Health sampling, for as long as the batch runs ──────────────────────────
  const healthMs: number[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const t0 = Date.now();
      const res = await app.inject({ method: 'GET', url: '/v1/health' });
      healthMs.push(Date.now() - t0);
      if (res.statusCode !== 200) console.warn(`health returned ${res.statusCode}`);
      await new Promise((r) => setTimeout(r, HEALTH_SAMPLE_INTERVAL_MS));
    }
  })();

  console.log(`period ${period} · firing ${requests} concurrent org_monthly requests (cap ${EXPECTED_CAP})\n`);

  const started = Date.now();
  const accepted = await Promise.all(
    Array.from({ length: requests }, async () => {
      const t0 = Date.now();
      const { reportId } = await svc.generate({ type: 'org_monthly', period }, admin, db);
      return { reportId, acceptMs: Date.now() - t0 };
    }),
  );
  const acceptMs = accepted.map((a) => a.acceptMs).sort((a, b) => a - b);
  console.log(`accept p95 ${pct(acceptMs, 95)}ms (max ${acceptMs.at(-1)}ms) — the 202 must not wait on a slot`);

  const outcomes = await Promise.all(accepted.map((a) => terminal(a.reportId)));
  const drainMs = Date.now() - started;

  sampling = false;
  await sampler;
  await app.close();

  await db.deleteFrom('reports').where('generated_by', '=', actor.id).execute();
  await db.deleteFrom('notifications').where('staff_id', '=', actor.id).execute();
  await db.updateTable('staff').set({ active: false }).where('id', '=', actor.id).execute();

  const failed = outcomes.filter((o) => o.status !== 'ready');
  const health = [...healthMs].sort((a, b) => a - b);
  const healthP95 = pct(health, 95);

  console.log(`\nqueue drained in ${drainMs}ms · peak concurrent workers ${peak} · ${requests - failed.length}/${requests} ready`);
  console.log(
    `health probes ${health.length} · p50 ${pct(health, 50)}ms · p95 ${healthP95}ms · max ${health.at(-1)}ms`,
  );
  console.log(`ADR-027  peak <= ${EXPECTED_CAP}: ${peak <= EXPECTED_CAP ? 'PASS' : 'FAIL'}`);
  console.log(`ADR-027  health p95 < ${HEALTH_P95_BUDGET_MS}ms during renders: ${healthP95 < HEALTH_P95_BUDGET_MS ? 'PASS' : 'FAIL'}`);
  console.log(`         every request drained: ${failed.length === 0 ? 'PASS' : 'FAIL'}`);

  if (peak > EXPECTED_CAP || healthP95 >= HEALTH_P95_BUDGET_MS || failed.length > 0) {
    for (const f of failed) console.error(`  ${f.status}: ${f.error_message}`);
    process.exitCode = 1;
  }
}

main()
  .then(async () => {
    await pool.end();
    // buildApp() leaves the socket server and the Redis clients holding the event
    // loop open, so the process sits there after the last line is printed. Unlike
    // the API itself, a measurement script is done when it has printed its answer.
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
