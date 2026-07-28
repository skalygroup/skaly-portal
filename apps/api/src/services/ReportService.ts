/**
 * ReportService — the dispatch half of ADR-027, and the only producer of
 * `report_ready`.
 *
 * The endpoint returns 202 and this class owns everything after it. The 202 alone
 * is the trap the ADR names: returning early while the render still runs on the
 * request event loop moves WHEN the block happens, not WHETHER. The render leaves
 * the main thread here, in `spawn`.
 *
 * FOUR EXIT PATHS, ONE CONVERGENCE. Success, a thrown error, an `'exit'` with no
 * message, and the hard timeout all end in `settle()` — mark the row, then notify.
 * A worker that dies without messaging must still mark the row `failed`, or a
 * report sits `pending` forever with nothing watching it.
 */
import { Worker } from 'node:worker_threads';

import { AuditService } from './AuditService.js';
import { NotificationService } from './NotificationService.js';
import { db as appDb } from '../lib/db.js';
import { env } from '../lib/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getPresignedDownloadUrl, REPORT_EXPIRY_SECONDS } from '../lib/r2.js';
import { assertReportRequest } from '../workers/report-data.js';

import type { CurrentUser } from './AttendanceService.js';
import type { Executor } from './BaseService.js';
import type { ReportType } from '../workers/report-data.js';
import type { ReportWorkerInput, ReportWorkerResult } from '../workers/report-worker.js';
import type { DB } from '@skaly/shared';
import type { Kysely } from 'kysely';

/**
 * TWO concurrent renders, everything else queued.
 *
 * The Railway instance is small and a PDF render is CPU-bound: one render leaves
 * the box comfortably responsive, two saturate it without the OS having to
 * schedule around us, and five simultaneous month-end requests must not become
 * five threads competing for the same core. Raise it with a measurement, never a
 * hunch — the number is here rather than in env because changing it is a capacity
 * decision, not a deployment knob.
 */
const MAX_CONCURRENT_RENDERS = 2;

/**
 * Past NFR §1.2's p99 ceiling (20s) a render is not slow, it is stuck — and a
 * stuck worker holds one of the two slots forever. 30s gives the p99 case room
 * and still terminates well inside anything a user would wait through.
 */
const RENDER_TIMEOUT_MS = 30_000;

export interface ReportListItem {
  id: string;
  type: string;
  period: string;
  clientId: string | null;
  clientName: string | null;
  status: string;
  errorMessage: string | null;
  requestedAt: string;
  completedAt: string | null;
  requestedBy: string | null;
}

/** R2's lifecycle rule deletes report objects after 30 days (NFR §5.1). */
const REPORT_RETENTION_DAYS = 30;

export class ReportService {
  private readonly notifications = new NotificationService();
  private readonly audit = new AuditService();

  private running = 0;
  private readonly queue: Array<() => void> = [];

  /**
   * Overridable so tests can drive the lifecycle — success, throw, silent exit,
   * timeout — without a real 10-second PDF render. The production default is the
   * only thing that ever spawns a thread.
   */
  spawn: (input: ReportWorkerInput) => Worker = defaultSpawn;

  /** Instance field so a test can drive the timeout path without waiting 30s.
   *  Nothing in production changes it. */
  timeoutMs = RENDER_TIMEOUT_MS;

