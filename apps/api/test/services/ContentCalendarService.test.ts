import { CALENDAR_STATUSES, SYSTEM_ACTOR_UUID } from '@skaly/shared';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterEach, afterAll } from 'vitest';

import { ContentCalendarService } from '../../src/services/ContentCalendarService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type { DB } from '@skaly/shared';

// ContentCalendarService smoke (STEP 2): the grid read, the same-statement
// source auto-reset, and the canonical stale-version 409. Real local Postgres.
// STEP 6 rounds this out (status enum, note cap, locked period, roles).
// Own period namespace (1996-*) and id namespace (e5*) — no other suite touches
// them, so the suites stay parallel-safe against one shared database.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const svc = new ContentCalendarService();

const PERIOD = '1996-11';
const NEXT_PERIOD = '1996-12';
const LOCKED_PERIOD = '1996-10';
const DOMAIN = '@calendar.itest';
const DATE = '1996-11-07';
const NEXT_DATE = '1996-12-03';
const LOCKED_DATE = '1996-10-09';

const ADMIN_ID = 'e5000000-0000-4000-8000-00000000e501';
const CLIENT_ID = 'e5000000-0000-4000-8000-00000000e5c1';
const INTERNAL_ID = 'e5000000-0000-4000-8000-00000000e5c2';
const admin: CurrentUser = { staffId: ADMIN_ID, role: 'admin' };
const teamMember: CurrentUser = { staffId: ADMIN_ID, role: 'team_member' };
const freelancer: CurrentUser = { staffId: ADMIN_ID, role: 'freelancer' };

const ALL_PERIODS = [PERIOD, NEXT_PERIOD, LOCKED_PERIOD];

async function cleanupData() {
  await db.deleteFrom('content_calendar').where('period', 'in', ALL_PERIODS).execute();
}

