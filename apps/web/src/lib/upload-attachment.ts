import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MIME_ALLOWLIST, TASK_ATTACHMENT_TOTAL_BYTES } from '@skaly/shared';

import type { TaskAttachment } from '@/components/modules/tasks/types';

import { api } from '@/lib/api';


/**
 * The ADR-007 three-step upload, kept out of the component so it's unit-testable
 * (Step 7): presign → direct browser PUT to R2 → confirm.
 *
 * The PUT uses XMLHttpRequest, not fetch, because only XHR exposes
 * upload.onprogress for the progress bar. Its Content-Type MUST equal the MIME
 * signed at presign, or R2 rejects the signature.
 */
function putToR2(url: string, file: File, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(file);
  });
}

export async function uploadTaskAttachment(
  taskId: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<TaskAttachment> {
  const meta = { fileName: file.name, mimeType: file.type, fileSize: file.size };

  const { data: presign } = await api<{ data: { presignedUrl: string; fileKey: string } }>(
    `/v1/tasks/${taskId}/attachments/presign`,
    { method: 'POST', body: JSON.stringify(meta) },
  );

  await putToR2(presign.presignedUrl, file, onProgress);

  const { data: attachment } = await api<{ data: TaskAttachment }>(
    `/v1/tasks/${taskId}/attachments/confirm`,
    { method: 'POST', body: JSON.stringify({ fileKey: presign.fileKey, ...meta }) },
  );
  return attachment;
}

/** Client-side convenience validation (the server is the real gate, ADR-007). */
export function validateAttachment(file: File, existingTotalBytes: number): string | null {
  if (!(ATTACHMENT_MIME_ALLOWLIST as readonly string[]).includes(file.type)) {
    return 'That file type is not allowed.';
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return 'File exceeds the 50MB per-file limit.';
  }
  if (existingTotalBytes + file.size > TASK_ATTACHMENT_TOTAL_BYTES) {
    return 'This task would exceed the 200MB attachment limit.';
  }
  return null;
}
