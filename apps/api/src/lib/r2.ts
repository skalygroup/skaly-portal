import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireR2 } from './env.js';

/**
 * Cloudflare R2 is S3-compatible, so we drive it with the AWS S3 v3 client.
 * Built lazily on first use: requireR2() throws if R2 isn't configured, and we
 * don't want that to fire at import time on processes that never touch storage.
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
 * Presigned GET URL for downloading an object. Default TTL 1 hour. Used for the
 * admin-only CV download so the R2 key itself never leaves the backend.
 */
export function getR2DownloadUrl(key: string, expiresInSeconds = 3600): Promise<string> {
  return getSignedUrl(
    getR2Client(),
    new GetObjectCommand({ Bucket: getR2Bucket(), Key: key }),
    { expiresIn: expiresInSeconds },
  );
}