/** One cell; `source` defaults to NULL exactly as generatePeriodRows leaves it. */
async function seedCell(
  over: Partial<{ period: string; client_id: string; date: string; status: string; source: string }> = {},
): Promise<string> {
  const row = await db
    .insertInto('content_calendar')
    .values({
      period: PERIOD,
      client_id: CLIENT_ID,
      date: DATE,
      status: 'No Activity',
      version: 1,
      ...over,
    } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Read a cell's mutable state straight from the DB (bypasses the service). */
async function readCell(id: string) {
  return db
    .selectFrom('content_calendar')
    .select(['status', 'source', 'version', 'updated_by'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN_ID, name: 'Calendar Admin', email: `admin-${ADMIN_ID}${DOMAIN}`, role: 'admin', active: true },
      // System Actor — FK target for Trigger 2's updated_by and its
      // changed_by_source='system' audit row (C-04). Seeded by the DB seed in
      // real envs, but CI runs migrations only.
      { id: SYSTEM_ACTOR_UUID, name: 'System', email: 'system@skaly.internal', role: 'admin', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await db
    .insertInto('months')
    .values([
      { period: PERIOD, label: PERIOD, locked: false },
      { period: NEXT_PERIOD, label: NEXT_PERIOD, locked: false },
      { period: LOCKED_PERIOD, label: LOCKED_PERIOD, locked: true },
    ])
    .onConflict((oc) => oc.column('period').doUpdateSet((eb) => ({ locked: eb.ref('excluded.locked') })))
    .execute();

  await db
    .insertInto('clients')
    .values([
      { id: CLIENT_ID, name: 'Calendar Client', shoot_slots_per_month: 4, pieces_per_visit: 3, active: true, is_internal: false },
      { id: INTERNAL_ID, name: 'Internal Co', shoot_slots_per_month: 4, pieces_per_visit: 3, active: true, is_internal: true },
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

describe('getGrid', () => {
  test('returns cells + client columns, excluding internal clients', async () => {
    await seedCell();
    await seedCell({ client_id: INTERNAL_ID });

    const grid = await svc.getGrid(PERIOD, admin, db);

    // Columns are every active non-internal client (not period-scoped — a client
    // created after the period was generated still gets an empty column; STEP 4's
    // backfill is what fills it). Other suites share this DB, so assert
    // membership, not the whole list.
    const columnIds = grid.clients.map((c) => c.id);
    expect(columnIds).toContain(CLIENT_ID);
    expect(columnIds).not.toContain(INTERNAL_ID);
    // Cells ARE period-scoped, and the internal client's cell is excluded —
    // membership is decided once, so a cell can never outlive its column.
    expect(grid.cells).toHaveLength(1);
    expect(grid.cells[0]).toMatchObject({
      clientId: CLIENT_ID,
      date: DATE,
      status: 'No Activity',
      source: null,
      version: 1,
      updatedBy: null,
    });
  });

  test('team_member may read; freelancer is denied at the service layer', async () => {
    await seedCell();
    await expect(svc.getGrid(PERIOD, teamMember, db)).resolves.toMatchObject({ cells: [expect.anything()] });
    await expect(svc.getGrid(PERIOD, freelancer, db)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('updateCell — the auto-reset and the optimistic lock', () => {
  test("a user PATCH flips source to 'manual' in the SAME update, bumping version exactly once", async () => {
    const id = await seedCell({ source: 'pipeline_trigger', status: 'Posted' });

    const cell = await svc.updateCell(id, { status: 'Ready' }, admin, 1, db);

    expect(cell.status).toBe('Ready');
    expect(cell.source).toBe('manual');
    // Exactly +1 proves one statement did both — a second UPDATE would make it 3.
    expect(cell.version).toBe(2);
    expect(cell.updatedBy).toEqual({ staffId: ADMIN_ID, name: 'Calendar Admin' });
    expect(cell.updatedAt).not.toBeNull();
  });

  test('the returned cell keeps its OWN date — no timezone shift (regression)', async () => {
    const id = await seedCell();

    const cell = await svc.updateCell(id, { status: 'Ready' }, admin, 1, db);

    // node-postgres parses DATE as a JS Date at LOCAL midnight, so formatting the
    // RETURNING row with toISOString() shifted this back a day under IST — the
    // 7th came back as the 6th and the grid, which keys cells by
    // `clientId:date`, filed the edit on the wrong day. Both endpoints must
    // agree, so assert getGrid's date too.
    expect(cell.date).toBe(DATE);
    const grid = await svc.getGrid(PERIOD, admin, db);
    expect(grid.cells.find((c) => c.id === id)?.date).toBe(DATE);
  });

  test('a stale version raises 409 STALE_DATA carrying currentVersion + updatedBy', async () => {
    const id = await seedCell();
    await svc.updateCell(id, { status: 'Ready' }, admin, 1, db); // → version 2

    await expect(svc.updateCell(id, { status: 'Pending' }, admin, 1, db)).rejects.toMatchObject({
      code: 'STALE_DATA',
      details: { currentVersion: 2, updatedBy: { staffId: ADMIN_ID, name: 'Calendar Admin' } },
    });
  });

  test('a source field in the patch is rejected — provenance is server-owned', async () => {
    const id = await seedCell();
    await expect(
      svc.updateCell(id, { status: 'Ready', source: 'pipeline_trigger' } as never, admin, 1, db),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  // The route's Zod schema rejects these first, so without a direct test the
  // service's own guards could rot unnoticed — and the service is the layer the
  // bot (Sprint 8) and any future caller will reach past the HTTP boundary.
  test('layer-3 validation: off-enum status, over-long note, and neither-field all 400', async () => {
    const id = await seedCell();
    await expect(svc.updateCell(id, { status: 'Done' } as never, admin, 1, db)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      svc.updateCell(id, { note: 'x'.repeat(1001) }, admin, 1, db),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(svc.updateCell(id, {}, admin, 1, db)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  test('all six statuses are accepted, and the version chain is unbroken', async () => {
    const id = await seedCell();
    let version = 1;
    for (const status of CALENDAR_STATUSES) {
      const cell = await svc.updateCell(id, { status }, admin, version, db);
      expect(cell.status).toBe(status);
      version = cell.version;
    }
    expect(version).toBe(1 + CALENDAR_STATUSES.length);
  });

  test('a locked period → 423 PERIOD_LOCKED', async () => {
    const id = await seedCell({ period: LOCKED_PERIOD, date: LOCKED_DATE });
    await expect(svc.updateCell(id, { status: 'Ready' }, admin, 1, db)).rejects.toMatchObject({
      code: 'PERIOD_LOCKED',
    });
  });

  test('an unknown cell → 404', async () => {
    await expect(
      svc.updateCell('e5000000-0000-4000-8000-0000000000ff', { status: 'Ready' }, admin, 1, db),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  test('team_member cannot write', async () => {
    const id = await seedCell();
    await expect(svc.updateCell(id, { status: 'Ready' }, teamMember, 1, db)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });
});

// Trigger 2 at the service layer. STEP 6 adds the real-EventBus + broadcast
// suite; these cover the three corrections, each of which would silently kill
// the trigger. Every one of them fails if its correction is reverted.
describe('applyPostedTrigger — the three corrections', () => {
  test('CORRECTION 1 (null-safety): a NULL-source cell IS written', async () => {
    const id = await seedCell(); // source NULL, exactly as generatePeriodRows leaves it
    const before = await readCell(id);

    const result = await svc.applyPostedTrigger(CLIENT_ID, DATE, db);

    expect(result).toEqual({ clientId: CLIENT_ID, period: PERIOD, date: DATE });
    const after = await readCell(id);
    expect(after.status).toBe('Posted');
    expect(after.source).toBe('pipeline_trigger');
    expect(after.updated_by).toBe(SYSTEM_ACTOR_UUID);
    // ADR-013 case 2 — same-column system write bumps version (Trigger 1 must not).
    expect(after.version).toBe(before.version + 1);
  });

  test('CORRECTION 2 (period derivation): the cell for postedAt’s month is hit, not another period’s', async () => {
    // Same client, same day-of-month absent: two cells in two different periods.
    const novemberId = await seedCell();
    const decemberId = await seedCell({ period: NEXT_PERIOD, date: NEXT_DATE });

    // A pipeline belonging to PERIOD, but posted on a December date.
    const result = await svc.applyPostedTrigger(CLIENT_ID, NEXT_DATE, db);

    expect(result?.period).toBe(NEXT_PERIOD);
    expect((await readCell(decemberId)).status).toBe('Posted');
    // The pipeline's own period is untouched — this is what fails if the
    // listener passes the event's `period` instead of deriving from postedAt.
    expect((await readCell(novemberId)).status).toBe('No Activity');
  });

  test('CORRECTION 3 (missing cell): no-op, no throw, and no row created', async () => {
    const result = await svc.applyPostedTrigger(CLIENT_ID, DATE, db); // nothing seeded

    expect(result).toBeNull();
    const count = await db
      .selectFrom('content_calendar')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('period', '=', PERIOD)
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(0);
  });

  test("the manual guard: a 'manual' cell is left completely untouched", async () => {
    const id = await seedCell({ source: 'manual', status: 'Rescheduled' });

    const result = await svc.applyPostedTrigger(CLIENT_ID, DATE, db);

    expect(result).toBeNull();
    expect(await readCell(id)).toMatchObject({
      status: 'Rescheduled',
      source: 'manual',
      version: 1, // not even a version bump
    });
  });

  test('a locked period is skipped — a system trigger never writes through a lock', async () => {
    const id = await seedCell({ period: LOCKED_PERIOD, date: LOCKED_DATE });

    const result = await svc.applyPostedTrigger(CLIENT_ID, LOCKED_DATE, db);

    expect(result).toBeNull();
    expect(await readCell(id)).toMatchObject({ status: 'No Activity', version: 1 });
  });

  test('replaying the same event is idempotent — no second version bump, no re-broadcast', async () => {
    const id = await seedCell();
    await svc.applyPostedTrigger(CLIENT_ID, DATE, db);

    const second = await svc.applyPostedTrigger(CLIENT_ID, DATE, db);

    expect(second).toBeNull(); // null ⇒ the listener does not broadcast again
    expect((await readCell(id)).version).toBe(2);
  });
});
