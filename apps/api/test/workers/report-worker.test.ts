import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { healthRoutes } from '../../src/routes/health.js';
import { currentIstPeriod } from '../../src/services/BaseService.js';
import { ReportService } from '../../src/services/ReportService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type { DB } from '@skaly/shared';
import type { FastifyInstance } from 'fastify';

/**
 * ⭐ ADR-027 IN ONE ASSERTION.
 *
 * This is the only test that spawns the REAL worker thread. ReportService's suite
 * fakes the worker to drive the four exit paths; report-render.test.ts renders
 * in-process. Neither would notice if the render were still on the request event
 * loop — which is exactly the trap the ADR names, because that mistake passes code
 * review: there is an `await`, there is a 202, and the block just moves.
 *
 * So: fire a real generate, and while the render runs, hit /v1/health on the main
 * thread. If the render were synchronous here, the health check would queue behind
 * it and the number would be seconds, not milliseconds — and INFRA §4 sets
 * healthcheckTimeout to 30s, which makes that a restart loop rather than a slow
 * report.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const PERIOD = currentIstPeriod();
const DOMAIN = '@repworker.itest';
const adminId = randomUUID();
const admin: CurrentUser = { staffId: adminId, role: 'admin' };

let app: FastifyInstance;
let baseUrl: string;

/** R2 secrets are present locally and may not be in CI, so the upload half of
 *  the assertion is conditional while the render half never is. */
const r2Configured = Boolean(
  process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_BUCKET_NAME,
);

async function cleanup() {
  const mine = db.selectFrom('staff').select('id').where('email', 'like', `%${DOMAIN}`);
  await db.deleteFrom('notifications').where('staff_id', 'in', mine).execute();
  await db.deleteFrom('reports').where('generated_by', 'in', mine).execute();
  await db.deleteFrom('audit_log').where('staff_id', 'in', mine).execute();
  await db.deleteFrom('staff').where('email', 'like', `%${DOMAIN}`).execute();
}

beforeAll(async () => {
  await cleanup();
  await db
    .insertInto('staff')
    .values({ id: adminId, name: 'Worker Admin', email: `admin${DOMAIN}`, role: 'admin', active: true })
    .execute();
  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();

  app = Fastify({ logger: false });
  // The real /v1/health probes both dependencies, so the latency measured below
  // is the endpoint's actual cost — not a hello-world that would stay fast even
  // if the pool were starved.
  app.decorate('pool', pool);
  app.decorate('redis', new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'));
  await app.register(healthRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.redis.quit();
  await app.close();
  await cleanup();
  await db.destroy();
});

async function terminalStatus(id: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db
      .selectFrom('reports')
      .select(['status', 'file_key', 'error_message'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (row && row.status !== 'pending') return row;
    if (Date.now() > deadline) throw new Error(`report ${id} still pending after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('the real worker thread', () => {
  test('⭐ /v1/health stays responsive while a report renders', async () => {
    const svc = new ReportService(); // the REAL defaultSpawn — no injected fake
    const { reportId } = await svc.generate({ type: 'org_monthly', period: PERIOD }, admin, db);

    // Sample continuously until the row settles. Every sample is taken while the
    // worker is doing something — spawning, connecting, querying, or rendering.
    const samples: number[] = [];
    const statuses = new Set<number>();
    let sampling = true;
    const probe = (async () => {
      while (sampling) {
        const t = Date.now();
        // No assertion inside the loop: a throw here would abort the probe and
        // leave `samples` empty, which reads as "the API was fine" — the exact
        // opposite of what an unhealthy API means.
        const res = await fetch(`${baseUrl}/v1/health`).catch(() => null);
        samples.push(Date.now() - t);
        statuses.add(res?.status ?? 0);
        await new Promise((r) => setTimeout(r, 25));
      }
    })();

    const row = await terminalStatus(reportId, 60_000);
    sampling = false;
    await probe;

    const worst = Math.max(...samples);
    expect(samples.length, 'the probe must actually have run').toBeGreaterThan(10);
    expect([...statuses], 'health must answer 200 throughout').toEqual([200]);
    // If the render were on the request event loop, the health check would queue
    // behind a multi-second synchronous call and this would be in the thousands.
    expect(worst, `worst health latency ${worst}ms over ${samples.length} samples`).toBeLessThan(
      500,
    );

    // And the render genuinely happened — a test that passes because nothing ran
    // proves nothing at all, and "fast because it crashed instantly" is exactly
    // the false green this assertion would otherwise be prone to.
    if (r2Configured) {
      expect(row.status, row.error_message ?? '').toBe('ready');
      expect(row.file_key).toMatch(/^reports\/.+\.pdf$/);
    } else {
      // Without R2 credentials the upload cannot succeed, but the RENDER still
      // ran on the worker thread — which is what is under test. A failure to
      // render would be a real defect and must not pass silently.
      expect(row.status).toBe('failed');
      expect(row.error_message ?? '', row.error_message ?? '').not.toMatch(/render|font|jsx/i);
    }
  }, 120_000);

  test('the worker resolves its own module path in this runtime', async () => {
    // The spawn is the part that ships broken: dev runs .ts under tsx, vitest
    // transforms in-process, and production runs dist/*.js. A hard-coded
    // extension works in exactly one of the three. If the bootstrap were wrong
    // this row would come back `failed` with a module-resolution error.
    const svc = new ReportService();
    const { reportId } = await svc.generate({ type: 'org_monthly', period: PERIOD }, admin, db);
    const row = await terminalStatus(reportId, 60_000);
    expect(row.error_message ?? '', row.error_message ?? '').not.toMatch(
      /cannot find|ERR_MODULE_NOT_FOUND|Unknown file extension/i,
    );
  }, 120_000);
});
