import { SYSTEM_ACTOR_UUID } from '@skaly/shared';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

import type * as PeriodGeneration from '../../src/services/period-generation.js';
import type { DB } from '@skaly/shared';
import type { CompiledQuery } from 'kysely';

/**
 * ⭐ THE ROLLOVER SUITE — tested against FAILURE, not success (ADR-035/036/037).
 *
 * This is the one path where "it errored" and "it corrupted the month" look
 * identical from the outside: both produce a non-2xx and an unhappy admin. The
 * difference is only visible in the database, so every failure test here asserts
 * the ABSENCE OF PARTIAL STATE, not merely the presence of an error.
 *
 * The AI summary is mocked at `lib/anthropic.js` — never the real API. A test
 * suite that calls Anthropic from a rollback assertion is a test suite that fails
 * when someone's key expires.
 */
const summaryText = 'The new month could not be set up. No existing data was changed.';
let anthropicBehaviour: 'ok' | 'throw' = 'ok';

vi.mock('../../src/lib/anthropic.js', () => ({
  getAnthropic: () => ({
    messages: {
      create: async () => {
        if (anthropicBehaviour === 'throw') {
          // What an exhausted SDK retry budget looks like to the caller: it throws.
          // maxRetries lives in the SDK (Sprint 8 amendment), so "past retries" and
          // "threw" are the same observable event — there is no loop of ours to
          // exhaust separately.
          throw new Error('529 overloaded (retries exhausted)');
        }
        return { content: [{ type: 'text', text: summaryText }] };
      },
    },
  }),
}));

/**
 * Step 1 of Tier 1. Wrapped rather than replaced (`importOriginal`) so the happy
 * path in this same file still exercises the REAL generator — a suite that stubs
 * the thing it is asserting about proves only that the stub works.
 */
let periodRowsBehaviour: 'ok' | 'throw' = 'ok';

vi.mock('../../src/services/period-generation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PeriodGeneration>();
  return {
    ...actual,
    generatePeriodRows: async (...args: Parameters<typeof actual.generatePeriodRows>) => {
      if (periodRowsBehaviour === 'throw') throw new Error('injected: row generation exploded');
      return actual.generatePeriodRows(...args);
    },
  };
});

const { RolloverService, RolloverFailure } = await import('../../src/services/RolloverService.js');
const { ContentDropperService } = await import('../../src/services/ContentDropperService.js');
const { AuditService } = await import('../../src/services/AuditService.js');

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

// Own periods, far from every other suite's (see local-db-fixture hazards).
const PERIOD = '2094-07';
const PRIOR = '2094-06';
const ALL = [PERIOD, PRIOR];

const ADMIN_ID = 'a0000000-0000-4000-8000-0000000r0113'.replace('r', 'a');
const STAFF_ID = 'a0000000-0000-4000-8000-0000000a0114';
const CLIENT_ID = 'c0000000-0000-4000-8000-0000000c0113';

const svc = new RolloverService();

/**
 * A `db` whose materialised-view REFRESH always fails, and NOTHING ELSE does.
 *
 * A Proxy rather than a `views` parameter on the service: an injection point that
 * only tests use is a production knob whose only setting is "correct", and the
 * whole claim under test is that Tier 2 fails INDEPENDENTLY — which is only
 * interesting if Tier 1 ran against the same real database.
 */
