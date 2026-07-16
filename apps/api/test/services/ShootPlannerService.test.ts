import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';

import { eventBus } from '../../src/lib/EventBus.js';
import { ShootPlannerService } from '../../src/services/ShootPlannerService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type { DB } from '@skaly/shared';

// The ShootPlannerService suite: freelancer isolation (M-07 / ADR-011), the
// Trigger-1 emit (spy — the coming_shoot_date assertion is Sprint 6's), the
// shoot_confirmed notification, transitions, last-write-wins (no version),
// reset, and the period lock. Real local Postgres; no socket server (the
// notify emit failure is swallowed by NotificationService).
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const svc = new ShootPlannerService();

// ── Fixtures ────────────────────────────────────────────────────────────────
// Own periods — no other suite touches 1999-*.
const PERIOD = '1999-11';
const LOCKED_PERIOD = '1999-10';
const DOMAIN = '@shoot.itest';

const ADMIN_ID = 'd0000000-0000-4000-8000-00000000d001';
const FREELANCER_ID = 'd0000000-0000-4000-8000-00000000d002';
const FREELANCER2_ID = 'd0000000-0000-4000-8000-00000000d003';
const CLIENT_ID = 'd0000000-0000-4000-8000-00000000d0c1';
const admin: CurrentUser = { staffId: ADMIN_ID, role: 'admin' };
const freelancer1: CurrentUser = { staffId: FREELANCER_ID, role: 'freelancer' };

async function cleanupData() {
  await db.deleteFrom('shoot_schedules').where('period', 'in', [PERIOD, LOCKED_PERIOD]).execute();
  await db
    .deleteFrom('notifications')
    .where('staff_id', 'in', [FREELANCER_ID, FREELANCER2_ID])
    .where('type', '=', 'shoot_confirmed')
    .execute();
}

