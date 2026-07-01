import { describe, test, expect } from 'vitest';

import {
  getPresignedUploadUrl,
  getPresignedDownloadUrl,
  getR2Bucket,
  UPLOAD_EXPIRY_SECONDS,
  DOWNLOAD_EXPIRY_SECONDS,
} from '../../src/lib/r2.js';

// Presigning is local crypto — these assert URL SHAPE and never hit R2.

describe('R2 presign', () => {
  test('getPresignedUploadUrl signs the bucket, key, content-type and a 900s TTL', async () => {
    const key = 'tasks/abc-123/attachment.pdf';
    const url = await getPresignedUploadUrl(key, 'application/pdf');

    expect(url).toContain(getR2Bucket());
    expect(decodeURIComponent(url)).toContain(key);
    expect(url).toContain(`X-Amz-Expires=${UPLOAD_EXPIRY_SECONDS}`); // 900
    // ContentType passthrough → content-type is a signed header.
    expect(decodeURIComponent(url).toLowerCase()).toContain('content-type');
  });

  test('getPresignedDownloadUrl signs the bucket, key and a 3600s TTL', async () => {
    const key = 'reports/2026-07/summary.pdf';
    const url = await getPresignedDownloadUrl(key);

    expect(url).toContain(getR2Bucket());
    expect(decodeURIComponent(url)).toContain(key);
    expect(url).toContain(`X-Amz-Expires=${DOWNLOAD_EXPIRY_SECONDS}`); // 3600
  });

  test('the TTL constants match the spec (11-THIRD-PARTY-INTEGRATIONS §4.3)', () => {
    expect(UPLOAD_EXPIRY_SECONDS).toBe(900);
    expect(DOWNLOAD_EXPIRY_SECONDS).toBe(3600);
  });
});