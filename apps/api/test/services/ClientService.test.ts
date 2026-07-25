import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterEach, afterAll } from 'vitest';

import { datesInPeriod } from '../../src/lib/period-days.js';
import { currentIstPeriod } from '../../src/services/BaseService.js';
import { ClientService } from '../../src/services/ClientService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type { DB } from '@skaly/shared';

/**
 * ClientService.create / deactivate (Sprint 9 STEP 2) — real local Postgres.
 *
 * `create` deliberately generates rows for the LIVE current period (that is what
 * getCurrentPeriod resolves), so this suite cannot pick a private period the way
 * period-generation.test.ts does. It cleans up by client_id instead, and only
 * ever touches clients it created itself.
 *
 * The role gates are asserted here rather than through the routes because the
 * gates live in the service — that is the whole point of STEP 2 (the Sprint 9
 * bot tools call these methods directly, bypassing requireRole).
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const svc = new ClientService();

const PERIOD = currentIstPeriod();
const DAYS = datesInPeriod(PERIOD).length;

const ADMIN_ID = 'e0000000-0000-4000-8000-0000000c5a01';
const MANAGER_ID = 'e0000000-0000-4000-8000-0000000c5a02';
const MEMBER_ID = 'e0000000-0000-4000-8000-0000000c5a03';

const admin: CurrentUser = { staffId: ADMIN_ID, role: 'admin' };
const manager: CurrentUser = { staffId: MANAGER_ID, role: 'manager' };
const member: CurrentUser = { staffId: MEMBER_ID, role: 'team_member' };

/** Clients this suite created — torn down with every row they generated. */
const created: string[] = [];

async function createTracked(input: Parameters<ClientService['create']>[0], user = admin) {
  const client = await svc.create(input, user, db);
  created.push(client.id);
  return client;
}

