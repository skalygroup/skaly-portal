import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterEach, afterAll } from 'vitest';

import { generateShootSlotsForClient } from '../../src/services/period-generation.js';
import { ShootPlannerService } from '../../src/services/ShootPlannerService.js';

import type { DB } from '@skaly/shared';

// The shared slot generator + the mid-month backfill (Sprint 5 STEP 3/5).
// Real local Postgres. Own period 1999-09 — no other suite touches it.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const svc = new ShootPlannerService();

const PERIOD = '1999-09';
const CLIENT_ID = 'e0000000-0000-4000-8000-00000000e0c1';
const INTERNAL_CLIENT_ID = 'e0000000-0000-4000-8000-00000000e0c2';
const CLIENT = { id: CLIENT_ID, shoot_slots_per_month: 3, pieces_per_visit: 2 };

async function cleanupData() {
  await db.deleteFrom('shoot_schedules').where('period', '=', PERIOD).execute();
}

beforeAll(async () => {
  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doNothing())
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
