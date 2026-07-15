import { ATTACHMENT_MAX_BYTES, TASK_ATTACHMENT_TOTAL_BYTES } from '@skaly/shared';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';

import { type CurrentUser } from '../../src/services/AttendanceService.js';
import { TaskAttachmentService } from '../../src/services/TaskAttachmentService.js';

import type { DB } from '@skaly/shared';

// Stub the R2 lib so no network is touched: presign returns a fake URL, and the
// confirm path's HeadObject/DeleteObject are controllable per-test (ADR-007).
vi.mock('../../src/lib/r2.js', () => ({
  getPresignedUploadUrl: vi.fn(async () => 'https://r2.fake/put'),
  getPresignedDownloadUrl: vi.fn(async () => 'https://r2.fake/get'),
  headObjectSize: vi.fn(),
  deleteR2Object: vi.fn(async () => undefined),
  UPLOAD_EXPIRY_SECONDS: 900,
  DOWNLOAD_EXPIRY_SECONDS: 3600,
}));
// eslint-disable-next-line import/order -- must import AFTER vi.mock to get the mocked fns
import { headObjectSize, deleteR2Object } from '../../src/lib/r2.js';
const mockedHead = vi.mocked(headObjectSize);
const mockedDelete = vi.mocked(deleteR2Object);

// Integration smoke: real local Postgres, R2 stubbed above. Validation/permission
// cases short-circuit before any R2 call; confirm cases drive the stubbed HeadObject.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const svc = new TaskAttachmentService();

// ── Fixtures ────────────────────────────────────────────────────────────────
const PERIOD = '2000-11';
const DATE = '2000-11-10';
const DOMAIN = '@taskattach.itest';

const ADMIN_ID = 'c0000000-0000-4000-8000-00000000c101';
const MEMBER_ID = 'c0000000-0000-4000-8000-00000000c102'; // team_member, NOT an assignee
const TASK_ID = 'c0000000-0000-4000-8000-00000000c1aa';

const admin: CurrentUser = { staffId: ADMIN_ID, role: 'admin' };
const member: CurrentUser = { staffId: MEMBER_ID, role: 'team_member' };

async function cleanupData() {
  await db.deleteFrom('task_attachments').where('task_id', '=', TASK_ID).execute();
  await db.deleteFrom('task_assignees').where('task_id', '=', TASK_ID).execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN_ID, name: 'Attach Admin', email: `admin-${ADMIN_ID}${DOMAIN}`, role: 'admin', active: true },
      { id: MEMBER_ID, name: 'Attach Member', email: `member-${MEMBER_ID}${DOMAIN}`, role: 'team_member', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doUpdateSet({ locked: false }))
    .execute();

  await db.deleteFrom('task_attachments').where('task_id', '=', TASK_ID).execute();
  await db.deleteFrom('tasks').where('id', '=', TASK_ID).execute();
  await db
    .insertInto('tasks')
    .values({ id: TASK_ID, period: PERIOD, date: DATE, description: 'Attach target', created_by: ADMIN_ID })
    .execute();
});

beforeEach(() => {
  mockedHead.mockReset();
  mockedDelete.mockClear();
});

afterEach(cleanupData);

afterAll(async () => {
  await cleanupData();
  await db.deleteFrom('tasks').where('id', '=', TASK_ID).execute();
  await db.destroy();
});

