import { randomUUID } from 'node:crypto';

import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { classifyDay, datesInPeriod } from '../../src/lib/period-days.js';
import { AttendanceService, type CurrentUser } from '../../src/services/AttendanceService.js';
import { currentIstDate, currentIstPeriod } from '../../src/services/BaseService.js';

import type { DB } from '@skaly/shared';

// Integration test: real local Postgres (docker), no mocks.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const svc = new AttendanceService();

// ── Fixtures ────────────────────────────────────────────────────────────────
const PERIOD_UNLOCKED = '2000-03';
const PERIOD_LOCKED = '2000-04';
const DOMAIN = '@attendance.itest';

// Persistent fixture staff. update() writes an append-only audit_log row that
// FKs staff — so these are UPSERTED and NEVER deleted (deleting them would hit
// audit_log_staff_id_fkey, and audit_log has no DELETE grant). Fixed ids keep
// re-runs idempotent.
const OWNER_ID = 'a0000000-0000-4000-8000-00000000a001';
const OTHER_ID = 'a0000000-0000-4000-8000-00000000a002';

const asOwnerTM: CurrentUser = { staffId: OWNER_ID, role: 'team_member' };
const asOtherTM: CurrentUser = { staffId: OTHER_ID, role: 'team_member' };
const asAdmin: CurrentUser = { staffId: OWNER_ID, role: 'admin' };

async function insertAttendance(
  staffId: string,
  period: string,
  date: string,
  version: number,
): Promise<string> {
  const row = await db
    .insertInto('attendance_logs')
    .values({ period, staff_id: staffId, date, day_type: 'working', present: false, version })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function cleanupAttendance() {
  await db
    .deleteFrom('attendance_logs')
    .where('period', 'in', [PERIOD_UNLOCKED, PERIOD_LOCKED])
    .execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: OWNER_ID, name: 'Att Owner', email: `owner-${OWNER_ID}${DOMAIN}`, role: 'team_member', active: true },
      { id: OTHER_ID, name: 'Att Other', email: `other-${OTHER_ID}${DOMAIN}`, role: 'team_member', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await db
    .insertInto('months')
    .values([
      { period: PERIOD_UNLOCKED, label: PERIOD_UNLOCKED, locked: false },
      { period: PERIOD_LOCKED, label: PERIOD_LOCKED, locked: true },
    ])
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();

  await cleanupAttendance();
});

afterAll(async () => {
  await cleanupAttendance();
  await db.destroy();
});

