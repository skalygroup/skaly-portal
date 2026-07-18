import { SYSTEM_ACTOR_UUID } from '@skaly/shared';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';


import { registerEventListeners } from '../../src/events/listeners.js';
import { ContentDropperService } from '../../src/services/ContentDropperService.js';
import { ShootPlannerService } from '../../src/services/ShootPlannerService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type { DB } from '@skaly/shared';
import type { Logger } from 'pino';

// Trigger 1 — the REAL EventBus loop that closes here (Testing-Strategy §4.2,
// ADR-012). A confirmed/reset shoot slot fires shoot:confirmed / shoot:reset →
// the registered listener recomputes content_pipelines.coming_shoot_date. This
// is the exact coming_shoot_date assertion the Sprint 5 guide deferred to
// Sprint 6. Real local Postgres; own future-period namespace (2098-06).
//
// The listener handler is fire-and-forget (`void recompute(...)`), so after an
// update() returns the recompute may still be in flight — hence waitFor/settle.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const shoot = new ShootPlannerService();
const dropper = new ContentDropperService();

const PERIOD = '2098-06';
const D1 = '2098-06-10';
const D2 = '2098-06-20';
const DOMAIN = '@trigger1.itest';

const ADMIN_ID = 'f0000000-0000-4000-8000-00000000f001';
const CLIENT_ID = 'f0000000-0000-4000-8000-00000000f0c1';
const admin: CurrentUser = { staffId: ADMIN_ID, role: 'admin' };

const silentLog = { info: () => {}, error: (o: unknown) => console.error('recompute error', o) } as unknown as Logger;

/** Poll `fn` until it returns a truthy value or timeout — the async recompute barrier. */
async function waitFor<T>(fn: () => Promise<T>, timeout = 3000, interval = 25): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Give a fire-and-forget recompute time to run when asserting a NON-change. */
const settle = () => new Promise((r) => setTimeout(r, 300));

async function seedPipeline(): Promise<string> {
  const row = await db
    .insertInto('content_pipelines')
    .values({ period: PERIOD, client_id: CLIENT_ID })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Insert an Unset slot, drive it Scheduled→Confirmed (fires shoot:confirmed). */
async function confirmSlot(slotDate: string, slotIndex: number): Promise<string> {
  const row = await db
    .insertInto('shoot_schedules')
    .values({ period: PERIOD, client_id: CLIENT_ID, slot_index: slotIndex, slot_status: 'Unset', pieces_expected: 3 })
    .returning('id')
    .executeTakeFirstOrThrow();
  await shoot.update(row.id, { slotStatus: 'Scheduled', slotDate }, admin, db);
  await shoot.update(row.id, { slotStatus: 'Confirmed' }, admin, db);
  return row.id;
}

/** Read coming_shoot_date (as YYYY-MM-DD)/source/version for the fixture pipeline. */
async function readComing() {
  return db
    .selectFrom('content_pipelines')
    .select((eb) => [
      eb.fn<string | null>('to_char', ['coming_shoot_date', eb.val('YYYY-MM-DD')]).as('date'),
      'coming_shoot_source as source',
      'version',
    ])
    .where('client_id', '=', CLIENT_ID)
    .where('period', '=', PERIOD)
    .executeTakeFirstOrThrow();
}

async function cleanupData() {
  await db.deleteFrom('shoot_schedules').where('period', '=', PERIOD).execute();
  await db.deleteFrom('content_pipelines').where('period', '=', PERIOD).execute();
}

beforeAll(async () => {
  // Register the REAL listeners against this test's db so triggers actually fire.
  registerEventListeners(db, silentLog);

  await db
    .insertInto('staff')
    .values([
      { id: ADMIN_ID, name: 'Trigger1 Admin', email: `admin-${ADMIN_ID}${DOMAIN}`, role: 'admin', active: true },
      // System Actor — FK target for the recompute's changed_by_source='system' audit
      // (C-04). Seeded via the DB seed in real envs, but CI runs migrations only.
      { id: SYSTEM_ACTOR_UUID, name: 'System', email: 'system@skaly.internal', role: 'admin', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();
  await db
    .insertInto('clients')
    .values({ id: CLIENT_ID, name: 'Trigger1 Client', shoot_slots_per_month: 4, pieces_per_visit: 3, active: true, is_internal: false })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await cleanupData();
});

afterEach(cleanupData);

afterAll(async () => {
  await cleanupData();
  await db.destroy();
});

describe('Trigger 1 — coming_shoot_date recompute via the real EventBus', () => {
  test('confirming a future slot sets coming_shoot_date to that date, source=trigger', async () => {
    await seedPipeline();
    await confirmSlot(D1, 1);

    const row = await waitFor(async () => {
      const r = await readComing();
      return r.date ? r : null;
    });
    expect(row.date).toBe(D1);
    expect(row.source).toBe('trigger');
  });

  test('multi-slot: coming_shoot_date = MIN, order-independent (confirm D2 then D1 → D1)', async () => {
    await seedPipeline();
    await confirmSlot(D2, 1); // later, confirmed first
    await waitFor(async () => ((await readComing()).date === D2 ? true : null));
    await confirmSlot(D1, 2); // earlier

    await waitFor(async () => ((await readComing()).date === D1 ? true : null));
    expect((await readComing()).date).toBe(D1);
  });

  test('reset the earliest confirmed slot → recompute to the next date; reset all → NULL', async () => {
    await seedPipeline();
    const slot1 = await confirmSlot(D1, 1);
    await confirmSlot(D2, 2);
    await waitFor(async () => ((await readComing()).date === D1 ? true : null));

    await shoot.reset(slot1, admin, true, db); // shoot:reset → recompute
    await waitFor(async () => ((await readComing()).date === D2 ? true : null));
    expect((await readComing()).date).toBe(D2);

    const slot2 = await db
      .selectFrom('shoot_schedules')
      .select('id')
      .where('period', '=', PERIOD)
      .where('slot_index', '=', 2)
      .executeTakeFirstOrThrow();
    await shoot.reset(slot2.id, admin, true, db);
    await waitFor(async () => ((await readComing()).date === null ? true : null));
    expect((await readComing()).date).toBeNull();
  });

  test('manual override is never clobbered by a confirm (ADR-012 guard)', async () => {
    const id = await seedPipeline();
    await db
      .updateTable('content_pipelines')
      .set({ coming_shoot_source: 'manual', coming_shoot_date: '2098-06-01' })
      .where('id', '=', id)
      .execute();

    await confirmSlot(D1, 1);
    await settle();

    const row = await readComing();
    expect(row.date).toBe('2098-06-01');
    expect(row.source).toBe('manual');
  });

  test('orthogonal write: recompute does NOT bump version; a stage edit with the original version still succeeds', async () => {
    const id = await seedPipeline(); // version 1
    await confirmSlot(D1, 1);
    // Barrier: wait for the recompute to actually land.
    await waitFor(async () => ((await readComing()).date === D1 ? true : null));

    // The recompute wrote coming_shoot_date but must NOT have touched version.
    expect((await readComing()).version).toBe(1);

    // A concurrent stage edit using the ORIGINAL version must not false-conflict.
    const afterRaw = await dropper.updateStage(id, 'raw', admin, 1, db);
    expect(afterRaw.rawReceivedAt).not.toBeNull();
    expect(afterRaw.version).toBe(2); // only the user write bumps version
  });
});
