import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DB } from '@skaly/shared';
import { AuthService } from '../../src/services/AuthService.js';

// Integration test: real local Postgres (docker), Supabase + Redis mocked.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';

// Fixed marker domain so leftover rows from a crashed run are swept on setup.
const DOMAIN = '@invite.itest';
const email = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${DOMAIN}`;

const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

// ── Mocks ───────────────────────────────────────────────────────────────
// inviteUserByEmail creates the Supabase user (returns its id); updateUserById
// later sets that user's password at signup. No createUser in this flow.
const inviteUserByEmail = vi.fn(async () => ({
  data: { user: { id: randomUUID() } },
  error: null,
}));
const updateUserById = vi.fn(async (id: string) => ({ data: { user: { id } }, error: null }));
const supabaseAdmin = {
  auth: { admin: { inviteUserByEmail, updateUserById } },
} as unknown as SupabaseClient;

const redis = {
  set: vi.fn(async () => 'OK'),
  get: vi.fn(async () => null),
  del: vi.fn(async () => 1),
} as unknown as Redis;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

// Invite flow never touches R2 — a stub S3 client/bucket is enough here.
const service = new AuthService(db, redis, supabaseAdmin, logger, {} as never, 'test-bucket');

let adminId: string;

async function cleanup() {
  const rows = await db
    .selectFrom('staff')
    .select('id')
    .where('email', 'like', `%${DOMAIN}`)
    .execute();
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await db
      .deleteFrom('invite_links')
      .where((eb) => eb.or([eb('created_by', 'in', ids), eb('used_by', 'in', ids)]))
      .execute();
    await db.deleteFrom('staff').where('id', 'in', ids).execute();
  }
}

beforeAll(async () => {
  await cleanup();
  const admin = await db
    .insertInto('staff')
    .values({
      name: 'Invite Test Admin',
      email: email('admin'),
      role: 'admin',
      active: true,
      mfa_enrolled: false,
      supabase_uid: null,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  adminId = admin.id;
});

afterAll(async () => {
  await cleanup();
  await db.destroy();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AuthService — invite flow (integration)', () => {
  test('createInvite inserts a row with a 64-hex token and sends the Supabase email', async () => {
    const target = email('invitee');
    const invite = await service.createInvite({
      email: target,
      role: 'team_member',
      createdBy: adminId,
    });

    expect(invite.token).toMatch(/^[0-9a-f]{64}$/);

    // Email was dispatched with our token in user_metadata.
    expect(inviteUserByEmail).toHaveBeenCalledTimes(1);
    expect(inviteUserByEmail).toHaveBeenCalledWith(target, {
      data: { invite_token: invite.token },
    });

    const row = await db
      .selectFrom('invite_links')
      .selectAll()
      .where('id', '=', invite.id)
      .executeTakeFirst();
    expect(row).toBeTruthy();
    expect(row?.email).toBe(target);
    expect(row?.role).toBe('team_member');
    expect(row?.used_at).toBeNull();
    // The created Supabase user's id is persisted for signup to resolve.
    expect(row?.supabase_uid).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('consumeInviteSignup provisions the staff row and marks the invite used', async () => {
    const target = email('consume');
    const invite = await service.createInvite({
      email: target,
      role: 'manager',
      createdBy: adminId,
    });

    const result = await service.consumeInviteSignup({
      token: invite.token,
      password: 'ValidPass1!aa',
      name: 'New Hire',
      dateOfBirth: '1990-05-20',
      mobileNumber: '+11234567890',
    });

    // Password is set on the user created at invite time — not a new user.
    expect(updateUserById).toHaveBeenCalledWith(
      result.supabaseUid,
      expect.objectContaining({
        password: 'ValidPass1!aa',
        email_confirm: true,
        user_metadata: { name: 'New Hire' },
      }),
    );

    const staff = await db
      .selectFrom('staff')
      .selectAll()
      .where('id', '=', result.staffId)
      .executeTakeFirst();
    expect(staff?.email).toBe(target);
    expect(staff?.role).toBe('manager');
    expect(staff?.supabase_uid).toBe(result.supabaseUid);

    const usedInvite = await db
      .selectFrom('invite_links')
      .selectAll()
      .where('id', '=', invite.id)
      .executeTakeFirst();
    expect(usedInvite?.used_at).not.toBeNull();
    expect(usedInvite?.used_by).toBe(result.staffId);

    // Cache pre-warm fired with the 5-minute TTL.
    expect(redis.set).toHaveBeenCalledWith(
      `staff_lookup:${result.supabaseUid}`,
      expect.any(String),
      'EX',
      300,
    );
  });

  test('consuming the same invite twice throws INVITE_ALREADY_USED', async () => {
    const invite = await service.createInvite({
      email: email('twice'),
      role: 'team_member',
      createdBy: adminId,
    });
    const body = {
      token: invite.token,
      password: 'ValidPass1!aa',
      name: 'Once Only',
      dateOfBirth: '1992-02-02',
      mobileNumber: '+11234567891',
    };

    await service.consumeInviteSignup(body);
    await expect(service.consumeInviteSignup(body)).rejects.toMatchObject({
      code: 'INVITE_ALREADY_USED',
      statusCode: 409,
    });
  });

  test('consuming an unknown token throws INVITE_NOT_FOUND', async () => {
    await expect(
      service.consumeInviteSignup({
        token: 'deadbeef'.repeat(8),
        password: 'ValidPass1!aa',
        name: 'Ghost',
        dateOfBirth: '1991-01-01',
        mobileNumber: '+11234567892',
      }),
    ).rejects.toMatchObject({ code: 'INVITE_NOT_FOUND', statusCode: 404 });
  });

  test('consuming an expired invite throws INVITE_EXPIRED', async () => {
    const invite = await service.createInvite({
      email: email('expired'),
      role: 'team_member',
      createdBy: adminId,
    });
    await db
      .updateTable('invite_links')
      .set({ expires_at: sql`NOW() - INTERVAL '1 day'` })
      .where('id', '=', invite.id)
      .execute();

    await expect(
      service.consumeInviteSignup({
        token: invite.token,
        password: 'ValidPass1!aa',
        name: 'Too Late',
        dateOfBirth: '1993-03-03',
        mobileNumber: '+11234567893',
      }),
    ).rejects.toMatchObject({ code: 'INVITE_EXPIRED', statusCode: 410 });
  });

  test('consuming an invite for an email already in staff throws ALREADY_PROCESSED', async () => {
    const target = email('dupe');
    await db
      .insertInto('staff')
      .values({
        name: 'Existing',
        email: target,
        role: 'team_member',
        active: true,
        mfa_enrolled: false,
        supabase_uid: null,
      })
      .execute();

    const invite = await service.createInvite({
      email: target,
      role: 'team_member',
      createdBy: adminId,
    });

    await expect(
      service.consumeInviteSignup({
        token: invite.token,
        password: 'ValidPass1!aa',
        name: 'Existing',
        dateOfBirth: '1994-04-04',
        mobileNumber: '+11234567894',
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_PROCESSED', statusCode: 409 });
    // H-04 short-circuits before we touch the Supabase user.
    expect(updateUserById).not.toHaveBeenCalled();
  });

  test('H-04: a soft-deleted staff email still throws ALREADY_PROCESSED', async () => {
    const target = email('softdel');
    await db
      .insertInto('staff')
      .values({
        name: 'Gone',
        email: target,
        role: 'team_member',
        active: true,
        mfa_enrolled: false,
        supabase_uid: null,
        deleted_at: sql`NOW()`,
      })
      .execute();

    const invite = await service.createInvite({
      email: target,
      role: 'team_member',
      createdBy: adminId,
    });

    await expect(
      service.consumeInviteSignup({
        token: invite.token,
        password: 'ValidPass1!aa',
        name: 'Gone',
        dateOfBirth: '1995-05-05',
        mobileNumber: '+11234567895',
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_PROCESSED', statusCode: 409 });
  });
});
