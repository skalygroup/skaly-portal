/**
 * NFR §1.2 report-generation measurement: p95 < 10s, p99 < 20s.
 *
 * The sprint bar is "numbers, not vibes", and the number has to come from the
 * REAL path — `ReportService.generate` with the production `defaultSpawn`, a real
 * worker thread, a real R2 upload. Every faster way to get a figure measures
 * something else: the in-process render skips the thread, and the faked worker
 * skips the render entirely.
 *
 *   pnpm --filter @skaly/api exec tsx scripts/measure-report-nfr.ts [runs]
 *
 * SEQUENTIAL, one render at a time. MAX_CONCURRENT_RENDERS is 2, so a parallel
 * batch would measure queue depth — which is a throughput question, not the
 * latency NFR §1.2 states.
 *
 * Run it at representative volume or the number is meaningless:
 *   pnpm --filter @skaly/api exec tsx scripts/seed-perf-clients.ts 20
 * The client/period row counts are printed with the timings so a recorded result
 * always carries the volume it was taken at.
 *
 * With n=10, p95 and p99 are both the slowest run — 10 samples cannot resolve a
 * 99th percentile. That is what the sprint asks for; it is a ceiling check
 * against the worst observed render, not a distribution estimate.
 */
import { randomUUID } from 'node:crypto';

import { db, pool } from '../src/lib/db.js';
import { currentIstPeriod } from '../src/services/BaseService.js';
import { ReportService } from '../src/services/ReportService.js';

import type { CurrentUser } from '../src/services/AttendanceService.js';

const EMAIL = 'nfr-measure@perf.local';

async function terminal(reportId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db
      .selectFrom('reports')
      .select(['status', 'file_key', 'error_message'])
      .where('id', '=', reportId)
      .executeTakeFirst();
    if (row && row.status !== 'pending') return row;
    if (Date.now() > deadline) throw new Error(`report ${reportId} still pending after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Nearest-rank percentile: the smallest sample at or above the p-th position.
 *  No interpolation — an interpolated p99 of 10 samples invents a value that was
 *  never measured. */
function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('measure-report-nfr renders real reports — refusing to run in production.');
  }

  const runs = Number(process.argv[2] ?? 10);
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`Bad run count: ${process.argv[2]}`);

  const period = currentIstPeriod();
  await db
    .insertInto('months')
    .values({ period, label: period, locked: false })
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();

  // Select-then-insert rather than ON CONFLICT (email): staff_email_unique is a
  // PARTIAL index (WHERE deleted_at IS NULL) since Sprint 11, and a bare
  // `ON CONFLICT (email)` cannot infer a partial index — it errors instead.
  const actor =
    (await db.selectFrom('staff').select('id').where('email', '=', EMAIL).executeTakeFirst()) ??
    (await db
      .insertInto('staff')
      .values({ id: randomUUID(), name: 'NFR Measure', email: EMAIL, role: 'admin', active: true })
      .returning('id')
      .executeTakeFirstOrThrow());
  await db.updateTable('staff').set({ active: true, deleted_at: null }).where('id', '=', actor.id).execute();
  const admin: CurrentUser = { staffId: actor.id, role: 'admin' };

  const clients = await db
    .selectFrom('clients')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('active', '=', true)
    .where('deleted_at', 'is', null)
    .where('is_internal', '=', false)
    .executeTakeFirstOrThrow();
  const cells = await db
    .selectFrom('content_calendar')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('period', '=', period)
    .executeTakeFirstOrThrow();
  console.log(
    `period ${period} · ${clients.n} active non-internal clients · ${cells.n} calendar cells · ${runs} runs\n`,
  );

  const svc = new ReportService(); // real defaultSpawn — a real thread per run
  const times: number[] = [];
  const failures: string[] = [];

  for (let i = 1; i <= runs; i++) {
    const started = Date.now();
    const { reportId } = await svc.generate({ type: 'org_monthly', period }, admin, db);
    const row = await terminal(reportId);
    const ms = Date.now() - started;
    times.push(ms);
    if (row.status !== 'ready') failures.push(`run ${i}: ${row.status} — ${row.error_message}`);
    console.log(`run ${String(i).padStart(2)}  ${String(ms).padStart(6)}ms  ${row.status}`);
  }

  // Clean up the rows this run created; the staff actor stays deactivated rather
  // than deleted so the audit_log rows it wrote keep their FK.
  await db.deleteFrom('reports').where('generated_by', '=', actor.id).execute();
  await db.deleteFrom('notifications').where('staff_id', '=', actor.id).execute();
  await db.updateTable('staff').set({ active: false }).where('id', '=', actor.id).execute();

  const sorted = [...times].sort((a, b) => a - b);
  const p95 = pct(sorted, 95);
  const p99 = pct(sorted, 99);
  console.log(
    `\nmin ${sorted[0]}ms · p50 ${pct(sorted, 50)}ms · p95 ${p95}ms · p99 ${p99}ms · max ${sorted.at(-1)}ms`,
  );
  console.log(`NFR §1.2  p95 < 10000ms: ${p95 < 10_000 ? 'PASS' : 'FAIL'}  ·  p99 < 20000ms: ${p99 < 20_000 ? 'PASS' : 'FAIL'}`);

  // A run of ten instant `failed` rows would otherwise print a triumphant p95.
  if (failures.length > 0) {
    console.error(`\n${failures.length}/${runs} did NOT reach 'ready' — the timings above are not a render measurement:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
