/**
 * DEV / SPRINT-4 PRE-FLIGHT ONLY — R2 browser-PUT pre-check (SPRINT-4-DETAILED §1.3).
 *
 * Proves the presign -> browser PUT -> R2 pipeline (CORS + Content-Type signing)
 * end-to-end BEFORE the attachment feature is built, so a CORS/signature wall
 * doesn't surface mid-sprint.
 *
 * Why a browser (not this script) does the PUT: CORS only applies to a real
 * cross-origin browser request. A server-side PUT bypasses CORS entirely and
 * would prove nothing about the bucket's CORS policy — the whole point of 1.3.
 *
 * Usage:
 *   pnpm --filter @skaly/api exec tsx scripts/probe-r2-presign.ts
 *       -> prints a presigned PUT url (15-min TTL) + the exact DevTools snippet
 *          to paste in the http://localhost:3000 console.
 *
 *   pnpm --filter @skaly/api exec tsx scripts/probe-r2-presign.ts cleanup
 *       -> deletes the probe object from the bucket after a successful test.
 *
 * Delete this script once Sprint 4 attachments are proven end-to-end.
 */
import { HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

import {
  getPresignedUploadUrl,
  getR2Client,
  getR2Bucket,
  UPLOAD_EXPIRY_SECONDS,
} from '../src/lib/r2.js';

const PROBE_KEY = 'attachments/_probe/test.pdf';
const PROBE_MIME = 'application/pdf';

async function presign(): Promise<void> {
  const url = await getPresignedUploadUrl(PROBE_KEY, PROBE_MIME, UPLOAD_EXPIRY_SECONDS);
  console.log('\n=== R2 browser-PUT pre-check ===');
  console.log(`bucket : ${getR2Bucket()}`);
  console.log(`key    : ${PROBE_KEY}`);
  console.log(`ttl    : ${UPLOAD_EXPIRY_SECONDS}s (mint fresh if it expires)\n`);
  console.log('Presigned PUT url:\n');
  console.log(url);
  console.log('\n--- Paste this in the http://localhost:3000 DevTools console: ---\n');
  console.log(
    [
      `const url = ${JSON.stringify(url)};`,
      `const res = await fetch(url, {`,
      `  method: 'PUT',`,
      `  headers: { 'Content-Type': '${PROBE_MIME}' },`,
      `  body: new Blob(['probe'], { type: '${PROBE_MIME}' }),`,
      `});`,
      `console.log(res.status); // expect 200`,
    ].join('\n'),
  );
  console.log('\nExpected: 200. If 403 SignatureDoesNotMatch -> Content-Type mismatch.');
  console.log('If a CORS error -> fix the bucket CORS policy (see the manual guide), then re-run.');
  console.log("On 200 -> run this script with 'cleanup' to remove the probe object.\n");
}

async function cleanup(): Promise<void> {
  const client = getR2Client();
  const bucket = getR2Bucket();
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: PROBE_KEY }));
  } catch {
    console.log(`No probe object at ${PROBE_KEY} — nothing to clean up.`);
    return;
  }
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: PROBE_KEY }));
  console.log(`Deleted probe object: ${PROBE_KEY}`);
}

const mode = process.argv[2];
await (mode === 'cleanup' ? cleanup() : presign());
