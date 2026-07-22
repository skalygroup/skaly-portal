import { SYSTEM_ACTOR_UUID } from '@skaly/shared';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterEach, afterAll } from 'vitest';

import { ContentCalendarService } from '../../src/services/ContentCalendarService.js';
import {
  backfillClientPeriodRows,
  generateCalendarCellsForClient,
  generatePeriodRows,
  generatePipelineRowForClient,
  generateShootSlotsForClient,
} from '../../src/services/period-generation.js';
import { ShootPlannerService } from '../../src/services/ShootPlannerService.js';

import type { DB } from '@skaly/shared';

// The shared slot generator + the mid-month backfill (Sprint 5 STEP 3/5).
// Real local Postgres. Own period 1999-09 — no other suite touches it.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const svc = new ShootPlannerService();

const PERIOD = '1999-09'; // 30 days
const MONTH_31 = '1999-08'; // 31 days — the extraction/full-run period
const FEB = '1999-02'; // 28 days
const LEAP_FEB = '2000-02'; // 29 days
const ALL_PERIODS = [PERIOD, MONTH_31, FEB, LEAP_FEB];
/** Real day counts — the generator must derive these, never hardcode 30/31. */
const DAYS_IN: Record<string, number> = { [PERIOD]: 30, [MONTH_31]: 31, [FEB]: 28, [LEAP_FEB]: 29 };

const CLIENT_ID = 'e0000000-0000-4000-8000-00000000e0c1';
const INTERNAL_CLIENT_ID = 'e0000000-0000-4000-8000-00000000e0c2';
const CLIENT = { id: CLIENT_ID, shoot_slots_per_month: 3, pieces_per_visit: 2 };

async function cleanupData() {
  await db.deleteFrom('shoot_schedules').where('period', 'in', ALL_PERIODS).execute();
  await db.deleteFrom('content_calendar').where('period', 'in', ALL_PERIODS).execute();
  await db.deleteFrom('content_pipelines').where('period', 'in', ALL_PERIODS).execute();
  await db.deleteFrom('attendance_logs').where('period', 'in', ALL_PERIODS).execute();
}

/** Row counts for one client in one period — the "what a client's rows are" shape. */
async function countsFor(clientId: string, period: string) {
  const one = async (table: 'shoot_schedules' | 'content_pipelines' | 'content_calendar') => {
    const r = await db
      .selectFrom(table)
      .select((eb) => eb.fn.countAll().as('n'))
      .where('period', '=', period)
      .where('client_id', '=', clientId)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  };
  return {
    slots: await one('shoot_schedules'),
    pipelines: await one('content_pipelines'),
    cells: await one('content_calendar'),
  };
}

