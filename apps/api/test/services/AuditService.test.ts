import { randomUUID } from 'node:crypto';

import { SYSTEM_ACTOR_UUID } from '@skaly/shared';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

import { AppError } from '../../src/lib/errors.js';
import { AuditService } from '../../src/services/AuditService.js';
import { AuthService } from '../../src/services/AuthService.js';

import type { S3Client } from '@aws-sdk/client-s3';
import type { DB } from '@skaly/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';

const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const audit = new AuditService();

// Unique table_name so direct-log rows can be swept without touching real audit
// rows. record_id has no FK, so any UUID is fine there.
const ITEST_ENTITY = 'itest_audit_entity';
const DOMAIN = '@audit.itest';

const actorId = randomUUID();
const adminId = randomUUID();

async function cleanup() {
  const staffIds = [actorId, adminId];
  // Direct-log rows (by our marker table_name) + any rows attributed to our
  // test staff + System Actor rows we produced against the marker entity.
  await db
    .deleteFrom('audit_log')
    .where((eb) =>
      eb.or([
        eb('table_name', '=', ITEST_ENTITY),
        eb('staff_id', 'in', staffIds),
      ]),
    )
    .execute();
  await db.deleteFrom('invite_links').where('created_by', 'in', staffIds).execute();
  await db.deleteFrom('staff').where('email', 'like', `%${DOMAIN}`).execute();
}

beforeAll(async () => {
  await cleanup();
  // System Actor must exist (FK: audit_log.staff_id → staff.id) for the C-04
  // fallback path. Idempotent.
  await db
    .insertInto('staff')
    .values({
      id: SYSTEM_ACTOR_UUID,
      name: 'System',
      email: 'system@skaly.internal',
      role: 'admin',
      active: true,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await db
    .insertInto('staff')
    .values([
      { id: actorId, name: 'Audit Actor', email: `actor-${actorId}${DOMAIN}`, role: 'admin', active: true },
      { id: adminId, name: 'Invite Admin', email: `admin-${adminId}${DOMAIN}`, role: 'admin', active: true },
    ])
    .execute();
});

afterAll(async () => {
  await cleanup();
  await db.destroy();
});

describe('AuditService.log', () => {
  test('writes a row with the given staff_id and changed_by_source = user', async () => {
    const recordId = randomUUID();
    const id = await audit.log({
      actorId,
      entity: ITEST_ENTITY,
      entityId: recordId,
      action: 'INSERT',
      after: { field: 'value' },
      trx: db,
    });

    const row = await db.selectFrom('audit_log').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.staff_id).toBe(actorId);
    expect(row.changed_by_source).toBe('user');
    expect(row.table_name).toBe(ITEST_ENTITY);
    expect(row.record_id).toBe(recordId);
    expect(row.action).toBe('INSERT');
    expect(row.new_value).toEqual({ field: 'value' });
  });

  test('actorId = null falls back to SYSTEM_ACTOR_UUID with changed_by_source = system (C-04)', async () => {
    const id = await audit.log({
      actorId: null,
      entity: ITEST_ENTITY,
      action: 'UPDATE',
      trx: db,
    });

    const row = await db.selectFrom('audit_log').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.staff_id).toBe(SYSTEM_ACTOR_UUID);
    expect(row.changed_by_source).toBe('system');
  });

  test('rejects an invalid (non-enum) action before it can hit the DB', async () => {
    const before = await db
      .selectFrom('audit_log')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('table_name', '=', ITEST_ENTITY)
      .executeTakeFirstOrThrow();

    // 'invite.create' is a Sprint 1 dotted string, not one of the six enum values.
    await expect(
      audit.log({ actorId, entity: ITEST_ENTITY, action: 'invite.create' as never, trx: db }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });

    const after = await db
      .selectFrom('audit_log')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('table_name', '=', ITEST_ENTITY)
      .executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n)); // guard blocked the write
  });

  test('thrown errors are AppError instances', async () => {
    const err = await audit
      .log({ actorId, entity: ITEST_ENTITY, action: 'nope' as never, trx: db })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
  });
});

describe('Sprint 1 swap: createInvite writes a real audit_log row', () => {
  test('an INSERT row on invite_links now exists after createInvite', async () => {
    const inviteUserByEmail = vi.fn(async () => ({ data: { user: { id: randomUUID() } }, error: null }));
    const supabaseAdmin = {
      auth: { admin: { inviteUserByEmail } },
    } as unknown as SupabaseClient;
    const redis = { set: vi.fn(), get: vi.fn(), del: vi.fn() } as unknown as Redis;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

    const service = new AuthService(db, redis, supabaseAdmin, logger, {} as S3Client, 'test-bucket');

    const invite = await service.createInvite({
      email: `invitee-${randomUUID()}${DOMAIN}`,
      role: 'team_member',
      createdBy: adminId,
    });

    const row = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('record_id', '=', invite.id)
      .executeTakeFirstOrThrow();
    expect(row.table_name).toBe('invite_links');
    expect(row.action).toBe('INSERT');
    expect(row.staff_id).toBe(adminId);
    expect(row.changed_by_source).toBe('user');
  });
});