describe('presignAttachment — server-side validation (ADR-007)', () => {
  test('disallowed MIME → 400 INVALID_FILE_TYPE', async () => {
    await expect(
      svc.presignAttachment(
        TASK_ID,
        { fileName: 'malware.exe', mimeType: 'application/x-msdownload', fileSize: 1024 },
        admin,
        db,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE', statusCode: 400 });
  });

  test('fileSize over the 50MB per-file limit → 400 FILE_TOO_LARGE', async () => {
    await expect(
      svc.presignAttachment(
        TASK_ID,
        { fileName: 'huge.mp4', mimeType: 'video/mp4', fileSize: ATTACHMENT_MAX_BYTES + 1 },
        admin,
        db,
      ),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', statusCode: 400 });
  });

  test('existing total + declared over 200MB → 400 TASK_ATTACHMENT_LIMIT_EXCEEDED', async () => {
    await db
      .insertInto('task_attachments')
      .values({
        task_id: TASK_ID,
        file_name: 'existing.mp4',
        file_key: `attachments/${TASK_ID}/existing_existing.mp4`,
        file_size: TASK_ATTACHMENT_TOTAL_BYTES - 1024, // almost full
        mime_type: 'video/mp4',
        uploaded_by: ADMIN_ID,
      })
      .execute();

    await expect(
      svc.presignAttachment(
        TASK_ID,
        { fileName: 'one_more.pdf', mimeType: 'application/pdf', fileSize: 10 * 1024 * 1024 },
        admin,
        db,
      ),
    ).rejects.toMatchObject({ code: 'TASK_ATTACHMENT_LIMIT_EXCEEDED', statusCode: 400 });

    await cleanupData();
  });

  test('team_member who is NOT an assignee → 403 PERMISSION_DENIED', async () => {
    await expect(
      svc.presignAttachment(
        TASK_ID,
        { fileName: 'note.pdf', mimeType: 'application/pdf', fileSize: 1024 },
        member,
        db,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
  });

  test('unknown task → 404 RESOURCE_NOT_FOUND', async () => {
    await expect(
      svc.presignAttachment(
        'c0000000-0000-4000-8000-0000000000ff',
        { fileName: 'note.pdf', mimeType: 'application/pdf', fileSize: 1024 },
        admin,
        db,
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404 });
  });

  test('team_member who IS an assignee → allowed (returns a presigned URL)', async () => {
    await db
      .insertInto('task_assignees')
      .values({ task_id: TASK_ID, staff_id: MEMBER_ID, assigned_by: ADMIN_ID })
      .execute();

    const result = await svc.presignAttachment(
      TASK_ID,
      { fileName: 'note.pdf', mimeType: 'application/pdf', fileSize: 1024 },
      member,
      db,
    );
    expect(result.presignedUrl).toBe('https://r2.fake/put');
    expect(result.fileKey).toMatch(new RegExp(`^attachments/${TASK_ID}/`));
  });
});

describe('confirmAttachment — the ADR-007 two-point size check', () => {
  const fileKey = `attachments/${TASK_ID}/abc_final.mp4`;
  const confirmInput = { fileKey, fileName: 'final.mp4', mimeType: 'video/mp4', fileSize: 1 };

  function confirm(user: CurrentUser = admin) {
    return db.transaction().execute((trx) => svc.confirmAttachment(TASK_ID, confirmInput, user, trx));
  }

  test('actual HeadObject size over 50MB → deletes the orphan and 400, no row written', async () => {
    mockedHead.mockResolvedValue(ATTACHMENT_MAX_BYTES + 1);

    await expect(confirm()).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', statusCode: 400 });

    expect(mockedDelete).toHaveBeenCalledWith(fileKey);
    const rows = await db.selectFrom('task_attachments').select('id').where('task_id', '=', TASK_ID).execute();
    expect(rows).toHaveLength(0);
  });

  test('actual size within limits → row written with the REAL size + audit row', async () => {
    const realSize = 12 * 1024 * 1024;
    mockedHead.mockResolvedValue(realSize);

    const dto = await confirm();
    expect(dto.fileSize).toBe(realSize); // the stored size is HeadObject's, not the declared 1
    expect(mockedDelete).not.toHaveBeenCalled();

    const row = await db
      .selectFrom('task_attachments')
      .select(['id', 'file_size'])
      .where('id', '=', dto.id)
      .executeTakeFirstOrThrow();
    expect(Number(row.file_size)).toBe(realSize);

    const audit = await db
      .selectFrom('audit_log')
      .select('id')
      .where('table_name', '=', 'task_attachments')
      .where('record_id', '=', dto.id)
      .where('action', '=', 'INSERT')
      .executeTakeFirst();
    expect(audit).toBeDefined();
  });
});
