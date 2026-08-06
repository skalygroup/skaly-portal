import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import { recomputeAllComingShootDates } from '../../src/jobs/coming-shoot-date-recompute.js';
import { ContentDropperService } from '../../src/services/ContentDropperService.js';

import type { DB } from '@skaly/shared';

/**
 * ADR-034 — the cron recompute and Trigger 1's recompute are ONE function.
 *
 * The parity tests below are therefore not checking that two implementations
 * agree; they are checking that nobody has quietly forked them. That is the
 * failure this ADR exists to prevent, and it is invisible in production because
 * both a correct and a drifted implementation write a plausible date.
 *
 * The manual-override case is the one that costs a human their work.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const dropper = new ContentDropperService();

const STAFF = 'ea000000-0000-4000-8000-0000000000a1';
const CLIENT_A = 'ea000000-0000-4000-8000-0000000000c1';
const CLIENT_B = 'ea000000-0000-4000-8000-0000000000c2';
const CLIENT_MANUAL = 'ea000000-0000-4000-8000-0000000000c3';
const INACTIVE = 'ea000000-0000-4000-8000-0000000000c4';
const PERIOD = '2090-06';
const DOMAIN = '@recompute.itest';

const CLIENTS = [CLIENT_A, CLIENT_B, CLIENT_MANUAL, INACTIVE];

/** Far-future dates so `slot_date >= CURRENT_DATE` is stable forever (A6). */
const EARLY = '2090-06-08';
const LATE = '2090-06-20';
const PAST = '2001-01-05';

async function setSlots(
  clientId: string,
  slots: { date: string | null; status: string }[],
): Promise<void> {
  await db.deleteFrom('shoot_schedules').where('client_id', '=', clientId).where('period', '=', PERIOD).execute();
  if (slots.length === 0) return;
  await db
    .insertInto('shoot_schedules')
    .values(
      slots.map((s, i) => ({
        period: PERIOD,
        client_id: clientId,
        slot_index: i + 1,
        slot_status: s.status,
        slot_date: s.date,
      })),
    )
    .execute();
}

async function setPipeline(clientId: string, source: string | null, date: string | null): Promise<void> {
  await db
    .updateTable('content_pipelines')
    .set({ coming_shoot_source: source, coming_shoot_date: date })
    .where('client_id', '=', clientId)
    .where('period', '=', PERIOD)
    .execute();
}

const readPipeline = async (clientId: string) =>
  db
    .selectFrom('content_pipelines')
    .select([
      'coming_shoot_source',
      'version',
      sql<string | null>`to_char(coming_shoot_date, 'YYYY-MM-DD')`.as('coming_shoot_date'),
    ])
    .where('client_id', '=', clientId)
    .where('period', '=', PERIOD)
    .executeTakeFirstOrThrow();

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values({ id: STAFF, name: 'Recompute Staff', email: `s${DOMAIN}`, role: 'admin', active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('clients')
    .values(
      CLIENTS.map((id, i) => ({
        id,
        name: `Recompute Client ${i}`,
        shoot_slots_per_month: 3,
        active: id !== INACTIVE,
      })),
    )
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();
});

beforeEach(async () => {
  await db.deleteFrom('content_pipelines').where('period', '=', PERIOD).execute();
  await db
    .insertInto('content_pipelines')
    .values(CLIENTS.map((id) => ({ period: PERIOD, client_id: id })))
    .execute();
  for (const id of CLIENTS) await setSlots(id, []);
});

afterAll(async () => {
  await db.deleteFrom('shoot_schedules').where('period', '=', PERIOD).execute();
  await db.deleteFrom('content_pipelines').where('period', '=', PERIOD).execute();
  await db.deleteFrom('clients').where('id', 'in', CLIENTS).execute();
  await db.destroy();
});

/**
 * The states worth checking: none confirmed, one, several (MIN wins), and all in
 * the past (nothing upcoming). Each is run through BOTH entry points.
 */
const STATES: [string, { date: string | null; status: string }[], string | null][] = [
  ['no slots at all', [], null],
  ['no confirmed slots', [{ date: EARLY, status: 'Scheduled' }], null],
  ['one confirmed slot', [{ date: LATE, status: 'Confirmed' }], LATE],
  [
    'several confirmed — the earliest wins',
    [
      { date: LATE, status: 'Confirmed' },
      { date: EARLY, status: 'Confirmed' },
    ],
    EARLY,
  ],
  ['all confirmed slots are in the past', [{ date: PAST, status: 'Confirmed' }], null],
  [
    'a past confirmed slot and an upcoming one',
    [
      { date: PAST, status: 'Confirmed' },
      { date: LATE, status: 'Confirmed' },
    ],
    LATE,
  ],
];

