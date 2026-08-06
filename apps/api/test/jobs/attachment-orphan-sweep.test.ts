import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

import type * as R2Module from '../../src/lib/r2.js';
import type { DB } from '@skaly/shared';

/**
 * ADR-033 — the attachment orphan sweep, tested against its FAILURE MODES.
 *
 * The happy path (an abandoned upload gets reaped) is the least interesting
 * thing this job does. What matters is everything it must NOT delete: a backup,
 * a CV, a report, an upload still in flight, a file someone is using. Those are
 * the cases here.
 *
 * R2 is stubbed with an in-memory bucket. The point is which keys the job
 * decides to delete, and that decision is pure — a real bucket would add
 * network flake to a test about a filter.
 */
const bucket = new Map<string, Date>();
const deleted: string[] = [];
const listedPrefixes: string[] = [];

/**
 * Deliberately IGNORES the prefix and returns the whole bucket.
 *
 * This is the harsher fake: it simulates the prefix filter failing at the layer
 * below, so the sweep's own defence-in-depth check is what has to keep the
 * backups alive. A fake that filtered correctly would prove only that S3
 * filters correctly.
 */
vi.mock('../../src/lib/r2.js', async (importOriginal) => {
  const actual = await importOriginal<typeof R2Module>();
  return {
    ...actual,
    listR2Objects: vi.fn((prefix: string) => {
      listedPrefixes.push(prefix);
      return Promise.resolve({
        objects: [...bucket].map(([key, lastModified]) => ({ key, lastModified })),
        nextToken: undefined,
      });
    }),
    deleteR2Objects: vi.fn((keys: string[]) => {
      deleted.push(...keys);
      for (const k of keys) bucket.delete(k);
      return Promise.resolve();
    }),
  };
});

const { attachmentOrphanSweep, ORPHAN_MIN_AGE_MS } = await import(
  '../../src/jobs/attachment-orphan-sweep.js'
);
const { ATTACHMENTS_PREFIX } = await import('../../src/lib/r2.js');

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const STAFF = 'e9000000-0000-4000-8000-0000000000a1';
const TASK = 'e9000000-0000-4000-8000-0000000000f1';
const PERIOD = '2091-09';
const DOMAIN = '@sweep.itest';