async function countsFor(clientId: string) {
  const one = async (table: 'shoot_schedules' | 'content_pipelines' | 'content_calendar') => {
    const r = await db
      .selectFrom(table)
      .select((eb) => eb.fn.countAll().as('n'))
      .where('period', '=', PERIOD)
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

async function cleanup() {
  if (created.length === 0) return;
  await db.deleteFrom('shoot_schedules').where('client_id', 'in', created).execute();
  await db.deleteFrom('content_calendar').where('client_id', 'in', created).execute();
  await db.deleteFrom('content_pipelines').where('client_id', 'in', created).execute();
  await db.deleteFrom('audit_log').where('record_id', 'in', created).execute();
  await db.deleteFrom('clients').where('id', 'in', created).execute();
  created.length = 0;
}

beforeAll(async () => {
  // getCurrentPeriod falls back to the latest period if the current month has no
  // row; pin it so the assertions know which period the rows land in.
  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();
  // Audit actors — audit_log.staff_id is a FK to staff.
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN_ID, name: 'CS Admin', email: 'cs-admin@skaly.test', role: 'admin', active: true },
      { id: MANAGER_ID, name: 'CS Manager', email: 'cs-manager@skaly.test', role: 'manager', active: true },
      { id: MEMBER_ID, name: 'CS Member', email: 'cs-member@skaly.test', role: 'team_member', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await cleanup();
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await db.deleteFrom('staff').where('id', 'in', [ADMIN_ID, MANAGER_ID, MEMBER_ID]).execute();
  await db.destroy();
});

describe('ClientService.create', () => {
  test('missing shootSlotsPerMonth → 400 CLIENT_SHOOT_SLOTS_REQUIRED', async () => {
    await expect(
      // The column has no DEFAULT — the service must refuse rather than invent one.
      svc.create({ name: 'No Slots Co' } as never, admin, db),
    ).rejects.toMatchObject({ code: 'CLIENT_SHOOT_SLOTS_REQUIRED' });

    // Out of adjustSlotCount's 1..20 range → same guard.
    await expect(
      svc.create({ name: 'Too Many Slots Co', shootSlotsPerMonth: 21 } as never, admin, db),
    ).rejects.toMatchObject({ code: 'CLIENT_SHOOT_SLOTS_REQUIRED' });
  });

  test('active, non-internal → shoot slots AND a pipeline row AND calendar cells for the current period', async () => {
    const client = await createTracked({
      name: 'Backfilled Co',
      shootSlotsPerMonth: 3,
      piecesPerVisit: 2,
      isInternal: false,
    });
    expect(client.active).toBe(true);

    expect(await countsFor(client.id)).toEqual({ slots: 3, pipelines: 1, cells: DAYS });

    // pieces_expected comes from pieces_per_visit, and every slot starts Unset.
    const slots = await db
      .selectFrom('shoot_schedules')
      .selectAll()
      .where('client_id', '=', client.id)
      .execute();
    expect(slots.every((s) => s.slot_status === 'Unset' && s.pieces_expected === 2)).toBe(true);
  });

  test('isInternal → none of the three row sets', async () => {
    const client = await createTracked({
      name: 'Internal Co',
      shootSlotsPerMonth: 4,
      isInternal: true,
    });
    expect(await countsFor(client.id)).toEqual({ slots: 0, pipelines: 0, cells: 0 });
  });

  test('audits as INSERT against the calling human', async () => {
    const client = await createTracked({ name: 'Audited Co', shootSlotsPerMonth: 1 });
    const row = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('record_id', '=', client.id)
      .executeTakeFirstOrThrow();
    expect(row.action).toBe('INSERT');
    expect(row.table_name).toBe('clients');
    expect(row.staff_id).toBe(ADMIN_ID);
  });

  test('manager may create; team_member is refused', async () => {
    const client = await createTracked({ name: 'Manager Made Co', shootSlotsPerMonth: 2 }, manager);
    expect(client.name).toBe('Manager Made Co');

    await expect(
      svc.create({ name: 'Member Made Co', shootSlotsPerMonth: 2 }, member, db),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('ClientService.deactivate', () => {
  test('soft-deletes, sets active=false, and leaves history untouched', async () => {
    const client = await createTracked({ name: 'Retired Co', shootSlotsPerMonth: 2 });
    const before = await countsFor(client.id);
    expect(before).toEqual({ slots: 2, pipelines: 1, cells: DAYS });

    expect(await svc.deactivate(client.id, admin, db)).toEqual({ deactivated: true });

    const row = await db
      .selectFrom('clients')
      .selectAll()
      .where('id', '=', client.id)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
    expect(row.active).toBe(false);

    // The client leaves future generation, not the record of work already done.
    expect(await countsFor(client.id)).toEqual(before);
  });

  test('list() excludes a deactivated client, with and without includeInactive', async () => {
    const client = await createTracked({ name: 'Vanishing Co', shootSlotsPerMonth: 1 });
    expect((await svc.list({ includeInactive: false }, db)).map((c) => c.id)).toContain(client.id);

    await svc.deactivate(client.id, admin, db);

    expect((await svc.list({ includeInactive: false }, db)).map((c) => c.id)).not.toContain(client.id);
    // includeInactive relaxes `active`, never `deleted_at` (audit H-02).
    expect((await svc.list({ includeInactive: true }, db)).map((c) => c.id)).not.toContain(client.id);
  });

  test('manager is refused; a missing client is 404', async () => {
    const client = await createTracked({ name: 'Admin Only Co', shootSlotsPerMonth: 1 });
    await expect(svc.deactivate(client.id, manager, db)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });

    await expect(
      svc.deactivate('e0000000-0000-4000-8000-00000000dead', admin, db),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  test('deactivating twice → 404 the second time (already tombstoned)', async () => {
    const client = await createTracked({ name: 'Twice Co', shootSlotsPerMonth: 1 });
    await svc.deactivate(client.id, admin, db);
    await expect(svc.deactivate(client.id, admin, db)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });
});
