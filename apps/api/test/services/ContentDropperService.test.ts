import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';

import { eventBus } from '../../src/lib/EventBus.js';
import { currentIstDate } from '../../src/services/BaseService.js';
import { ContentDropperService } from '../../src/services/ContentDropperService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type { DB } from '@skaly/shared';

// ContentDropperService smoke (STEP 2): derived status, stage sequence, optimistic
// version, forward-only, the period lock, and the Trigger-2 pipeline:posted emit.
// Real local Postgres; no socket server. STEP 5 extends this file (+ Trigger 1 /
// route suites). Own period namespace (1997-*) — no other suite touches it.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const svc = new ContentDropperService();

const PERIOD = '1997-11';
const LOCKED_PERIOD = '1997-10';
const DOMAIN = '@dropper.itest';

const ADMIN_ID = 'e0000000-0000-4000-8000-00000000e001';
const CLIENT_ID = 'e0000000-0000-4000-8000-00000000e0c1';
const INTERNAL_ID = 'e0000000-0000-4000-8000-00000000e0c2';
const admin: CurrentUser = { staffId: ADMIN_ID, role: 'admin' };
const teamMember: CurrentUser = { staffId: ADMIN_ID, role: 'team_member' };

async function cleanupData() {
  await db.deleteFrom('shoot_schedules').where('period', 'in', [PERIOD, LOCKED_PERIOD]).execute();
  await db.deleteFrom('content_pipelines').where('period', 'in', [PERIOD, LOCKED_PERIOD]).execute();
}

/** Insert one Confirmed shoot slot. Future-dated by default (>= CURRENT_DATE). */
async function seedConfirmedSlot(slotDate: string, slotIndex = 1): Promise<void> {
  await db
    .insertInto('shoot_schedules')
    .values({
      period: PERIOD,
      client_id: CLIENT_ID,
      slot_index: slotIndex,
      slot_status: 'Confirmed',
      slot_date: slotDate,
      pieces_expected: 3,
    })
    .execute();
}

/** Read one pipeline's coming_shoot_date/source/version directly. */
async function readComing(clientId = CLIENT_ID) {
  return db
    .selectFrom('content_pipelines')
    .select((eb) => [
      eb.fn<string | null>('to_char', ['coming_shoot_date', eb.val('YYYY-MM-DD')]).as('date'),
      'coming_shoot_source as source',
      'version',
    ])
    .where('client_id', '=', clientId)
    .where('period', '=', PERIOD)
    .executeTakeFirstOrThrow();
}

