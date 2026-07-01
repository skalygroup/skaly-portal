import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { requireR2 } from './env.js';

/**
 * Named presign TTLs (11-THIRD-PARTY-INTEGRATIONS §4.3). Use these everywhere —
 * never hardcode raw seconds at a call site.
 */
export const UPLOAD_EXPIRY_SECONDS = 900; // 15 min — safe for a 50MB video on a slow network
export const DOWNLOAD_EXPIRY_SECONDS = 3600; // 1 hour
export const REPORT_EXPIRY_SECONDS = 86400; // 24 hours (Sprint 12 report downloads)

/**
 * Cloudflare R2 is S3-compatible, so we drive it with the AWS S3 v3 client.
 * ONE client for the whole app. Built lazily on first use: requireR2() throws if
 * R2 isn't configured, and we don't want that to fire at import time on
 * processes that never touch storage.
 */
let client: S3Client | null = null;

export function getR2Client(): S3Client {
  if (client) return client;
  const { endpoint, accessKeyId, secretAccessKey } = requireR2();
  client = new S3Client({
    region: 'auto', // R2 ignores region but the SDK requires one
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  return client;
}

export function getR2Bucket(): string {
  return requireR2().bucketName;
}

/**
 * Presigned PUT URL for a direct browser upload. Default TTL 15 min.
 *
 * `contentType` MUST be passed through: R2 signs it into the request, so the
 * browser's PUT must send the SAME Content-Type header or R2 rejects the upload.
 */
export function getPresignedUploadUrl(
  key: string,
  contentType: string,
  ttlSeconds = UPLOAD_EXPIRY_SECONDS,
): Promise<string> {
  return getSignedUrl(
    getR2Client(),
    new PutObjectCommand({ Bucket: getR2Bucket(), Key: key, ContentType: contentType }),
    // content-type must be a SIGNED header, otherwise R2 wouldn't actually
    // enforce the Content-Type the browser sends against the signature.
    { expiresIn: ttlSeconds, signableHeaders: new Set(['content-type']) },
  );
}

/**
 * Presigned GET URL for downloading an object. Default TTL 1 hour. Pass
 * REPORT_EXPIRY_SECONDS for report links (Sprint 12).
 */
export function getPresignedDownloadUrl(
  key: string,
  ttlSeconds = DOWNLOAD_EXPIRY_SECONDS,
): Promise<string> {
  return getSignedUrl(getR2Client(), new GetObjectCommand({ Bucket: getR2Bucket(), Key: key }), {
    expiresIn: ttlSeconds,
  });
}

/**
 * Retained name for the Sprint 1 admin CV-download caller (signup-review).
 * Delegates to getPresignedDownloadUrl — one implementation, no magic number.
 */
export function getR2DownloadUrl(key: string, ttlSeconds = DOWNLOAD_EXPIRY_SECONDS): Promise<string> {
  return getPresignedDownloadUrl(key, ttlSeconds);
}