/** Insert one slot and return its id. */
async function seedSlot(
  slotIndex = 1,
  over: { slot_status?: string; slot_date?: string; freelancer_id?: string; period?: string } = {},
): Promise<string> {
  const row = await db
    .insertInto('shoot_schedules')
    .values({
      period: PERIOD,
      client_id: CLIENT_ID,
      slot_index: slotIndex,
      slot_status: 'Unset',
      pieces_expected: 3,
      ...over,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN_ID, name: 'Shoot Admin', email: `admin-${ADMIN_ID}${DOMAIN}`, role: 'admin', active: true },
      { id: FREELANCER_ID, name: 'Shoot Freelancer', email: `fl-${FREELANCER_ID}${DOMAIN}`, role: 'freelancer', active: true },
      { id: FREELANCER2_ID, name: 'Other Freelancer', email: `fl2-${FREELANCER2_ID}${DOMAIN}`, role: 'freelancer', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await db
    .insertInto('months')
    .values([
      { period: PERIOD, label: PERIOD, locked: false },
      { period: LOCKED_PERIOD, label: LOCKED_PERIOD, locked: true },
    ])
    .onConflict((oc) => oc.column('period').doUpdateSet((eb) => ({ locked: eb.ref('excluded.locked') })))
    .execute();

  await db
    .insertInto('clients')
    .values({ id: CLIENT_ID, name: 'Shoot Test Client', shoot_slots_per_month: 4, pieces_per_visit: 3, active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await cleanupData();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupData();
});

afterAll(async () => {
  await cleanupData();
  await db.destroy();
});

describe('freelancer isolation (M-07 / ADR-011)', () => {
  test('getGrid: own slot visible; other freelancers’ and unassigned slots invisible', async () => {
    const slot1 = await seedSlot(1, { freelancer_id: FREELANCER_ID, slot_status: 'Scheduled', slot_date: '1999-11-10' });
    const slot2 = await seedSlot(2, { freelancer_id: FREELANCER2_ID, slot_status: 'Scheduled', slot_date: '1999-11-11' });
    const slot3 = await seedSlot(3); // unassigned

    const grid = await svc.getGrid(PERIOD, freelancer1, db);
    const ids = grid.slots.map((s) => s.id);
    expect(ids).toContain(slot1);
    expect(ids).not.toContain(slot2);
    expect(ids).not.toContain(slot3);

    // Admin sees all three (control).
    const adminGrid = await svc.getGrid(PERIOD, admin, db);
    const adminIds = adminGrid.slots.map((s) => s.id);
    expect(adminIds).toEqual(expect.arrayContaining([slot1, slot2, slot3]));
  });

  test('getSlot: a freelancer fetching a non-owned slot gets 404, not 403', async () => {
    const otherSlot = await seedSlot(1, { freelancer_id: FREELANCER2_ID });
    await expect(svc.getSlot(otherSlot, freelancer1, db)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    // Own slot resolves fine.
    const ownSlot = await seedSlot(2, { freelancer_id: FREELANCER_ID });
    await expect(svc.getSlot(ownSlot, freelancer1, db)).resolves.toMatchObject({ id: ownSlot });
  });

  test('service layer-3 backstop: freelancer update/reset → PERMISSION_DENIED', async () => {
    const slotId = await seedSlot(1, { freelancer_id: FREELANCER_ID });
    await expect(svc.update(slotId, { slotStatus: 'Scheduled', slotDate: '1999-11-12' }, freelancer1, db))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(svc.reset(slotId, freelancer1, true, db)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });
});

describe('update → Confirmed (Trigger 1 producer, smoke)', () => {
  test('confirming a slot emits shoot:confirmed after commit and notifies the assigned freelancer', async () => {
    const slotId = await seedSlot();
    await svc.update(slotId, { slotStatus: 'Scheduled', slotDate: '1999-11-15', freelancerId: FREELANCER_ID }, admin, db);

    const emitSpy = vi.spyOn(eventBus, 'emit');
    const updated = await svc.update(slotId, { slotStatus: 'Confirmed' }, admin, db);

    expect(updated.slotStatus).toBe('Confirmed');
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('shoot:confirmed', {
      clientId: CLIENT_ID,
      period: PERIOD,
      slotDate: '1999-11-15',
    });

    const notif = await db
      .selectFrom('notifications')
      .select(['staff_id', 'type', 'title'])
      .where('staff_id', '=', FREELANCER_ID)
      .where('type', '=', 'shoot_confirmed')
      .execute();
    expect(notif).toHaveLength(1);
    expect(notif[0]!.title).toBe('Shoot Test Client shoot confirmed');
  });

  test('rescheduling an already-Confirmed slot re-emits shoot:confirmed with the new date', async () => {
    const slotId = await seedSlot(1, { slot_status: 'Confirmed', slot_date: '1999-11-10' });

    const emitSpy = vi.spyOn(eventBus, 'emit');
    await svc.update(slotId, { slotDate: '1999-11-25' }, admin, db);

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('shoot:confirmed', {
      clientId: CLIENT_ID,
      period: PERIOD,
      slotDate: '1999-11-25',
    });
  });

  test('confirming a slot with no freelancer assigned writes no notification', async () => {
    const slotId = await seedSlot(1, { slot_status: 'Scheduled', slot_date: '1999-11-10' });
    await svc.update(slotId, { slotStatus: 'Confirmed' }, admin, db);

    const notifs = await db
      .selectFrom('notifications')
      .select('id')
      .where('type', '=', 'shoot_confirmed')
      .where('staff_id', 'in', [FREELANCER_ID, FREELANCER2_ID])
      .execute();
    expect(notifs).toHaveLength(0);
  });
});

describe('transition validation + last-write-wins', () => {
  test('illegal jump Unset→Confirmed → 400; Scheduled without a date → 400', async () => {
    const slotId = await seedSlot(1);
    await expect(svc.update(slotId, { slotStatus: 'Confirmed', slotDate: '1999-11-10' }, admin, db))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid slot transition: Unset → Confirmed.' });
    await expect(svc.update(slotId, { slotStatus: 'Scheduled' }, admin, db)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'A shoot date is required to schedule or confirm a slot.',
    });
  });

  test('no version: two sequential updates both succeed, second wins (never STALE_DATA)', async () => {
    const slotId = await seedSlot(1, { slot_status: 'Scheduled', slot_date: '1999-11-10' });
    await svc.update(slotId, { piecesExpected: 7 }, admin, db);
    const second = await svc.update(slotId, { piecesExpected: 9 }, admin, db);
    expect(second.piecesExpected).toBe(9); // last write wins, no conflict error
  });

  test('period lock: update and reset on a locked period → PERIOD_LOCKED', async () => {
    const slotId = await seedSlot(1, { period: LOCKED_PERIOD, slot_status: 'Scheduled', slot_date: '1999-10-10' });
    await expect(svc.update(slotId, { piecesExpected: 5 }, admin, db)).rejects.toMatchObject({
      code: 'PERIOD_LOCKED',
    });
    await expect(svc.reset(slotId, admin, true, db)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
  });
});

describe('backfill + adjustSlotCount (smoke)', () => {
  test('backfillClientSlots generates shoot_slots_per_month Unset rows, idempotently', async () => {
    const created = await db.transaction().execute((trx) => svc.backfillClientSlots(CLIENT_ID, PERIOD, trx));
    expect(created).toBe(4); // clients.shoot_slots_per_month

    const rerun = await db.transaction().execute((trx) => svc.backfillClientSlots(CLIENT_ID, PERIOD, trx));
    expect(rerun).toBe(0); // idempotent

    const rows = await db
      .selectFrom('shoot_schedules')
      .select(['slot_index', 'slot_status', 'pieces_expected'])
      .where('period', '=', PERIOD)
      .where('client_id', '=', CLIENT_ID)
      .orderBy('slot_index')
      .execute();
    expect(rows.map((r) => r.slot_index)).toEqual([1, 2, 3, 4]);
    expect(rows.every((r) => r.slot_status === 'Unset' && r.pieces_expected === 3)).toBe(true);
  });

  test('adjustSlotCount increase adds Unset slots; decrease past a Scheduled slot is blocked', async () => {
    // adjustSlotCount reconciles the CURRENT period — seed months + slots for it.
    const currentPeriod = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit',
    }).format(new Date());
    await db
      .insertInto('months')
      .values({ period: currentPeriod, label: currentPeriod, locked: false })
      .onConflict((oc) => oc.column('period').doNothing())
      .execute();
    await db.transaction().execute((trx) => svc.backfillClientSlots(CLIENT_ID, currentPeriod, trx));

    try {
      // Increase 4 → 6: two new trailing Unset slots.
      const inc = await svc.adjustSlotCount(CLIENT_ID, 6, admin, db);
      expect(inc).toMatchObject({ shootSlotsPerMonth: 6, slotsAdded: 2, slotsRemoved: 0 });

      // Schedule slot 6, then try to shrink below it → blocked, nothing changed.
      const slot6 = await db
        .selectFrom('shoot_schedules')
        .select('id')
        .where('period', '=', currentPeriod)
        .where('client_id', '=', CLIENT_ID)
        .where('slot_index', '=', 6)
        .executeTakeFirstOrThrow();
      await svc.update(slot6.id, { slotStatus: 'Scheduled', slotDate: `${currentPeriod}-15` }, admin, db);

      await expect(svc.adjustSlotCount(CLIENT_ID, 4, admin, db)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Reset or complete slot 6 before reducing the count.',
      });
      const stillThere = await db
        .selectFrom('shoot_schedules')
        .select('slot_index')
        .where('period', '=', currentPeriod)
        .where('client_id', '=', CLIENT_ID)
        .execute();
      expect(stillThere).toHaveLength(6); // blocked decrease is all-or-nothing

      // Reset slot 6, decrease 6 → 4 now removes only the trailing Unset pair.
      await svc.reset(slot6.id, admin, true, db);
      const dec = await svc.adjustSlotCount(CLIENT_ID, 4, admin, db);
      expect(dec).toMatchObject({ shootSlotsPerMonth: 4, slotsAdded: 0, slotsRemoved: 2 });
    } finally {
      // Restore the fixture count and clear current-period rows for re-runs.
      await db.updateTable('clients').set({ shoot_slots_per_month: 4 }).where('id', '=', CLIENT_ID).execute();
      await db
        .deleteFrom('shoot_schedules')
        .where('period', '=', currentPeriod)
        .where('client_id', '=', CLIENT_ID)
        .execute();
    }
  });
});

describe('reset (confirm gate, smoke)', () => {
  test('reset without confirm:true → SHOOT_RESET_CONFIRMATION_REQUIRED; with it → Unset + shoot:reset', async () => {
    const slotId = await seedSlot();
    await svc.update(slotId, { slotStatus: 'Scheduled', slotDate: '1999-11-20', piecesExpected: 5 }, admin, db);

    await expect(svc.reset(slotId, admin, undefined, db)).rejects.toMatchObject({
      code: 'SHOOT_RESET_CONFIRMATION_REQUIRED',
    });

    const emitSpy = vi.spyOn(eventBus, 'emit');
    await expect(svc.reset(slotId, admin, true, db)).resolves.toEqual({ reset: true });
    expect(emitSpy).toHaveBeenCalledWith('shoot:reset', { clientId: CLIENT_ID, period: PERIOD });

    const slot = await svc.getSlot(slotId, admin, db);
    expect(slot.slotStatus).toBe('Unset');
    expect(slot.slotDate).toBeNull();
    expect(slot.freelancerId).toBeNull();
    expect(slot.piecesExpected).toBe(3); // restored to client.pieces_per_visit
  });
});