/** Insert one pipeline row and return its id (version defaults to 1). */
async function seedPipeline(
  over: Partial<{ period: string; client_id: string; raw_received_at: unknown; finals_ready_at: unknown }> = {},
): Promise<string> {
  const row = await db
    .insertInto('content_pipelines')
    .values({ period: PERIOD, client_id: CLIENT_ID, ...over } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values({ id: ADMIN_ID, name: 'Dropper Admin', email: `admin-${ADMIN_ID}${DOMAIN}`, role: 'admin', active: true })
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
    .values([
      { id: CLIENT_ID, name: 'Dropper Client', shoot_slots_per_month: 4, pieces_per_visit: 3, active: true, is_internal: false },
      { id: INTERNAL_ID, name: 'Internal Co', shoot_slots_per_month: 4, pieces_per_visit: 3, active: true, is_internal: true },
    ])
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

describe('getGrid — derived status + filtering', () => {
  test('derives status/stagesComplete and excludes internal clients', async () => {
    await seedPipeline(); // active client, no stages → Awaiting
    await seedPipeline({ client_id: INTERNAL_ID }); // internal → excluded

    const rows = await svc.getGrid(PERIOD, admin, db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clientId).toBe(CLIENT_ID);
    expect(rows[0]!.status).toBe('Awaiting');
    expect(rows[0]!.stagesComplete).toBe(0);
    expect(rows[0]!.version).toBe(1);
  });

  test('team_member is rejected at the service layer', async () => {
    await expect(svc.getGrid(PERIOD, teamMember, db)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('updateStage — sequence, version, derived status', () => {
  test('finals before raw → STAGE_SEQUENCE_VIOLATION; posted before finals → STAGE_SEQUENCE_VIOLATION', async () => {
    const id = await seedPipeline();
    await expect(svc.updateStage(id, 'finals', admin, 1, db)).rejects.toMatchObject({
      code: 'STAGE_SEQUENCE_VIOLATION',
    });
    await expect(svc.updateStage(id, 'posted', admin, 1, db)).rejects.toMatchObject({
      code: 'STAGE_SEQUENCE_VIOLATION',
    });
  });

  test('raw → finals → posted each succeeds, stamps a server timestamp, bumps version, advances status', async () => {
    const id = await seedPipeline();

    const afterRaw = await svc.updateStage(id, 'raw', admin, 1, db);
    expect(afterRaw.rawReceivedAt).not.toBeNull();
    expect(afterRaw.status).toBe('Editing');
    expect(afterRaw.stagesComplete).toBe(1);
    expect(afterRaw.version).toBe(2);
    expect(afterRaw.updatedBy?.staffId).toBe(ADMIN_ID);

    const afterFinals = await svc.updateStage(id, 'finals', admin, afterRaw.version, db);
    expect(afterFinals.status).toBe('Review');
    expect(afterFinals.stagesComplete).toBe(2);
    expect(afterFinals.version).toBe(3);

    const afterPosted = await svc.updateStage(id, 'posted', admin, afterFinals.version, db);
    expect(afterPosted.status).toBe('Posted');
    expect(afterPosted.stagesComplete).toBe(3);
    expect(afterPosted.version).toBe(4);
  });

  test('forward-only: re-marking a set stage → VALIDATION_ERROR', async () => {
    const id = await seedPipeline();
    const afterRaw = await svc.updateStage(id, 'raw', admin, 1, db);
    await expect(svc.updateStage(id, 'raw', admin, afterRaw.version, db)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  test('optimistic lock (C-02): a stale expectedVersion → STALE_DATA', async () => {
    const id = await seedPipeline();
    await svc.updateStage(id, 'raw', admin, 1, db); // version → 2
    await expect(svc.updateStage(id, 'finals', admin, 1, db)).rejects.toMatchObject({
      code: 'STALE_DATA',
    });
  });

  test('period lock → PERIOD_LOCKED', async () => {
    const id = await seedPipeline({ period: LOCKED_PERIOD });
    await expect(svc.updateStage(id, 'raw', admin, 1, db)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
  });
});

describe('recomputeComingShootDate — Trigger 1 consumer (ADR-012, smoke)', () => {
  test('confirmed future slot → coming_shoot_date set, source trigger, version NOT bumped (orthogonal)', async () => {
    await seedPipeline(); // version 1, coming_shoot_date null, source null
    await seedConfirmedSlot('2099-06-15');

    await svc.recomputeComingShootDate(CLIENT_ID, PERIOD, db);

    const row = await readComing();
    expect(row.date).toBe('2099-06-15');
    expect(row.source).toBe('trigger');
    expect(row.version).toBe(1); // orthogonal write — no version bump (ADR-012)
  });

  test('MIN over multiple confirmed future slots (order-independent)', async () => {
    await seedPipeline();
    await seedConfirmedSlot('2099-09-01', 2); // later
    await seedConfirmedSlot('2099-06-15', 1); // earlier

    await svc.recomputeComingShootDate(CLIENT_ID, PERIOD, db);
    expect((await readComing()).date).toBe('2099-06-15');
  });

  test('manual override is never clobbered', async () => {
    const id = await seedPipeline();
    await db
      .updateTable('content_pipelines')
      .set({ coming_shoot_source: 'manual', coming_shoot_date: '2099-01-01' })
      .where('id', '=', id)
      .execute();
    await seedConfirmedSlot('2099-06-15');

    await svc.recomputeComingShootDate(CLIENT_ID, PERIOD, db);

    const row = await readComing();
    expect(row.date).toBe('2099-01-01');
    expect(row.source).toBe('manual');
  });
});

describe('Trigger 2 — pipeline:posted emit (H-02)', () => {
  test('posted emits pipeline:posted once with server IST CURRENT_DATE; non-posted emits nothing', async () => {
    const id = await seedPipeline();
    await svc.updateStage(id, 'raw', admin, 1, db);

    const emitSpy = vi.spyOn(eventBus, 'emit');
    const afterFinals = await svc.updateStage(id, 'finals', admin, 2, db);
    expect(emitSpy).not.toHaveBeenCalled(); // finals emits nothing

    await svc.updateStage(id, 'posted', admin, afterFinals.version, db);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('pipeline:posted', {
      clientId: CLIENT_ID,
      period: PERIOD,
      postedAt: currentIstDate(),
    });
  });
});