  /**
   * POST /v1/reports/generate. Validates, persists `pending`, dispatches, returns.
   *
   * Validation happens BEFORE the row exists: a bad period should be a 404 the
   * user sees immediately, not a `failed` row they have to go and read.
   */
  async generate(
    input: { type: ReportType; period: string; clientId?: string | null },
    currentUser: CurrentUser,
    db: Kysely<DB>,
  ): Promise<{ reportId: string; status: 'pending' }> {
    if (currentUser.role !== 'admin' && currentUser.role !== 'manager') {
      throw new AppError('PERMISSION_DENIED', 'Only admins and managers can generate reports.');
    }
    await assertReportRequest({ ...input, clientId: input.clientId ?? null }, db);

    const row = await db
      .insertInto('reports')
      .values({
        type: input.type,
        period: input.period,
        client_id: input.clientId ?? null,
        status: 'pending',
        file_key: null,
        generated_by: currentUser.staffId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await this.audit.log({
      actorId: currentUser.staffId,
      entity: 'reports',
      entityId: row.id,
      action: 'INSERT',
      after: { type: input.type, period: input.period, status: 'pending' },
      trx: db,
    });

    // Deliberately NOT awaited. The whole point is that the caller gets its 202
    // now; the queue decides when this actually starts.
    void this.enqueue({
      reportId: row.id,
      type: input.type,
      period: input.period,
      clientId: input.clientId ?? null,
      requestedBy: currentUser.staffId,
    });

    return { reportId: row.id, status: 'pending' };
  }

  /** Waits for a slot, then runs. The queue is what stops five month-end requests
   *  becoming five CPU-bound threads. */
  private async enqueue(job: {
    reportId: string;
    type: ReportType;
    period: string;
    clientId: string | null;
    requestedBy: string;
  }): Promise<void> {
    if (this.running >= MAX_CONCURRENT_RENDERS) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running += 1;
    try {
      await this.render(job);
    } finally {
      this.running -= 1;
      this.queue.shift()?.();
    }
  }

  private async render(job: {
    reportId: string;
    type: ReportType;
    period: string;
    clientId: string | null;
    requestedBy: string;
  }): Promise<void> {
    const result = await this.runWorker(job);
    await this.settle(job, result);
  }

  /**
   * The lifecycle. Every path resolves exactly once — `settled` is the guard, and
   * it matters: a worker can emit `'error'` AND then `'exit'`, and without it the
   * second one would settle a promise that already answered.
   */
  private runWorker(job: {
    reportId: string;
    type: ReportType;
    period: string;
    clientId: string | null;
  }): Promise<ReportWorkerResult> {
    return new Promise<ReportWorkerResult>((resolve) => {
      let settled = false;
      const done = (r: ReportWorkerResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        resolve(r);
      };

      const worker = this.spawn({
        reportId: job.reportId,
        type: job.type,
        period: job.period,
        clientId: job.clientId,
        databaseUrl: env.DATABASE_URL,
        r2: {
          endpoint: env.R2_ENDPOINT ?? '',
          accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
          secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
          bucket: env.R2_BUCKET_NAME ?? '',
        },
      });

      const timer = setTimeout(
        () => done({ ok: false, error: `Render exceeded ${this.timeoutMs / 1000}s and was cancelled.` }),
        this.timeoutMs,
      );

      worker.on('message', (m: ReportWorkerResult) => done(m));
      worker.on('error', (err: Error) => done({ ok: false, error: err.message }));
      // The path that a message-only handler misses entirely: a worker killed by
      // an OOM or a native crash never posts anything. Without this the row stays
      // `pending` forever and the user waits for a notification that cannot come.
      worker.on('exit', (code) =>
        done({ ok: false, error: `Render worker exited with code ${code} before reporting.` }),
      );
    });
  }

  /** Mark the row, then notify. Both outcomes, one place. */
  private async settle(
    job: { reportId: string; period: string; requestedBy: string },
    result: ReportWorkerResult,
  ): Promise<void> {
    try {
      if (result.ok) {
        await appDb
          .updateTable('reports')
          .set({ status: 'ready', file_key: result.r2Key, completed_at: new Date() })
          .where('id', '=', job.reportId)
          .execute();
      } else {
        logger.error({ reportId: job.reportId, error: result.error }, 'report render failed');
        await appDb
          .updateTable('reports')
          .set({ status: 'failed', error_message: result.error, completed_at: new Date() })
          .where('id', '=', job.reportId)
          .execute();
      }

      // Audit M-08: the payload carries the reportId, NEVER a presigned URL. The
      // link lives 24h and the notification row lives forever, so a baked-in URL
      // is a bell that stops working overnight while still looking clickable.
      // The registry's linkBuilder turns this into /settings/reports?reportId=…
      await this.notifications.create({
        recipientId: job.requestedBy,
        type: 'report_ready',
        title: result.ok ? 'Your report is ready' : 'Your report could not be generated',
        body: result.ok ? undefined : result.error,
        // `recordId` goes in the payload too, not just the argument: the dedup
        // guard matches on `payload->>'recordId'` (NotificationService §isDuplicate),
        // so passing it only as an argument leaves the guard inert. Belt and
        // braces over runWorker's settle-once — that one protects a single
        // dispatch, this one protects a retry.
        data: {
          reportId: job.reportId,
          recordId: job.reportId,
          period: job.period,
          status: result.ok ? 'ready' : 'failed',
        },
        recordId: job.reportId,
        trx: appDb,
      });
    } catch (err) {
      // Never rethrow: this runs detached from any request, so an unhandled
      // rejection here would take the process down over one report.
      logger.error({ err, reportId: job.reportId }, 'report settle failed');
    }
  }

  /**
   * GET /v1/reports/:id — status, plus a FRESHLY presigned link when ready.
   *
   * The link is regenerated from `file_key` on every read and never stored, so a
   * user returning within the 24h window gets a working URL without triggering a
   * re-render. A stored URL is a URL that expires in the database.
   */
  async get(
    id: string,
    currentUser: CurrentUser,
    db: Executor,
  ): Promise<ReportListItem & { downloadUrl: string | null }> {
    const row = await this.rows(db).where('reports.id', '=', id).executeTakeFirst();
    if (!row) throw new AppError('RESOURCE_NOT_FOUND', `reports row ${id} does not exist.`);
    this.assertMayRead(currentUser, row.generated_by);

    const item = toListItem(row);
    if (row.status !== 'ready' || !row.file_key) return { ...item, downloadUrl: null };

    // R2's lifecycle rule deletes the object after 30 days, so presigning a key
    // past that returns a URL that 404s. Answer the documented 410 instead of
    // handing over a link that fails on click. Derived from completed_at rather
    // than a HeadObject — the lifecycle rule is deterministic and a network round
    // trip per poll is not.
    const ageDays = (Date.now() - (row.completed_at?.getTime() ?? 0)) / 86_400_000;
    if (ageDays > REPORT_RETENTION_DAYS) {
      throw new AppError(
        'RESOURCE_NOT_FOUND',
        'This report is older than 30 days and its file has been removed. Generate it again.',
      );
    }

    return {
      ...item,
      downloadUrl: await getPresignedDownloadUrl(row.file_key, REPORT_EXPIRY_SECONDS),
    };
  }

  /** GET /v1/reports — the panel's recent list. */
  async list(
    opts: { period?: string; limit?: number },
    currentUser: CurrentUser,
    db: Executor,
  ): Promise<ReportListItem[]> {
    if (currentUser.role !== 'admin' && currentUser.role !== 'manager') {
      throw new AppError('PERMISSION_DENIED', 'Only admins and managers can view reports.');
    }
    let q = this.rows(db).orderBy('reports.generated_at', 'desc');
    if (opts.period) q = q.where('reports.period', '=', opts.period);
    // A manager sees their own requests; an admin sees everyone's.
    if (currentUser.role !== 'admin') q = q.where('reports.generated_by', '=', currentUser.staffId);
    return (await q.limit(Math.min(Math.max(opts.limit ?? 20, 1), 100)).execute()).map(toListItem);
  }

  private assertMayRead(currentUser: CurrentUser, ownerId: string): void {
    if (currentUser.role === 'admin') return;
    if (currentUser.role === 'manager' && ownerId === currentUser.staffId) return;
    throw new AppError('PERMISSION_DENIED', 'You cannot view this report.');
  }

  private rows(db: Executor) {
    return db
      .selectFrom('reports')
      .leftJoin('clients', 'clients.id', 'reports.client_id')
      .leftJoin('staff', 'staff.id', 'reports.generated_by')
      .select([
        'reports.id',
        'reports.type',
        'reports.period',
        'reports.client_id',
        'reports.status',
        'reports.file_key',
        'reports.error_message',
        'reports.generated_at',
        'reports.completed_at',
        'reports.generated_by',
        'clients.name as clientName',
        'staff.name as requestedByName',
      ]);
  }
}

interface ReportRow {
  id: string;
  type: string;
  period: string;
  client_id: string | null;
  status: string;
  file_key: string | null;
  error_message: string | null;
  generated_at: Date;
  completed_at: Date | null;
  generated_by: string;
  clientName: string | null;
  requestedByName: string | null;
}

function toListItem(r: ReportRow): ReportListItem {
  return {
    id: r.id,
    type: r.type,
    period: r.period,
    clientId: r.client_id,
    clientName: r.clientName,
    status: r.status,
    errorMessage: r.error_message,
    requestedAt: r.generated_at.toISOString(),
    completedAt: r.completed_at?.toISOString() ?? null,
    requestedBy: r.requestedByName,
  };
}

/**
 * The worker's path, resolved with the SAME extension as this module.
 *
 * Under `tsx` (dev) and vitest this module is `.ts`, so the worker is
 * `report-worker.ts`; in production it is `dist/services/…js` and the worker is
 * `report-worker.js`. Hard-coding either one works in exactly one of the three
 * environments, which is the classic way this ships broken.
 */
function defaultSpawn(input: ReportWorkerInput): Worker {
  const here = import.meta.url;
  const ext = here.endsWith('.ts') ? '.ts' : '.js';
  const workerUrl = new URL(`../workers/report-worker${ext}`, here);

  if (ext === '.js') return new Worker(workerUrl, { workerData: input });

  // A TypeScript worker needs a loader registered IN ITS OWN THREAD: hooks are
  // per-thread, `execArgv` does not accept `--import`, and NODE_OPTIONS is not
  // re-parsed by workers. So the thread starts on a bootstrap that registers tsx
  // and then imports the real module. Dev and test only — production never takes
  // this branch.
  const bootstrap = `
    const { register } = await import('tsx/esm/api');
    register();
    await import(${JSON.stringify(workerUrl.href)});
  `;
  return new Worker(bootstrap, { eval: true, workerData: input });
}