describe('update — ownership backstop (AUTH-MATRIX §7)', () => {
  test('team_member editing another staff member’s row → PERMISSION_DENIED (403)', async () => {
    const id = await insertAttendance(OWNER_ID, PERIOD_UNLOCKED, '2000-03-06', 1);
    await expect(
      svc.update(id, { present: true }, asOtherTM, 1, db),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
  });

  test('team_member editing their OWN row → succeeds and increments version', async () => {
    const id = await insertAttendance(OWNER_ID, PERIOD_UNLOCKED, '2000-03-07', 1);
    const updated = await svc.update(id, { present: true, work_log: 'shot the reel' }, asOwnerTM, 1, db);
    expect(updated.version).toBe(2);
    expect(updated.present).toBe(true);
    expect(updated.work_log).toBe('shot the reel');
  });
});

describe('update — optimistic lock', () => {
  test('mismatched version → STALE_DATA (409) with currentVersion', async () => {
    const id = await insertAttendance(OWNER_ID, PERIOD_UNLOCKED, '2000-03-08', 5);
    await expect(svc.update(id, { present: true }, asOwnerTM, 1, db)).rejects.toMatchObject({
      code: 'STALE_DATA',
      statusCode: 409,
      details: { currentVersion: 5 },
    });
  });
});

describe('update — validation + lock gate', () => {
  test('work_log longer than 2000 chars → VALIDATION_ERROR', async () => {
    const id = await insertAttendance(OWNER_ID, PERIOD_UNLOCKED, '2000-03-09', 1);
    await expect(
      svc.update(id, { work_log: 'x'.repeat(2001) }, asOwnerTM, 1, db),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  test('write on a locked period → PERIOD_LOCKED (423)', async () => {
    const id = await insertAttendance(OWNER_ID, PERIOD_LOCKED, '2000-04-05', 1);
    await expect(svc.update(id, { present: true }, asOwnerTM, 1, db)).rejects.toMatchObject({
      code: 'PERIOD_LOCKED',
      statusCode: 423,
    });
  });
});

describe('getGrid — editableStaffIds by role', () => {
  test('team_member sees the full grid but only their own id is editable', async () => {
    const grid = await svc.getGrid(PERIOD_UNLOCKED, asOwnerTM, db);
    expect(grid.editableStaffIds).toEqual([OWNER_ID]);
    // Both fixtures are active → both appear as columns.
    const ids = grid.staffList.map((s) => s.id);
    expect(ids).toContain(OWNER_ID);
    expect(ids).toContain(OTHER_ID);
  });

  test('admin can edit every column', async () => {
    const grid = await svc.getGrid(PERIOD_UNLOCKED, asAdmin, db);
    expect(grid.editableStaffIds).toEqual(grid.staffList.map((s) => s.id));
    expect(grid.editableStaffIds.length).toBe(grid.staffList.length);
  });

  test('freelancer never reaches getGrid → PERMISSION_DENIED', async () => {
    await expect(
      svc.getGrid(PERIOD_UNLOCKED, { staffId: OTHER_ID, role: 'freelancer' }, db),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('backfillCurrentPeriod — mid-month hire', () => {
  const period = currentIstPeriod();
  const today = currentIstDate();
  const HOLIDAY_MARKER = 'ATT-ITEST-HOLIDAY';
  let newStaffId: string;

  beforeAll(async () => {
    // Current IST month must exist (attendance_logs.period FKs months).
    await db
      .insertInto('months')
      .values({ period, label: period, locked: false })
      .onConflict((oc) => oc.column('period').doNothing())
      .execute();

    // A deterministic active holiday in the remaining window (first non-Sunday
    // date >= today), so the backfill produces at least one 'holiday' row.
    const inWindow = datesInPeriod(period).filter((d) => d >= today);
    const holidayDate = inWindow.find((d) => classifyDay(d, new Set()) === 'working');
    if (holidayDate) {
      await db
        .insertInto('holidays')
        .values({ period, date: holidayDate, name: HOLIDAY_MARKER, added_by: OWNER_ID })
        .onConflict((oc) => oc.columns(['period', 'date']).doNothing())
        .execute();
    }

    newStaffId = randomUUID();
    await db
      .insertInto('staff')
      .values({ id: newStaffId, name: 'New Hire', email: `hire-${newStaffId}${DOMAIN}`, role: 'team_member', active: true })
      .execute();
  });

  afterAll(async () => {
    await db.deleteFrom('attendance_logs').where('staff_id', '=', newStaffId).execute();
    await db.deleteFrom('staff').where('id', '=', newStaffId).execute();
    await db.deleteFrom('holidays').where('name', '=', HOLIDAY_MARKER).execute();
  });

  test('creates one row per date today→end-of-period (working + sunday + holiday), matching classifyDay', async () => {
    // Expected breakdown, computed from the SAME inputs the service uses.
    const activeHols = await db
      .selectFrom('holidays')
      .select(sql<string>`to_char(date, 'YYYY-MM-DD')`.as('d'))
      .where('period', '=', period)
      .where('active', '=', true)
      .where('removed_at', 'is', null)
      .execute();
    const holSet = new Set(activeHols.map((h) => h.d));
    const window = datesInPeriod(period).filter((d) => d >= today);
    const expectedByType = { working: 0, sunday: 0, holiday: 0 };
    for (const d of window) expectedByType[classifyDay(d, holSet)] += 1;

    const created = await db
      .transaction()
      .execute((trx) => svc.backfillCurrentPeriod(newStaffId, trx));
    expect(created).toBe(window.length);

    const rows = await db
      .selectFrom('attendance_logs')
      .select(['day_type', (eb) => eb.fn.countAll<string>().as('c')])
      .where('staff_id', '=', newStaffId)
      .where('period', '=', period)
      .groupBy('day_type')
      .execute();
    const actual = { working: 0, sunday: 0, holiday: 0 } as Record<string, number>;
    for (const r of rows) actual[r.day_type] = Number(r.c);

    expect(actual).toEqual(expectedByType);
    // The seeded window should contain at least one holiday row for the marker.
    expect(actual.holiday).toBeGreaterThanOrEqual(1);
  });

  test('re-running never duplicates (idempotent) → 0 new rows', async () => {
    const window = datesInPeriod(period).filter((d) => d >= today);
    const again = await db
      .transaction()
      .execute((trx) => svc.backfillCurrentPeriod(newStaffId, trx));
    expect(again).toBe(0);

    const total = await db
      .selectFrom('attendance_logs')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .where('staff_id', '=', newStaffId)
      .where('period', '=', period)
      .executeTakeFirstOrThrow();
    expect(Number(total.c)).toBe(window.length);
  });
});