function withFailingRefresh(real: Kysely<DB>): Kysely<DB> {
  // `sql`…`.execute(db)` resolves the executor via db.getExecutor() and calls
  // executeQuery on THAT — not on the Kysely instance — so the interception has to
  // sit one level down. (Proxying `executeQuery` on the instance silently does
  // nothing, which presents as a Tier 2 test that passes for the wrong reason.)
  const proxyExecutor = (executor: { executeQuery: (q: CompiledQuery, o?: unknown) => unknown }) =>
    new Proxy(executor, {
      get(target, prop) {
        if (prop === 'executeQuery') {
          return async (compiled: CompiledQuery, options?: unknown) => {
            if (compiled.sql.includes('REFRESH MATERIALIZED VIEW')) {
              throw new Error('injected: could not refresh dashboard view');
            }
            return target.executeQuery(compiled, options);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'getExecutor') {
        return () => proxyExecutor(target.getExecutor() as never);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Kysely<DB>;
}

/**
 * Everything a rollover creates, counted. All zeroes = a clean rollback.
 *
 * The client-scoped tables are counted for OUR client only: rollover generates
 * rows for every active client, and the dev seed's clients share this database.
 * A global count here would assert against whatever else happens to be seeded.
 */
async function stateFor(period: string) {
  const count = async (table: 'attendance_logs' | 'content_pipelines' | 'shoot_schedules' | 'content_calendar') => {
    let q = db
      .selectFrom(table)
      .select((eb) => eb.fn.countAll().as('n'))
      .where('period', '=', period);
    if (table !== 'attendance_logs') q = q.where('client_id', '=', CLIENT_ID);
    const r = await q.executeTakeFirstOrThrow();
    return Number(r.n);
  };
  const month = await db
    .selectFrom('months')
    .select(['rollover_completed_at', 'view_refreshed_at', 'rollover_failed_step'])
    .where('period', '=', period)
    .executeTakeFirst();
  return {
    month: month ?? null,
    attendance: await count('attendance_logs'),
    pipelines: await count('content_pipelines'),
    slots: await count('shoot_schedules'),
    cells: await count('content_calendar'),
  };
}

async function notificationsOfType(type: string, period: string) {
  return db
    .selectFrom('notifications')
    .select(['id', 'staff_id', 'type', 'title', 'message', 'payload'])
    .where('type', '=', type)
    .where(sql<boolean>`payload->>'period' = ${period}`)
    .execute();
}

/** The first of a type, or a throw — never `undefined` silently satisfying a matcher. */
async function firstNotificationOfType(type: string, period: string) {
  const [first] = await notificationsOfType(type, period);
  if (!first) throw new Error(`expected at least one ${type} notification for ${period}`);
  return first;
}

async function cleanup() {
  // By PERIOD, not by staff_id: the admin fan-out reaches every active admin in the
  // database, including the dev seed's. Cleaning only our own fixtures leaves those
  // rows behind, and the next test's `[first]` assertion then reads a notification
  // from a previous test — which passes or fails on execution order.
  await db
    .deleteFrom('notifications')
    .where(sql<boolean>`payload->>'period' = ANY(${ALL})`)
    .execute();
  await db.deleteFrom('notifications').where('staff_id', 'in', [ADMIN_ID, STAFF_ID, SYSTEM_ACTOR_UUID]).execute();
  // record_id is NULL for months rows (UUID column, CHAR(7) key) — match on the
  // period inside new_value, which is where it actually lives.
  await db
    .deleteFrom('audit_log')
    .where('table_name', '=', 'months')
    .where(sql<boolean>`new_value->>'period' = ANY(${ALL})`)
    .execute();
  for (const t of ['content_calendar', 'shoot_schedules', 'content_pipelines', 'attendance_logs'] as const) {
    await db.deleteFrom(t).where('period', 'in', ALL).execute();
  }
  await db.deleteFrom('months').where('period', 'in', ALL).execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: SYSTEM_ACTOR_UUID, name: 'System', email: 'system@skaly.internal', role: 'admin', active: true },
      { id: ADMIN_ID, name: 'Rollover Admin', email: 'rollover-admin@test.skaly.in', role: 'admin', active: true },
      { id: STAFF_ID, name: 'Rollover Member', email: 'rollover-member@test.skaly.in', role: 'team_member', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('clients')
    .values({ id: CLIENT_ID, name: 'Rollover Test Client', shoot_slots_per_month: 2, pieces_per_visit: 3, active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await cleanup();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  anthropicBehaviour = 'ok';
  periodRowsBehaviour = 'ok';
  await cleanup();
});

/**
 * Fail exactly one Tier 1 step, and only that one.
 *
 * The `audit` case has to silence the recompute first: `recomputeComingShootDateIn`
 * writes its OWN audit entry, so a bare `AuditService.log` rejection lands at step
 * `recompute` and never reaches the rollover's own audit write. That is a correct
 * outcome for the service and a useless one for a test claiming to inject at
 * `audit` — it would assert the wrong step's rollback while reading as the right one.
 */
function injectFailureAt(step: 'period_rows' | 'recompute' | 'audit'): void {
  if (step === 'period_rows') {
    periodRowsBehaviour = 'throw';
    return;
  }
  if (step === 'recompute') {
    vi.spyOn(ContentDropperService.prototype, 'recomputeComingShootDateIn').mockRejectedValue(
      new Error('injected: recompute exploded'),
    );
    return;
  }
  vi.spyOn(ContentDropperService.prototype, 'recomputeComingShootDateIn').mockResolvedValue(undefined);
  vi.spyOn(AuditService.prototype, 'log').mockRejectedValue(new Error('injected: audit exploded'));
}

afterAll(async () => {
  await cleanup();
  await db.deleteFrom('staff').where('id', 'in', [ADMIN_ID, STAFF_ID]).execute();
  await db.deleteFrom('clients').where('id', '=', CLIENT_ID).execute();
  await db.destroy();
});

// ───────────────────────────── TIER 1 ROLLS BACK FULLY ──────────────────────────

describe('⭐ Tier 1 failure rolls back FULLY — no partial month survives', () => {
  // Every Tier 1 step, one test each. The assertion is the same every time and it
  // is NOT "it threw" — it is "it left nothing".
  test.each(['period_rows', 'recompute', 'audit'] as const)(
    'a failure at step %s leaves NO months row and NO period rows',
    async (step) => {
      injectFailureAt(step);

      await expect(svc.run(db, PERIOD)).rejects.toThrow(RolloverFailure);

      const after = await stateFor(PERIOD);
      expect(after.month, 'months row must not survive a Tier 1 failure').toBeNull();
      expect(after).toMatchObject({ attendance: 0, pipelines: 0, slots: 0, cells: 0 });
    },
  );

  test.each(['period_rows', 'recompute', 'audit'] as const)(
    'the thrown failure names step %s, so the notification can say which',
    async (step) => {
      injectFailureAt(step);
      await expect(svc.run(db, PERIOD)).rejects.toMatchObject({ step });
    },
  );

  test('rollover_failed reaches admins and NOT ordinary staff', async () => {
    injectFailureAt('audit');
    await expect(svc.run(db, PERIOD)).rejects.toThrow();

    const failed = await notificationsOfType('rollover_failed', PERIOD);
    expect(failed.map((n) => n.staff_id)).toContain(ADMIN_ID);
    expect(failed.map((n) => n.staff_id)).not.toContain(STAFF_ID);
    // No success notification may have escaped — Tier 1 never committed.
    expect(await notificationsOfType('month_ready', PERIOD)).toHaveLength(0);
    expect(await notificationsOfType('rollover_success', PERIOD)).toHaveLength(0);
  });
});

// ───────────────────────────── TIER 2 IS ISOLATED ───────────────────────────────

describe('⭐ Tier 2 failure does NOT roll back Tier 1', () => {
  test('the month persists, rollover_success already fired, and the call still succeeds', async () => {
    const result = await svc.run(withFailingRefresh(db), PERIOD);

    // The endpoint reports success: the month is intact, only the dashboard is stale.
    expect(result.status).toBe('completed');
    expect(result.viewsRefreshed).toBe(false);

    const after = await stateFor(PERIOD);
    expect(after.month?.rollover_completed_at, 'Tier 1 committed').not.toBeNull();
    expect(after.month?.view_refreshed_at, 'Tier 2 did not').toBeNull();
    expect(after.month?.rollover_failed_step).toBe('view_refresh');
    expect(after.pipelines).toBeGreaterThan(0);
    expect(after.attendance).toBeGreaterThan(0);

    // ⭐ THE BOUNDARY PROOF (ADR-035). refresh_failed WITHOUT a preceding success
    // would mean the tiers are entangled. Both present, in that order, is health.
    expect(await notificationsOfType('rollover_success', PERIOD)).not.toHaveLength(0);
    expect(await notificationsOfType('rollover_view_refresh_failed', PERIOD)).not.toHaveLength(0);
  });
});

// ───────────────────────────── IDEMPOTENCY ──────────────────────────────────────

describe('⭐ rollover is safe to run twice (ADR-037)', () => {
  test('two sequential runs create the period rows ONCE and fire month_ready ONCE', async () => {
    const first = await svc.run(db, PERIOD);
    const afterFirst = await stateFor(PERIOD);

    const second = await svc.run(db, PERIOD);
    const afterSecond = await stateFor(PERIOD);

    expect(first.status).toBe('completed');
    expect(second.status, 'the second run must do no work').toBe('already_completed');

    expect(afterSecond.attendance).toBe(afterFirst.attendance);
    expect(afterSecond.pipelines).toBe(afterFirst.pipelines);
    expect(afterSecond.slots).toBe(afterFirst.slots);
    expect(afterSecond.cells).toBe(afterFirst.cells);

    // One notification per recipient, not two. This is the assertion the whole
    // idempotency design exists to make true.
    const ready = await notificationsOfType('month_ready', PERIOD);
    expect(new Set(ready.map((n) => n.staff_id)).size).toBe(ready.length);
  });

  test('a retry after Tier 1 committed but Tier 2 failed RESUMES Tier 2 only', async () => {
    await svc.run(withFailingRefresh(db), PERIOD);
    const beforeRetry = await stateFor(PERIOD);
    const readyBefore = await notificationsOfType('month_ready', PERIOD);

    const retry = await svc.run(db, PERIOD); // real db — the refresh works now

    expect(retry.status).toBe('resumed');
    expect(retry.viewsRefreshed).toBe(true);

    const afterRetry = await stateFor(PERIOD);
    expect(afterRetry.month?.view_refreshed_at).not.toBeNull();
    expect(afterRetry.month?.rollover_failed_step, 'cleared on recovery').toBeNull();
    // Tier 1 was NOT re-run: same rows, same notifications.
    expect(afterRetry.attendance).toBe(beforeRetry.attendance);
    expect(afterRetry.pipelines).toBe(beforeRetry.pipelines);
    expect(await notificationsOfType('month_ready', PERIOD)).toHaveLength(readyBefore.length);
  });

  test('a months row that exists WITHOUT a rollover (seed, or a pre-emptive lock) still rolls over', async () => {
    // ADR-037 §3's second branch. Presence alone as the completion signal would
    // skip the first rollover after a seed and leave the month empty forever.
    await db.insertInto('months').values({ period: PERIOD, label: PERIOD, locked: false }).execute();

    const result = await svc.run(db, PERIOD);

    expect(result.status).toBe('completed');
    expect((await stateFor(PERIOD)).pipelines).toBeGreaterThan(0);
  });
});

// ───────────────────────────── AI-SUMMARY INDEPENDENCE ──────────────────────────

describe('⭐ the failure notification never depends on the AI summary (ADR-036 §2)', () => {
  test('Anthropic throwing past its retries leaves the TEMPLATED body intact', async () => {
    anthropicBehaviour = 'throw';
    injectFailureAt('audit');

    await expect(svc.run(db, PERIOD)).rejects.toThrow();

    // ⭐ THE WORST-CASE GUARD: the rollover broke AND the summary broke, and the
    // admin is still told. A notification that never arrived is the failure mode
    // this whole ordering exists to prevent.
    const notification = await firstNotificationOfType('rollover_failed', PERIOD);
    expect(notification, 'a failure notification must exist regardless').toBeDefined();
    expect(notification.message).toContain('failed at step audit');
    expect(notification.message).toContain('The previous month is intact');
    expect(notification.message).not.toContain(summaryText);
  });

  test('a successful summary ENRICHES the row, replacing the templated body', async () => {
    anthropicBehaviour = 'ok';
    injectFailureAt('audit');

    await expect(svc.run(db, PERIOD)).rejects.toThrow();

    const notification = await firstNotificationOfType('rollover_failed', PERIOD);
    expect(notification.message).toBe(summaryText);
  });

  test('the failure notification carries the inline [Manual rollover] action', async () => {
    injectFailureAt('audit');
    await expect(svc.run(db, PERIOD)).rejects.toThrow();

    const notification = await firstNotificationOfType('rollover_failed', PERIOD);
    // A failure summary with no recovery action is a dead-end (ADR-036 §4).
    expect(notification.payload).toMatchObject({ action: 'manual_rollover', period: PERIOD, failedStep: 'audit' });
  });
});

// ───────────────────────────── HAPPY PATH + INHERITED GUARDS ────────────────────

describe('the successful rollover', () => {
  test('creates every module’s rows, marks both tiers, and notifies all staff', async () => {
    const result = await svc.run(db, PERIOD);

    expect(result).toMatchObject({ period: PERIOD, status: 'completed', viewsRefreshed: true });

    const after = await stateFor(PERIOD);
    expect(after.month?.rollover_completed_at).not.toBeNull();
    expect(after.month?.view_refreshed_at).not.toBeNull();
    expect(after.attendance).toBeGreaterThan(0);
    expect(after.pipelines).toBeGreaterThan(0);
    expect(after.slots).toBe(2); // shoot_slots_per_month
    expect(after.cells).toBe(31); // July has 31 days — derived, never hardcoded in src

    // month_ready to everyone, rollover_success to admins only.
    const ready = await notificationsOfType('month_ready', PERIOD);
    expect(ready.map((n) => n.staff_id)).toEqual(expect.arrayContaining([ADMIN_ID, STAFF_ID]));
    const success = await notificationsOfType('rollover_success', PERIOD);
    expect(success.map((n) => n.staff_id)).toContain(ADMIN_ID);
    expect(success.map((n) => n.staff_id)).not.toContain(STAFF_ID);
  });

  test("a client's manual coming_shoot_date is NOT overwritten (ADR-034 inherited)", async () => {
    await svc.run(db, PRIOR);
    await db
      .updateTable('content_pipelines')
      .set({ coming_shoot_date: '2094-06-15', coming_shoot_source: 'manual' })
      .where('period', '=', PRIOR)
      .where('client_id', '=', CLIENT_ID)
      .execute();

    // Re-running the recompute over PRIOR must leave the override alone. Rollover
    // calls the same guarded function the live trigger does — the guard is the part
    // that silently erases an admin's override at 00:01 if it is ever duplicated.
    await svc.run(db, PERIOD);

    const row = await db
      .selectFrom('content_pipelines')
      .select(['coming_shoot_source'])
      .where('period', '=', PRIOR)
      .where('client_id', '=', CLIENT_ID)
      .executeTakeFirstOrThrow();
    expect(row.coming_shoot_source).toBe('manual');
  });

  test('the audit entry is attributed to the System Actor with source system (C-04)', async () => {
    await svc.run(db, PERIOD);

    const entry = await db
      .selectFrom('audit_log')
      .select(['staff_id', 'changed_by_source', 'table_name'])
      .where('table_name', '=', 'months')
      .where(sql<boolean>`new_value->>'period' = ${PERIOD}`)
      .executeTakeFirstOrThrow();
    expect(entry.staff_id).toBe(SYSTEM_ACTOR_UUID);
    expect(entry.changed_by_source).toBe('system');
  });

  test('timing sanity: a representative rollover is far inside the NFR §3.1 5-minute budget', async () => {
    const started = Date.now();
    await svc.run(db, PERIOD);
    expect(Date.now() - started).toBeLessThan(300_000);
  });
});