describe('⭐ parity: the cron path and the trigger path are the same function', () => {
  test.each(STATES)('%s', async (_label, slots, expected) => {
    // Trigger 1's entry point — one client, called directly.
    await setSlots(CLIENT_A, slots);
    await dropper.recomputeComingShootDate(CLIENT_A, PERIOD, db);

    // The cron's entry point — every client in the period.
    await setSlots(CLIENT_B, slots);
    await recomputeAllComingShootDates(db, PERIOD);

    const viaTrigger = await readPipeline(CLIENT_A);
    const viaCron = await readPipeline(CLIENT_B);

    expect(viaCron.coming_shoot_date).toBe(expected);
    expect(viaCron.coming_shoot_date).toBe(viaTrigger.coming_shoot_date);
    expect(viaCron.coming_shoot_source).toBe(viaTrigger.coming_shoot_source);
  });
});

describe('⭐ the manual override survives (the silent-drift case)', () => {
  test('a source=manual coming_shoot_date is NOT overwritten by the cron', async () => {
    const adminChoice = '2090-06-28';
    await setSlots(CLIENT_MANUAL, [{ date: EARLY, status: 'Confirmed' }]);
    await setPipeline(CLIENT_MANUAL, 'manual', adminChoice);

    await recomputeAllComingShootDates(db, PERIOD);

    const after = await readPipeline(CLIENT_MANUAL);
    expect(after.coming_shoot_date, "an admin's override must outlive the cron").toBe(adminChoice);
    expect(after.coming_shoot_source).toBe('manual');
  });

  test('the guard lives in the shared function, so the trigger honours it identically', async () => {
    const adminChoice = '2090-06-28';
    await setSlots(CLIENT_MANUAL, [{ date: EARLY, status: 'Confirmed' }]);
    await setPipeline(CLIENT_MANUAL, 'manual', adminChoice);

    await dropper.recomputeComingShootDate(CLIENT_MANUAL, PERIOD, db);

    expect((await readPipeline(CLIENT_MANUAL)).coming_shoot_date).toBe(adminChoice);
  });
});

describe('the cron write is a system write', () => {
  test('it does NOT bump version (ADR-013 orthogonal-column write)', async () => {
    await setSlots(CLIENT_A, [{ date: LATE, status: 'Confirmed' }]);
    const before = await readPipeline(CLIENT_A);

    await recomputeAllComingShootDates(db, PERIOD);

    const after = await readPipeline(CLIENT_A);
    expect(after.coming_shoot_date).toBe(LATE);
    expect(after.version, 'coming_shoot_date is orthogonal to the edit lock').toBe(before.version);
  });

  test('it audits to the System Actor, not to a person', async () => {
    await setSlots(CLIENT_A, [{ date: LATE, status: 'Confirmed' }]);
    await recomputeAllComingShootDates(db, PERIOD);

    const row = await db
      .selectFrom('audit_log')
      .select(['staff_id', 'changed_by_source'])
      .where('table_name', '=', 'content_pipelines')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();

    expect(row.staff_id).toBe('00000000-0000-0000-0000-000000000000');
    expect(row.changed_by_source).toBe('system');
  });

  test('it writes source=trigger, the same value the live trigger writes', async () => {
    await setSlots(CLIENT_A, [{ date: LATE, status: 'Confirmed' }]);
    await recomputeAllComingShootDates(db, PERIOD);

    expect((await readPipeline(CLIENT_A)).coming_shoot_source).toBe('trigger');
  });
});

describe('scope and resilience', () => {
  test('it covers every active client holding a pipeline row for the period', async () => {
    for (const id of [CLIENT_A, CLIENT_B]) await setSlots(id, [{ date: LATE, status: 'Confirmed' }]);

    const summary = await recomputeAllComingShootDates(db, PERIOD);

    // Four pipeline rows exist; the inactive client is excluded.
    expect(summary.clients).toBe(3);
    expect(summary.failed).toBe(0);
    expect((await readPipeline(CLIENT_A)).coming_shoot_date).toBe(LATE);
    expect((await readPipeline(CLIENT_B)).coming_shoot_date).toBe(LATE);
  });

  test('an inactive client is not recomputed', async () => {
    await setSlots(INACTIVE, [{ date: LATE, status: 'Confirmed' }]);
    await recomputeAllComingShootDates(db, PERIOD);

    expect((await readPipeline(INACTIVE)).coming_shoot_date).toBeNull();
  });

  test('running it twice changes nothing the second time (idempotent)', async () => {
    await setSlots(CLIENT_A, [{ date: LATE, status: 'Confirmed' }]);

    await recomputeAllComingShootDates(db, PERIOD);
    const first = await readPipeline(CLIENT_A);
    await recomputeAllComingShootDates(db, PERIOD);
    const second = await readPipeline(CLIENT_A);

    expect(second).toEqual(first);
  });

  test('a period with no pipeline rows is a clean no-op, not a crash', async () => {
    const summary = await recomputeAllComingShootDates(db, '2089-01');
    expect(summary).toEqual({ clients: 0, recomputed: 0, failed: 0 });
  });
});
