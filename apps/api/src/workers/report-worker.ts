/**
 * The render thread (ADR-027 §2).
 *
 * `@react-pdf/renderer` renders SYNCHRONOUSLY. On the request event loop a 10–15s
 * render blocks every other request on the instance, including the health check —
 * and INFRA §4 sets healthcheckTimeout to 30s, so a month-end burst is not a slow
 * -report problem, it is a restart loop. This file exists so that work happens on a
 * thread nobody is waiting on.
 *
 * IT UPLOADS TOO, and returns only the key. A rendered PDF is a multi-megabyte
 * Buffer, and crossing the thread boundary structured-clones it — sending the bytes
 * back would hand the main thread the very copy this file exists to avoid.
 *
 * Its own DB connection, its own R2 client: a `pg` Pool cannot be shared across
 * threads. The pool is opened per render and closed in `finally`; two concurrent
 * renders (the cap) means at most two extra connections, which is worth the
 * simplicity of not pooling a pool.
 */
import { parentPort, workerData } from 'node:worker_threads';

import { renderToBuffer } from '@react-pdf/renderer';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { collectReportData } from './report-data.js';
import { ReportDocument } from './report-document.js';

import type { ReportType } from './report-data.js';
import type { DB } from '@skaly/shared';

export interface ReportWorkerInput {
  reportId: string;
  type: ReportType;
  period: string;
  clientId: string | null;
  databaseUrl: string;
  r2: { endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string };
}

/** The whole protocol. Anything else the parent sees is a crash, and the parent
 *  treats a crash as `failed` (ADR-027 §3) rather than waiting forever. */
export type ReportWorkerResult = { ok: true; r2Key: string } | { ok: false; error: string };

async function run(input: ReportWorkerInput): Promise<string> {
  // Identity-parse DATE exactly as lib/db.ts does. A worker that skipped this
  // would print calendar dates one day out east of UTC — the bug the global
  // parser was added to kill, reintroduced by a second connection.
  pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

  const pool = new pg.Pool({ connectionString: input.databaseUrl, max: 2 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

  try {
    const data = await collectReportData(
      { type: input.type, period: input.period, clientId: input.clientId },
      db,
    );

    const buffer = await renderToBuffer(ReportDocument({ data, generatedAt: new Date() }));

    const key = `reports/${input.period}/${input.reportId}.pdf`;
    // Imported lazily so a unit test of this module's data path does not need the
    // S3 client constructed.
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    // The same options lib/r2.ts uses, for the same reasons documented there —
    // forcePathStyle for R2, and WHEN_REQUIRED so the SDK's default CRC32
    // checksum does not break the request. A worker that built its client
    // differently would upload fine right up until it did not.
    const s3 = new S3Client({
      region: 'auto',
      endpoint: input.r2.endpoint,
      credentials: {
        accessKeyId: input.r2.accessKeyId,
        secretAccessKey: input.r2.secretAccessKey,
      },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
    await s3.send(
      new PutObjectCommand({
        Bucket: input.r2.bucket,
        Key: key,
        Body: buffer,
        ContentType: 'application/pdf',
      }),
    );
    return key;
  } finally {
    await db.destroy();
  }
}

// Guarded so the module can be imported by a test without trying to run.
if (parentPort && workerData) {
  run(workerData as ReportWorkerInput)
    .then((r2Key) => parentPort!.postMessage({ ok: true, r2Key } satisfies ReportWorkerResult))
    .catch((err: unknown) => {
      // The message must survive the thread boundary, so it is a string, not an
      // Error — Error instances do not structured-clone their subclass or stack
      // usefully, and a `[object Object]` in error_message helps nobody.
      const error = err instanceof Error ? err.message : String(err);
      parentPort!.postMessage({ ok: false, error } satisfies ReportWorkerResult);
    });
}
