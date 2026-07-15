/**
 * Task attachment limits (ADR-007, 09-ERROR-HANDLING §2). Shared by the API
 * (the enforceable boundary at presign + confirm) and the web client (convenience
 * pre-checks only). The server is the real gate — a direct API caller can never
 * store a disallowed or oversized file.
 */

/** Per-file ceiling: 50 MB. Over this → FILE_TOO_LARGE. */
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

/** Per-task ceiling across all attachments: 200 MB. Over this → TASK_ATTACHMENT_LIMIT_EXCEEDED. */
export const TASK_ATTACHMENT_TOTAL_BYTES = 200 * 1024 * 1024;

/** Accepted MIME types. Anything else → INVALID_FILE_TYPE. */
export const ATTACHMENT_MIME_ALLOWLIST = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'video/mp4',
  'video/quicktime',
] as const;

export type AttachmentMime = (typeof ATTACHMENT_MIME_ALLOWLIST)[number];
