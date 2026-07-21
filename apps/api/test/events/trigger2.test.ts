import { SYSTEM_ACTOR_UUID } from '@skaly/shared';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import { registerEventListeners } from '../../src/events/listeners.js';
import { currentIstDate } from '../../src/services/BaseService.js';
import { ClientService } from '../../src/services/ClientService.js';
import { ContentDropperService } from '../../src/services/ContentDropperService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type * as SocketsModule from '../../src/sockets/index.js';
import type { DB } from '@skaly/shared';
import type { Logger } from 'pino';

// Trigger 2 — the REAL EventBus loop (Testing-Strategy §5.1, ADR-013). Marking a
// pipeline Posted fires pipeline:posted → the registered listener writes that
// client's content_calendar cell for the POSTED DATE and broadcasts
// content-calendar:updated. This is where the canonical "pipeline posted
// triggers content_calendar cell to Posted" test finally passes.
//
// The listener is fire-and-forget (`void applyPosted(...)`), so after
// updateStage() returns the cell write may still be in flight — hence
// waitFor/settle, exactly as trigger1.test.ts does.
//
// Real local Postgres. The pipeline lives in an own synthetic period (2097-03);
// the CELL necessarily lives in the real current IST period, because the trigger
// derives its target from postedAt = today. Cell cleanup is therefore keyed on
// this suite's own client id, never on a period — it must not touch real rows.

// Hoisted so the vi.mock factory (which is hoisted above const declarations) can
// close over it. One spy, all three API-Contract §6 org broadcasts.
const { broadcasts } = vi.hoisted(() => ({
  broadcasts: [] as { event: string; payload: Record<string, unknown> }[],
}));

vi.mock('../../src/sockets/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SocketsModule>();
  return {
    ...actual,
    // The real one calls getIo(), which throws with no socket server attached
    // and is swallowed — so a spy is the only way to observe an emit here.
    broadcastToOrg: (event: string, payload: Record<string, unknown>) => {
      broadcasts.push({ event, payload });
    },
  };
});

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const dropper = new ContentDropperService();
const clients = new ClientService();

/** The pipeline's own period — deliberately NOT the period the cell lives in. */
const PIPELINE_PERIOD = '2097-03';
/** Where the cell must land: derived from postedAt = today (IST), not from above. */
const TODAY = currentIstDate();
const CURRENT_PERIOD = TODAY.slice(0, 7);
const DOMAIN = '@trigger2.itest';

const MANAGER_ID = 'f2000000-0000-4000-8000-00000000f201';
const CLIENT_ID = 'f2000000-0000-4000-8000-00000000f2c1';
const manager: CurrentUser = { staffId: MANAGER_ID, role: 'manager' };

const silentLog = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: (o: unknown) => console.error('trigger2 error', o),
} as unknown as Logger;

/** Poll until truthy — the async listener barrier. */
async function waitFor<T>(fn: () => Promise<T>, timeout = 3000, interval = 25): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Give the fire-and-forget listener time to run when asserting a NON-change. */
const settle = () => new Promise((r) => setTimeout(r, 350));

/** A pipeline already through raw + finals, so 'posted' is a legal next stage. */
async function seedPostablePipeline(period = PIPELINE_PERIOD): Promise<{ id: string; version: number }> {
  const row = await db
    .insertInto('content_pipelines')
    .values({
      period,
      client_id: CLIENT_ID,
      raw_received_at: new Date(),
      finals_ready_at: new Date(),
      version: 1,
    })
    .returning(['id', 'version'])
    .executeTakeFirstOrThrow();
  return row;
}

/**
 * The cell the trigger should target. `source` is left NULL explicitly — that is
 * the state generatePeriodRows produces and the state the null-safety guard has
 * to cope with. A fixture with a non-NULL source would let a broken
 * `source != 'manual'` guard pass these tests.
 */
