import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterEach, afterAll } from 'vitest';

import { classifyDay, datesInPeriod, isSunday } from '../../src/lib/period-days.js';
import { type CurrentUser } from '../../src/services/AttendanceService.js';
import { HolidayService } from '../../src/services/HolidayService.js';

import type { DB } from '@skaly/shared';

// Integration test: real local Postgres (docker), no socket server. getIo()
// throws when sockets aren't initialised, and the service swallows it — so the
// DB writes succeed and unit tests pass without a socket. STEP 8 proves receipt.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const svc = new HolidayService();

// ── Fixtures ────────────────────────────────────────────────────────────────
const PERIOD = '2000-05';
const PERIOD_LOCKED = '2000-06';
const DOMAIN = '@holiday.itest';

// Persistent fixture actor: create/remove write append-only audit_log rows that
// FK staff, so this is upserted and NEVER deleted (audit_log has no DELETE grant).
const ACTOR_ID = 'b0000000-0000-4000-8000-00000000b001';
const currentUser: CurrentUser = { staffId: ACTOR_ID, role: 'admin' };

// A working (non-Sunday) date and a Sunday date in each test period.
const workingDate = datesInPeriod(PERIOD).find((d) => classifyDay(d, new Set()) === 'working')!;
const sundayDate = datesInPeriod(PERIOD).find((d) => isSunday(d))!;
const workingDateLocked = datesInPeriod(PERIOD_LOCKED).find((d) => classifyDay(d, new Set()) === 'working')!;

async function insertAttendance(period: string, date: string, dayType: string): Promise<void> {
  await db
    .insertInto('attendance_logs')
    .values({ period, staff_id: ACTOR_ID, date, day_type: dayType, present: false, version: 1 })
    .onConflict((oc) => oc.columns(['period', 'staff_id', 'date']).doNothing())
    .execute();
}

async function insertHoliday(period: string, date: string, active: boolean): Promise<string> {
  const row = await db
    .insertInto('holidays')
    .values({
      period,
      date,
      name: 'ITEST-HOL',
      active,
      added_by: ACTOR_ID,
      removed_at: active ? null : sql`now()`,
      removed_by: active ? null : ACTOR_ID,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function dayTypeOf(period: string, date: string): Promise<string | undefined> {
  const r = await db
    .selectFrom('attendance_logs')
    .select('day_type')
    .where('staff_id', '=', ACTOR_ID)
    .where('period', '=', period)
    .where(sql<boolean>`to_char(date, 'YYYY-MM-DD') = ${date}`)
    .executeTakeFirst();
  return r?.day_type;
}

async function holidayRow(id: string) {
  return db
    .selectFrom('holidays')
    .select(['active', 'removed_by', 'removed_at'])
    .where('id', '=', id)
    .executeTakeFirst();
}

async function cleanupData() {
  await db
    .deleteFrom('attendance_logs')
    .where('period', 'in', [PERIOD, PERIOD_LOCKED])
    .execute();
  await db.deleteFrom('holidays').where('period', 'in', [PERIOD, PERIOD_LOCKED]).execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values({ id: ACTOR_ID, name: 'Holiday Actor', email: `actor-${ACTOR_ID}${DOMAIN}`, role: 'admin', active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await db
    .insertInto('months')
    .values([
      { period: PERIOD, label: PERIOD, locked: false },
      { period: PERIOD_LOCKED, label: PERIOD_LOCKED, locked: true },
    ])
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();

  await cleanupData();
});

afterEach(cleanupData);

afterAll(async () => {
  await cleanupData();
  await db.destroy();
});

describe('create', () => {
  test('inserts the holiday, flips working→holiday, leaves a sunday untouched', async () => {
    await insertAttendance(PERIOD, workingDate, 'working');
    await insertAttendance(PERIOD, sundayDate, 'sunday');

    const holiday = await db
      .transaction()
      .execute((trx) => svc.create({ period: PERIOD, date: workingDate, name: 'Diwali', currentUser, trx }));

    expect(holiday.active).toBe(true);
    expect(holiday.added_by).toBe(ACTOR_ID);
    expect(await dayTypeOf(PERIOD, workingDate)).toBe('holiday');
    expect(await dayTypeOf(PERIOD, sundayDate)).toBe('sunday'); // sundays never flipped
  });
});

describe('remove (audit H-01)', () => {
  test('happy path: soft-deactivates the holiday AND reverts holiday→working', async () => {
    const id = await insertHoliday(PERIOD, workingDate, true);
    await insertAttendance(PERIOD, workingDate, 'holiday');

    const res = await db.transaction().execute((trx) => svc.remove(id, currentUser, trx));
    expect(res).toEqual({ removed: true });

    const h = await holidayRow(id);
    expect(h?.active).toBe(false);
    expect(h?.removed_by).toBe(ACTOR_ID);
    expect(h?.removed_at).not.toBeNull();
    expect(await dayTypeOf(PERIOD, workingDate)).toBe('working'); // reverted
  });

  test('H-01: a failure BETWEEN the two updates rolls BOTH back (atomic)', async () => {
    const id = await insertHoliday(PERIOD, workingDate, true);
    await insertAttendance(PERIOD, workingDate, 'holiday');

    await expect(
      db.transaction().execute(async (trx) => {
        // Fault injection: let the holiday soft-update run, then blow up before
        // the attendance revert — exactly the H-01 half-applied scenario.
        const realUpdateTable = trx.updateTable.bind(trx) as (t: unknown) => unknown;
        (trx as unknown as { updateTable: (t: unknown) => unknown }).updateTable = (table: unknown) => {
          if (table === 'attendance_logs') throw new Error('boom between the two updates');
          return realUpdateTable(table);
        };
        await svc.remove(id, currentUser, trx);
      }),
    ).rejects.toThrow('boom between the two updates');

    // BOTH must be untouched: holiday still active, attendance still holiday.
    const h = await holidayRow(id);
    expect(h?.active).toBe(true);
    expect(h?.removed_at).toBeNull();
    expect(await dayTypeOf(PERIOD, workingDate)).toBe('holiday');
  });

  test('already-inactive holiday → RESOURCE_NOT_FOUND', async () => {
    const id = await insertHoliday(PERIOD, workingDate, false);
    await expect(
      db.transaction().execute((trx) => svc.remove(id, currentUser, trx)),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404 });
  });

  test('unknown holiday id → RESOURCE_NOT_FOUND', async () => {
    await expect(
      db.transaction().execute((trx) =>
        svc.remove('b0000000-0000-4000-8000-0000000000ff', currentUser, trx),
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404 });
  });
});

describe('locked period', () => {
  test('create on a locked period → PERIOD_LOCKED', async () => {
    await expect(
      db.transaction().execute((trx) =>
        svc.create({ period: PERIOD_LOCKED, date: workingDateLocked, name: 'Nope', currentUser, trx }),
      ),
    ).rejects.toMatchObject({ code: 'PERIOD_LOCKED', statusCode: 423 });
  });

  test('remove on a locked period → PERIOD_LOCKED', async () => {
    const id = await insertHoliday(PERIOD_LOCKED, workingDateLocked, true);
    await expect(
      db.transaction().execute((trx) => svc.remove(id, currentUser, trx)),
    ).rejects.toMatchObject({ code: 'PERIOD_LOCKED', statusCode: 423 });
  });
});
