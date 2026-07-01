import { randomUUID } from 'node:crypto';

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

import { AppError } from '../../src/lib/errors.js';
import { softDelete, softDeletable } from '../../src/lib/queries.js';
import {
  assertPeriodNotLocked,
  optimisticUpdate,
  getCurrentPeriod,
  currentIstPeriod,
} from '../../src/services/BaseService.js';

import type { DB } from '@skaly/shared';

// Integration test: real local Postgres (docker). No mocks — these utilities
// are pure DB behaviour.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';

const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

// ── Fixtures / markers ────────────────────────────────────────────────────
// Far-past test periods that can't collide with a real IST month.
const PERIOD_UNLOCKED = '2000-01';
const PERIOD_LOCKED = '2000-02';
const DOMAIN = '@baseservice.itest';
const CLIENT_MARKER = 'BASESVC-ITEST';

const actorId = randomUUID();
const actorName = 'BaseService Updater';
let clientId: string;

async function cleanup() {
  // FK-safe order: child rows → parents.
  await db.deleteFrom('attendance_logs').where('period', 'in', [PERIOD_UNLOCKED, PERIOD_LOCKED]).execute();
  await db.deleteFrom('content_pipelines').where('period', 'in', [PERIOD_UNLOCKED, PERIOD_LOCKED]).execute();
  await db.deleteFrom('clients').where('name', 'like', `${CLIENT_MARKER}%`).execute();
  await db.deleteFrom('staff').where('email', 'like', `%${DOMAIN}`).execute();
  await db.deleteFrom('months').where('period', 'in', [PERIOD_UNLOCKED, PERIOD_LOCKED]).execute();
}

beforeAll(async () => {
  await cleanup();

  await db
    .insertInto('staff')
    .values({ id: actorId, name: actorName, email: `actor-${actorId}${DOMAIN}`, role: 'admin', active: true })
    .execute();

  await db
    .insertInto('months')
    .values([
      { period: PERIOD_UNLOCKED, label: PERIOD_UNLOCKED, locked: false },
      { period: PERIOD_LOCKED, label: PERIOD_LOCKED, locked: true },
    ])
    .execute();

  const client = await db
    .insertInto('clients')
    .values({ name: `${CLIENT_MARKER}-pipeline`, shoot_slots_per_month: 4 })
    .returning('id')
    .executeTakeFirstOrThrow();
  clientId = client.id;
});

afterAll(async () => {
  await cleanup();
  await db.destroy();
});

afterEach(() => {
  vi.useRealTimers();
});

// Insert an attendance_logs row (versioned + has updated_at) and return its id.
async function insertAttendance(date: string, version: number, updatedBy?: string): Promise<string> {
  const row = await db
    .insertInto('attendance_logs')
    .values({ period: PERIOD_UNLOCKED, staff_id: actorId, date, version, updated_by: updatedBy ?? null })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

describe('assertPeriodNotLocked', () => {
  test('resolves for an unlocked period', async () => {
    await expect(assertPeriodNotLocked(PERIOD_UNLOCKED, db)).resolves.toBeUndefined();
  });

  test('throws PERIOD_LOCKED (423) for a locked period', async () => {
    await expect(assertPeriodNotLocked(PERIOD_LOCKED, db)).rejects.toMatchObject({
      code: 'PERIOD_LOCKED',
      statusCode: 423,
    });
  });

  test('throws PERIOD_NOT_FOUND (404) for a missing period', async () => {
    await expect(assertPeriodNotLocked('1900-01', db)).rejects.toMatchObject({
      code: 'PERIOD_NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('optimisticUpdate', () => {
  test('succeeds and increments version + stamps updated_at on a matching version', async () => {
    const id = await insertAttendance('2000-01-05', 1);

    const updated = await optimisticUpdate('attendance_logs', id, 1, { present: true, updated_by: actorId }, db);

    expect(updated.version).toBe(2);
    expect(updated.present).toBe(true);
    expect(updated.updated_at).not.toBeNull();
  });

  test('succeeds on content_pipelines, which has no updated_at column', async () => {
    const inserted = await db
      .insertInto('content_pipelines')
      .values({ period: PERIOD_UNLOCKED, client_id: clientId, version: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();

    const updated = await optimisticUpdate('content_pipelines', inserted.id, 1, { visit_type: 'shoot' }, db);

    expect(updated.version).toBe(2);
    expect(updated.visit_type).toBe('shoot');
  });

  test('throws STALE_DATA (409) with details.currentVersion + updatedBy on a version mismatch', async () => {
    const id = await insertAttendance('2000-01-06', 5, actorId);

    await expect(optimisticUpdate('attendance_logs', id, 1, { present: true }, db)).rejects.toMatchObject({
      code: 'STALE_DATA',
      statusCode: 409,
      details: {
        currentVersion: 5,
        updatedBy: { staffId: actorId, name: actorName },
      },
    });
  });
});

describe('softDelete + softDeletable', () => {
  test('stamps deleted_at; a subsequent softDeletable SELECT excludes the row', async () => {
    const inserted = await db
      .insertInto('clients')
      .values({ name: `${CLIENT_MARKER}-todelete`, shoot_slots_per_month: 2 })
      .returning('id')
      .executeTakeFirstOrThrow();

    await softDelete('clients', inserted.id, actorId, db);

    const raw = await db.selectFrom('clients').selectAll().where('id', '=', inserted.id).executeTakeFirst();
    expect(raw?.deleted_at).not.toBeNull();

    const visible = await softDeletable(
      db.selectFrom('clients').selectAll().where('id', '=', inserted.id),
    ).executeTakeFirst();
    expect(visible).toBeUndefined();
  });
});

describe('getCurrentPeriod', () => {
  test('returns the IST-current month when it exists', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2000-01-15T12:00:00+05:30'));
    expect(currentIstPeriod()).toBe(PERIOD_UNLOCKED); // sanity: fake clock → IST period

    const row = await getCurrentPeriod(db);
    expect(row.period).toBe(PERIOD_UNLOCKED);
  });

  test('falls back to the latest period when the current one does not exist', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('1999-06-15T12:00:00+05:30')); // '1999-06' has no months row

    const latest = await db
      .selectFrom('months')
      .select('period')
      .orderBy('period', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();

    const row = await getCurrentPeriod(db);
    expect(row.period).toBe(latest.period);
  });
});

// Guards the AppError contract the utilities throw.
test('thrown errors are AppError instances', async () => {
  const err = await assertPeriodNotLocked(PERIOD_LOCKED, db).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
});