async function seedTodayCell(
  over: Partial<{ status: string; source: string }> = {},
): Promise<string> {
  const row = await db
    .insertInto('content_calendar')
    .values({
      period: CURRENT_PERIOD,
      client_id: CLIENT_ID,
      date: TODAY,
      status: 'No Activity',
      source: null,
      version: 1,
      ...over,
    } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function readCell(id: string) {
  return db
    .selectFrom('content_calendar')
    .select(['status', 'source', 'version', 'updated_by'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

async function cleanupData() {
  broadcasts.length = 0;
  // Keyed on THIS suite's client, never on a period — the current period holds
  // real rows this suite must not delete.
  await db.deleteFrom('content_calendar').where('client_id', '=', CLIENT_ID).execute();
  await db.deleteFrom('content_pipelines').where('client_id', '=', CLIENT_ID).execute();
  await db.deleteFrom('audit_log').where('table_name', '=', 'content_calendar').where('staff_id', '=', SYSTEM_ACTOR_UUID).execute();
}

beforeAll(async () => {
  // Register the REAL listeners against this test's db so the trigger fires.
  registerEventListeners(db, silentLog);

  await db
    .insertInto('staff')
    .values([
      { id: MANAGER_ID, name: 'Trigger2 Manager', email: `mgr-${MANAGER_ID}${DOMAIN}`, role: 'manager', active: true },
      { id: SYSTEM_ACTOR_UUID, name: 'System', email: 'system@skaly.internal', role: 'admin', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  // The current period's months row already exists in a seeded DB; the synthetic
  // pipeline period does not. doNothing so a real month's lock is never touched.
  await db
    .insertInto('months')
    .values([
      { period: PIPELINE_PERIOD, label: PIPELINE_PERIOD, locked: false },
      { period: CURRENT_PERIOD, label: CURRENT_PERIOD, locked: false },
    ])
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();

  await db
    .insertInto('clients')
    .values({ id: CLIENT_ID, name: 'Trigger2 Client', shoot_slots_per_month: 4, pieces_per_visit: 3, active: true, is_internal: false })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await cleanupData();
});

afterEach(cleanupData);

afterAll(async () => {
  await cleanupData();
  await db.destroy();
});

describe('Trigger 2 — pipeline:posted → content_calendar via the real EventBus', () => {
  test('CANONICAL (Testing-Strategy §5.1): marking a pipeline Posted sets that client’s cell for today to Posted/pipeline_trigger', async () => {
    const cellId = await seedTodayCell();
    const pipeline = await seedPostablePipeline();

    // Reconciliation #11: the canonical test writes markStage(pipeline.id,
    // 'posted') — 2 args. The as-built requires an actor and a version (C-02),
    // so the CALL is adapted to the service, never the service to the call.
    await dropper.updateStage(pipeline.id, 'posted', manager, pipeline.version, db);

    const cell = await waitFor(async () => {
      const c = await readCell(cellId);
      return c.status === 'Posted' ? c : null;
    });
    expect(cell.status).toBe('Posted');
    expect(cell.source).toBe('pipeline_trigger');
  });

  test('CORRECTION 1 (null-safety): the cell’s source starts NULL and IS written', async () => {
    const cellId = await seedTodayCell(); // source explicitly NULL

    // Prove the precondition — otherwise this test could pass against a broken
    // `source != 'manual'` guard simply because the fixture had a value.
    expect((await readCell(cellId)).source).toBeNull();

    const pipeline = await seedPostablePipeline();
    await dropper.updateStage(pipeline.id, 'posted', manager, pipeline.version, db);

    await waitFor(async () => ((await readCell(cellId)).status === 'Posted' ? true : null));
    expect((await readCell(cellId)).source).toBe('pipeline_trigger');
  });

  test('CORRECTION 2 (period derivation): a pipeline in another period still updates TODAY’s cell', async () => {
    const cellId = await seedTodayCell();
    // The pipeline belongs to 2097-03; the cell lives in the current period.
    const pipeline = await seedPostablePipeline(PIPELINE_PERIOD);
    expect(PIPELINE_PERIOD).not.toBe(CURRENT_PERIOD);

    await dropper.updateStage(pipeline.id, 'posted', manager, pipeline.version, db);

    await waitFor(async () => ((await readCell(cellId)).status === 'Posted' ? true : null));
    // Using the event's `period` would have looked in 2097-03 and matched nothing.
    expect(broadcasts.find((b) => b.event === 'content-calendar:updated')?.payload).toEqual({
      clientId: CLIENT_ID,
      period: CURRENT_PERIOD,
      date: TODAY,
    });
  });

  test('CORRECTION 3 (missing cell): the listener no-ops, creates nothing, and the pipeline write still succeeded', async () => {
    // No cell seeded at all.
    const pipeline = await seedPostablePipeline();

    const updated = await dropper.updateStage(pipeline.id, 'posted', manager, pipeline.version, db);
    await settle();

    // The pipeline half committed regardless — a calendar miss must not undo it.
    expect(updated.postedAt).not.toBeNull();

    const cells = await db
      .selectFrom('content_calendar')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('client_id', '=', CLIENT_ID)
      .executeTakeFirstOrThrow();
    expect(Number(cells.n)).toBe(0); // nothing created
    expect(broadcasts.filter((b) => b.event === 'content-calendar:updated')).toHaveLength(0);
  });

  test('the manual guard: a manual cell keeps its status AND its version', async () => {
    const cellId = await seedTodayCell({ source: 'manual', status: 'Rescheduled' });
    const pipeline = await seedPostablePipeline();

    await dropper.updateStage(pipeline.id, 'posted', manager, pipeline.version, db);
    await settle();

    expect(await readCell(cellId)).toMatchObject({
      status: 'Rescheduled',
      source: 'manual',
      version: 1,
    });
    expect(broadcasts.filter((b) => b.event === 'content-calendar:updated')).toHaveLength(0);
  });

  test('ADR-013 case 2: the write bumps version, and audits as the System Actor', async () => {
    const cellId = await seedTodayCell();
    const pipeline = await seedPostablePipeline();

    await dropper.updateStage(pipeline.id, 'posted', manager, pipeline.version, db);
    await waitFor(async () => ((await readCell(cellId)).status === 'Posted' ? true : null));

    const cell = await readCell(cellId);
    expect(cell.version).toBe(2); // +1 — contrast Trigger 1, which must NOT bump
    expect(cell.updated_by).toBe(SYSTEM_ACTOR_UUID);

    // C-04: staff_id is never NULL; an automated write is changed_by_source 'system'.
    const audit = await db
      .selectFrom('audit_log')
      .select(['staff_id', 'changed_by_source', 'action'])
      .where('table_name', '=', 'content_calendar')
      .where('record_id', '=', cellId)
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({ staff_id: SYSTEM_ACTOR_UUID, changed_by_source: 'system', action: 'UPDATE' });
  });
});

describe('API-Contract §6 org broadcasts', () => {
  test('content-dropper:updated fires on a stage change with { clientId, period }', async () => {
    const pipeline = await seedPostablePipeline();

    await dropper.updateStage(pipeline.id, 'posted', manager, pipeline.version, db);
    await settle();

    expect(broadcasts.find((b) => b.event === 'content-dropper:updated')?.payload).toEqual({
      clientId: CLIENT_ID,
      period: PIPELINE_PERIOD,
    });
  });

  test('client:name_updated fires on a rename with { clientId, name }', async () => {
    await clients.rename(CLIENT_ID, 'Trigger2 Client Renamed', manager, db);

    expect(broadcasts.find((b) => b.event === 'client:name_updated')?.payload).toEqual({
      clientId: CLIENT_ID,
      name: 'Trigger2 Client Renamed',
    });

    await clients.rename(CLIENT_ID, 'Trigger2 Client', manager, db); // restore
  });
});