beforeAll(async () => {
  await db
    .insertInto('months')
    .values(ALL_PERIODS.map((period) => ({ period, label: period, locked: false })))
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();
  // System Actor — Trigger 2's updated_by FK + its 'system' audit row (C-04).
  await db
    .insertInto('staff')
    .values({ id: SYSTEM_ACTOR_UUID, name: 'System', email: 'system@skaly.internal', role: 'admin', active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('clients')
    .values([
      { id: CLIENT_ID, name: 'Gen Test Client', shoot_slots_per_month: 3, pieces_per_visit: 2, active: true },
      { id: INTERNAL_CLIENT_ID, name: 'Gen Internal Client', shoot_slots_per_month: 4, pieces_per_visit: 1, active: true, is_internal: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await cleanupData();
});

afterEach(cleanupData);

afterAll(async () => {
  await cleanupData();
  await db.destroy();
});

describe('generateShootSlotsForClient', () => {
  test('produces exactly shoot_slots_per_month Unset rows with pieces_expected = pieces_per_visit', async () => {
    const created = await db.transaction().execute((trx) => generateShootSlotsForClient(CLIENT, PERIOD, trx));
    expect(created).toBe(3);

    const rows = await db
      .selectFrom('shoot_schedules')
      .selectAll()
      .where('period', '=', PERIOD)
      .where('client_id', '=', CLIENT_ID)
      .orderBy('slot_index')
      .execute();
    expect(rows.map((r) => r.slot_index)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.slot_status === 'Unset' && r.pieces_expected === 2)).toBe(true);
  });

  test('idempotent: a re-run adds nothing; a partial set is only gap-filled', async () => {
    await db.transaction().execute((trx) => generateShootSlotsForClient(CLIENT, PERIOD, trx));
    const rerun = await db.transaction().execute((trx) => generateShootSlotsForClient(CLIENT, PERIOD, trx));
    expect(rerun).toBe(0);

    // Drop slot 2 → the generator restores exactly it.
    await db
      .deleteFrom('shoot_schedules')
      .where('period', '=', PERIOD)
      .where('client_id', '=', CLIENT_ID)
      .where('slot_index', '=', 2)
      .execute();
    const gapFill = await db.transaction().execute((trx) => generateShootSlotsForClient(CLIENT, PERIOD, trx));
    expect(gapFill).toBe(1);
  });

  test('no week_number: generated rows carry no week_number key (weeks are computed at render)', async () => {
    await db.transaction().execute((trx) => generateShootSlotsForClient(CLIENT, PERIOD, trx));
    const row = await db
      .selectFrom('shoot_schedules')
      .selectAll()
      .where('period', '=', PERIOD)
      .where('client_id', '=', CLIENT_ID)
      .executeTakeFirstOrThrow();
    expect(row).not.toHaveProperty('week_number');
    expect(row).not.toHaveProperty('version'); // and never versioned
  });
});

describe('backfillClientSlots (mid-month client)', () => {
  test('generates the full current-count slot set for one client', async () => {
    const created = await db.transaction().execute((trx) => svc.backfillClientSlots(CLIENT_ID, PERIOD, trx));
    expect(created).toBe(3);
  });

  test('internal clients get no slots; missing client → 404', async () => {
    const internal = await db
      .transaction()
      .execute((trx) => svc.backfillClientSlots(INTERNAL_CLIENT_ID, PERIOD, trx));
    expect(internal).toBe(0);

    await expect(
      db.transaction().execute((trx) => svc.backfillClientSlots('e0000000-0000-4000-8000-0000000000ff', PERIOD, trx)),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});

describe('generateCalendarCellsForClient — real day counts, never hardcoded', () => {
  test.each([
    [PERIOD, 30],
    [MONTH_31, 31],
    [FEB, 28],
    [LEAP_FEB, 29], // the leap year — a hardcoded 28 fails here
  ])('%s produces %i cells', async (period, days) => {
    const created = await db
      .transaction()
      .execute((trx) => generateCalendarCellsForClient(CLIENT_ID, period, trx));
    expect(created).toBe(days);

    const rows = await db
      .selectFrom('content_calendar')
      .select(['status', 'source', 'version'])
      .where('period', '=', period)
      .where('client_id', '=', CLIENT_ID)
      .execute();
    expect(rows).toHaveLength(days);
    // source NULL is the state the Trigger 2 null-safety guard depends on.
    expect(rows.every((r) => r.status === 'No Activity' && r.source === null && r.version === 1)).toBe(true);
  });

  test('idempotent: a re-run adds nothing, a gap is filled', async () => {
    await db.transaction().execute((trx) => generateCalendarCellsForClient(CLIENT_ID, PERIOD, trx));
    const rerun = await db
      .transaction()
      .execute((trx) => generateCalendarCellsForClient(CLIENT_ID, PERIOD, trx));
    expect(rerun).toBe(0);

    await db
      .deleteFrom('content_calendar')
      .where('period', '=', PERIOD)
      .where('client_id', '=', CLIENT_ID)
      .where('date', '=', '1999-09-15' as never)
      .execute();
    const gapFill = await db
      .transaction()
      .execute((trx) => generateCalendarCellsForClient(CLIENT_ID, PERIOD, trx));
    expect(gapFill).toBe(1);
  });
});

describe('generatePipelineRowForClient', () => {
  test('one row, version 1, stage timestamps and coming_shoot_source all NULL; idempotent', async () => {
    const created = await db
      .transaction()
      .execute((trx) => generatePipelineRowForClient(CLIENT_ID, PERIOD, trx));
    expect(created).toBe(1);

    const row = await db
      .selectFrom('content_pipelines')
      .selectAll()
      .where('period', '=', PERIOD)
      .where('client_id', '=', CLIENT_ID)
      .executeTakeFirstOrThrow();
    expect(row.version).toBe(1);
    expect(row.raw_received_at).toBeNull();
    expect(row.finals_ready_at).toBeNull();
    expect(row.posted_at).toBeNull();
    expect(row.coming_shoot_source).toBeNull();

    const rerun = await db
      .transaction()
      .execute((trx) => generatePipelineRowForClient(CLIENT_ID, PERIOD, trx));
    expect(rerun).toBe(0);
  });
});

describe('backfillClientPeriodRows — the carried Sprint 5/6 debt', () => {
  test('one call generates slots AND a pipeline row AND a full month of cells', async () => {
    const created = await db
      .transaction()
      .execute((trx) => backfillClientPeriodRows(CLIENT_ID, PERIOD, trx));

    expect(created).toEqual({ slots: 3, pipelines: 1, cells: DAYS_IN[PERIOD] });
    expect(await countsFor(CLIENT_ID, PERIOD)).toEqual({ slots: 3, pipelines: 1, cells: 30 });
  });

  test('idempotent: re-running all three adds nothing', async () => {
    await db.transaction().execute((trx) => backfillClientPeriodRows(CLIENT_ID, PERIOD, trx));
    const rerun = await db
      .transaction()
      .execute((trx) => backfillClientPeriodRows(CLIENT_ID, PERIOD, trx));

    expect(rerun).toEqual({ slots: 0, pipelines: 0, cells: 0 });
    expect(await countsFor(CLIENT_ID, PERIOD)).toEqual({ slots: 3, pipelines: 1, cells: 30 });
  });

  test('an internal client gets none of the three', async () => {
    const created = await db
      .transaction()
      .execute((trx) => backfillClientPeriodRows(INTERNAL_CLIENT_ID, PERIOD, trx));

    expect(created).toEqual({ slots: 0, pipelines: 0, cells: 0 });
    expect(await countsFor(INTERNAL_CLIENT_ID, PERIOD)).toEqual({ slots: 0, pipelines: 0, cells: 0 });
  });

  test('THE LOOP CLOSER: without the backfill Trigger 2 no-ops; with it, the cell is written', async () => {
    const calendar = new ContentCalendarService();
    const POSTED_ON = '1999-09-15';

    // Before the backfill — this is exactly the missing-cell path, and it is why
    // the debt mattered: the post would be silently absent from the calendar.
    expect(await calendar.applyPostedTrigger(CLIENT_ID, POSTED_ON, db)).toBeNull();

    await db.transaction().execute((trx) => backfillClientPeriodRows(CLIENT_ID, PERIOD, trx));

    const written = await calendar.applyPostedTrigger(CLIENT_ID, POSTED_ON, db);
    expect(written).toEqual({ clientId: CLIENT_ID, period: PERIOD, date: POSTED_ON });

    const cell = await db
      .selectFrom('content_calendar')
      .select(['status', 'source'])
      .where('period', '=', PERIOD)
      .where('client_id', '=', CLIENT_ID)
      .where('date', '=', POSTED_ON as never)
      .executeTakeFirstOrThrow();
    expect(cell).toEqual({ status: 'Posted', source: 'pipeline_trigger' });
  });
});

describe('generatePeriodRows — unchanged by the extraction', () => {
  test('every active non-internal client gets its slots, pipeline row and full month of cells; re-run is a no-op', async () => {
    await db.transaction().execute((trx) => generatePeriodRows(MONTH_31, trx));

    const clients = await db
      .selectFrom('clients')
      .select(['id', 'shoot_slots_per_month'])
      .where('active', '=', true)
      .where('deleted_at', 'is', null)
      .where('is_internal', '=', false)
      .execute();

    // Per-client invariants — the contract generatePeriodRows had before the
    // extraction, asserted against the live client set rather than a fixed number.
    for (const c of clients) {
      expect(await countsFor(c.id, MONTH_31)).toEqual({
        slots: c.shoot_slots_per_month,
        pipelines: 1,
        cells: DAYS_IN[MONTH_31],
      });
    }
    expect(await countsFor(INTERNAL_CLIENT_ID, MONTH_31)).toEqual({ slots: 0, pipelines: 0, cells: 0 });

    // Idempotent: a second full run changes no count.
    const snapshot = await Promise.all(clients.map((c) => countsFor(c.id, MONTH_31)));
    await db.transaction().execute((trx) => generatePeriodRows(MONTH_31, trx));
    expect(await Promise.all(clients.map((c) => countsFor(c.id, MONTH_31)))).toEqual(snapshot);
  });
});