const NOW = new Date('2091-09-15T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const OLD = ago(ORPHAN_MIN_AGE_MS + 60_000);
const YOUNG = ago(ORPHAN_MIN_AGE_MS - 60_000);

/** A live attachment: an R2 key WITH a task_attachments row. */
const KEPT_KEY = `${ATTACHMENTS_PREFIX}${TASK}/live-file.pdf`;
const ORPHAN_KEY = `${ATTACHMENTS_PREFIX}${TASK}/abandoned.pdf`;
const YOUNG_ORPHAN_KEY = `${ATTACHMENTS_PREFIX}${TASK}/still-uploading.pdf`;
const BACKUP_KEY = 'backup/2091-09-15/skaly_dev.sql.gz';
const CV_KEY = 'cvs/someone-resume.pdf';
const REPORT_KEY = 'reports/2091-09/attendance.pdf';

const sweep = () => attachmentOrphanSweep(db, { now: NOW });

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values({ id: STAFF, name: 'Sweep Staff', email: `s${DOMAIN}`, role: 'admin', active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();
  await db
    .insertInto('tasks')
    .values({ id: TASK, period: PERIOD, date: `${PERIOD}-05`, description: 'sweep task', created_by: STAFF })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
});

beforeEach(async () => {
  bucket.clear();
  deleted.length = 0;
  listedPrefixes.length = 0;

  await db.deleteFrom('task_attachments').where('task_id', '=', TASK).execute();
  await db
    .insertInto('task_attachments')
    .values({
      task_id: TASK,
      file_name: 'live-file.pdf',
      file_key: KEPT_KEY,
      file_size: 1024,
      mime_type: 'application/pdf',
      uploaded_by: STAFF,
    })
    .execute();

  bucket.set(KEPT_KEY, OLD);
  bucket.set(ORPHAN_KEY, OLD);
  bucket.set(YOUNG_ORPHAN_KEY, YOUNG);
  bucket.set(BACKUP_KEY, OLD);
  bucket.set(CV_KEY, OLD);
  bucket.set(REPORT_KEY, OLD);
});

afterAll(async () => {
  await db.deleteFrom('task_attachments').where('task_id', '=', TASK).execute();
  await db.deleteFrom('tasks').where('id', '=', TASK).execute();
  await db.destroy();
});

describe('what it deletes', () => {
  test('an orphan older than an hour under the attachments prefix is deleted', async () => {
    const summary = await sweep();

    expect(deleted).toContain(ORPHAN_KEY);
    expect(summary).toMatchObject({ orphaned: 1, deleted: 1 });
  });

  test('every deletion is audited to the System Actor with the key and a reason', async () => {
    await sweep();

    const row = await db
      .selectFrom('audit_log')
      .select(['staff_id', 'action', 'table_name', 'old_value', 'changed_by_source'])
      .where('table_name', '=', 'task_attachments')
      .where('action', '=', 'DELETE')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();

    expect(row.staff_id).toBe('00000000-0000-0000-0000-000000000000');
    expect(row.changed_by_source).toBe('system');
    expect(row.old_value).toMatchObject({ file_key: ORPHAN_KEY, reason: 'orphan' });
  });
});

describe('what it must never touch', () => {
  test('⭐ a backup-prefix key with no attachments row is NEVER deleted', async () => {
    await sweep();

    // The fake returns the whole bucket regardless of prefix, so this passing
    // means the SWEEP excluded it — not that the fake did.
    expect(deleted).not.toContain(BACKUP_KEY);
    expect(bucket.has(BACKUP_KEY)).toBe(true);
  });

  test('⭐ CV and report keys are equally untouched', async () => {
    await sweep();

    expect(deleted).not.toContain(CV_KEY);
    expect(deleted).not.toContain(REPORT_KEY);
  });

  test('it only ever lists under the attachments prefix', async () => {
    await sweep();
    expect(listedPrefixes).toEqual([ATTACHMENTS_PREFIX]);
  });

  test('an orphan YOUNGER than an hour is skipped — it may still be uploading', async () => {
    const summary = await sweep();

    expect(deleted).not.toContain(YOUNG_ORPHAN_KEY);
    expect(summary.skippedTooRecent).toBeGreaterThan(0);
  });

  test('a key WITH a task_attachments row is never touched, however old', async () => {
    bucket.set(KEPT_KEY, new Date('2001-01-01T00:00:00Z'));
    await sweep();

    expect(deleted).not.toContain(KEPT_KEY);
  });

  test('an object with no LastModified is treated as young, not as ancient', async () => {
    // Unknown age must fail towards keeping the file: age is the only protection
    // a mid-upload object has.
    bucket.clear();
    bucket.set(`${ATTACHMENTS_PREFIX}${TASK}/no-date.pdf`, null as unknown as Date);

    const summary = await sweep();
    expect(summary.deleted).toBe(0);
  });
});

describe('the prefix assertion (ADR-033 §2)', () => {
  test('⭐ an empty prefix throws BEFORE anything is listed or deleted', async () => {
    await expect(attachmentOrphanSweep(db, { prefix: '', now: NOW })).rejects.toThrow(/prefix/i);

    expect(listedPrefixes).toEqual([]);
    expect(deleted).toEqual([]);
  });

  test('⭐ a wider prefix throws — it does not "helpfully" sweep more', async () => {
    for (const bad of ['', '/', 'attachments', 'attachments-backup/', 'backup/']) {
      await expect(attachmentOrphanSweep(db, { prefix: bad, now: NOW }), bad).rejects.toThrow();
    }
    expect(deleted).toEqual([]);
  });
});

describe('idempotency', () => {
  test('two runs back to back delete the same object exactly once', async () => {
    const first = await sweep();
    const second = await sweep();

    expect(first.deleted).toBe(1);
    expect(second.deleted).toBe(0);
    expect(deleted.filter((k) => k === ORPHAN_KEY)).toHaveLength(1);
  });
});
