import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import Fastify from 'fastify';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

import { AuthService } from '../../src/services/AuthService.js';

import type { DB } from '@skaly/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

// Integration: real local Postgres, S3/R2 mocked via aws-sdk-client-mock.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const DOMAIN = '@signup.itest';
const email = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${DOMAIN}`;

const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const s3Mock = mockClient(S3Client);
const s3 = new S3Client({ region: 'auto' });
const R2_BUCKET = 'test-bucket';

const redis = { set: vi.fn(), get: vi.fn(async () => null), del: vi.fn() } as unknown as Redis;
const supabaseAdmin = {} as unknown as SupabaseClient;
const infoSpy = vi.fn();
const logger = { info: infoSpy, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const service = new AuthService(db, redis, supabaseAdmin, logger, s3, R2_BUCKET);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CV_PDF = readFileSync(path.join(__dirname, '../fixtures/cv.pdf'));
const pdfStream = () => Readable.from(CV_PDF);

function form(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Jane Applicant',
    email: email('applicant'),
    dateOfBirth: '1995-06-15',
    mobileNumber: '+11234567890',
    roleRequested: 'team_member' as const,
    ...overrides,
  };
}

function notifyCalls() {
  return infoSpy.mock.calls.filter(
    ([obj]) => obj && typeof obj === 'object' && 'notification' in obj,
  );
}

function activeAdmins() {
  return db
    .selectFrom('staff')
    .select('id')
    .where('role', '=', 'admin')
    .where('active', '=', true)
    .where('deleted_at', 'is', null)
    .execute();
}

async function cleanup() {
  await db.deleteFrom('signup_requests').where('email', 'like', `%${DOMAIN}`).execute();
  await db.deleteFrom('staff').where('email', 'like', `%${DOMAIN}`).execute();
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await db.destroy();
});
beforeEach(() => {
  vi.clearAllMocks();
  s3Mock.reset();
  s3Mock.on(PutObjectCommand).resolves({});
});

describe('AuthService.signupRequest (integration)', () => {
  test('valid form, no CV → pending row + one notification per active admin', async () => {
    const adminCount = (await activeAdmins()).length;
    expect(adminCount).toBeGreaterThan(0);

    const res = await service.signupRequest(form());
    expect(res.status).toBe('pending');

    const row = await db
      .selectFrom('signup_requests')
      .selectAll()
      .where('id', '=', res.requestId)
      .executeTakeFirst();
    expect(row?.status).toBe('pending');
    expect(row?.cv_file_key).toBeNull();
    expect(s3Mock.commandCalls(PutObjectCommand).length).toBe(0);

    expect(notifyCalls().length).toBe(adminCount);
  });

  test('valid form with PDF CV → streamed to R2 with the expected key', async () => {
    const res = await service.signupRequest(form(), {
      stream: pdfStream(),
      mimetype: 'application/pdf',
    });

    const puts = s3Mock.commandCalls(PutObjectCommand);
    expect(puts.length).toBe(1);
    const input = puts[0].args[0].input;
    expect(input.Bucket).toBe(R2_BUCKET);
    expect(input.Key).toBe(`cvs/requests/${res.requestId}/cv.pdf`);
    expect(input.ContentType).toBe('application/pdf');

    const row = await db
      .selectFrom('signup_requests')
      .select('cv_file_key')
      .where('id', '=', res.requestId)
      .executeTakeFirst();
    expect(row?.cv_file_key).toBe(`cvs/requests/${res.requestId}/cv.pdf`);
  });

  test('invalid MIME (text/plain) → 422, nothing uploaded', async () => {
    await expect(
      service.signupRequest(form(), {
        stream: Readable.from(Buffer.from('not a pdf')),
        mimetype: 'text/plain',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE', statusCode: 422 });
    expect(s3Mock.commandCalls(PutObjectCommand).length).toBe(0);
  });

  test('defense in depth: roleRequested=admin → 422 INVALID_ROLE', async () => {
    await expect(
      service.signupRequest(form({ roleRequested: 'admin' })),
    ).rejects.toMatchObject({ code: 'INVALID_ROLE', statusCode: 422 });
  });

  test('H-04 #1: existing active staff with same email → ALREADY_PROCESSED', async () => {
    const e = email('dupe-active');
    await db
      .insertInto('staff')
      .values({
        name: 'Existing',
        email: e,
        role: 'team_member',
        active: true,
        mfa_enrolled: false,
        supabase_uid: null,
      })
      .execute();

    await expect(service.signupRequest(form({ email: e }))).rejects.toMatchObject({
      code: 'ALREADY_PROCESSED',
      statusCode: 409,
    });
  });

  test('H-04 #2: soft-deleted staff with same email → ALREADY_PROCESSED', async () => {
    const e = email('dupe-softdel');
    await db
      .insertInto('staff')
      .values({
        name: 'Gone',
        email: e,
        role: 'team_member',
        active: true,
        mfa_enrolled: false,
        supabase_uid: null,
        deleted_at: sql`NOW()`,
      })
      .execute();

    await expect(service.signupRequest(form({ email: e }))).rejects.toMatchObject({
      code: 'ALREADY_PROCESSED',
      statusCode: 409,
    });
  });

  test('H-04 #3: existing pending request (unique index 23505) → ALREADY_PROCESSED', async () => {
    const e = email('dupe-pending');
    await db
      .insertInto('signup_requests')
      .values({
        name: 'First',
        email: e,
        date_of_birth: '1990-01-01',
        mobile_number: '+11234500000',
        role_requested: 'team_member',
        status: 'pending',
      })
      .execute();

    await expect(service.signupRequest(form({ email: e }))).rejects.toMatchObject({
      code: 'ALREADY_PROCESSED',
      statusCode: 409,
    });
  });

  test('notifications fan out one-per-admin (extra admins are each notified)', async () => {
    const before = (await activeAdmins()).length;
    await db
      .insertInto('staff')
      .values([
        { name: 'Extra Admin 1', email: email('admin1'), role: 'admin', active: true, mfa_enrolled: false, supabase_uid: null },
        { name: 'Extra Admin 2', email: email('admin2'), role: 'admin', active: true, mfa_enrolled: false, supabase_uid: null },
      ])
      .execute();

    await service.signupRequest(form());
    expect(notifyCalls().length).toBe(before + 2);
  });
});

describe('signup CV upload — multipart 5MB limit (mirrors app.ts config)', () => {
  test('a file larger than 5MB surfaces HTTP 413', async () => {
    const app = Fastify();
    await app.register(import('@fastify/multipart'), {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    });
    // Mirror the real route: consume the file stream; let the limit error bubble.
    app.post('/upload', async (request, reply) => {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          try {
            for await (const _chunk of part.file) {
              /* drain */
            }
          } finally {
            part.file.resume();
          }
        }
      }
      return reply.status(201).send({ ok: true });
    });

    const boundary = '----skalytest';
    const big = Buffer.alloc(6 * 1024 * 1024, 0x41); // 6MB > 5MB cap
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="cv"; filename="big.pdf"\r\n` +
        `Content-Type: application/pdf\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([head, big, tail]);

    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(413);
    await app.close();
  });
});
