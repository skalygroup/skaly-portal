/**
 * TaskAttachmentService — the presign → browser PUT → confirm pipeline, plus
 * download and delete (ADR-007, 07-API-CONTRACT §7, 09-ERROR-HANDLING §2).
 *
 * ── THE ADR-007 RULE ─────────────────────────────────────────────────────────
 * A presigned PUT cannot enforce content-length at R2 — the client controls the
 * actual bytes regardless of the size declared at presign. So the server
 * validates at BOTH ends, never UI-only:
 *   - presign: declared MIME / size / task-total, before issuing a URL.
 *   - confirm: HeadObject the ACTUAL object; on oversize, DeleteObject the orphan
 *     and reject — no DB row is written.
 * A direct API caller can never store a disallowed or oversized file.
 *
 * INVARIANTS:
 *   - Writes (confirm, delete) compose inside the CALLER's transaction; reads
 *     (presign, download) take any Executor.
 *   - The signed ContentType and the client's PUT Content-Type must match exactly
 *     (getPresignedUploadUrl signs `content-type`; the client echoes `mimeType`).
 *   - The service is the security boundary: admin/manager any; team_member only
 *     on tasks they are assigned to (delete additionally requires own-upload).
 */
import { randomUUID } from 'node:crypto';

import {
  ATTACHMENT_MAX_BYTES,
  TASK_ATTACHMENT_TOTAL_BYTES,
  ATTACHMENT_MIME_ALLOWLIST,
} from '@skaly/shared';
import { sql, type Selectable, type Transaction } from 'kysely';

import { AuditService } from './AuditService.js';
import { assertPeriodNotLocked, type Executor } from './BaseService.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
  getPresignedUploadUrl,
  getPresignedDownloadUrl,
  headObjectSize,
  deleteR2Object,
  ATTACHMENTS_PREFIX,
  UPLOAD_EXPIRY_SECONDS,
  DOWNLOAD_EXPIRY_SECONDS,
} from '../lib/r2.js';

import type { CurrentUser } from './AttendanceService.js';
import type { TaskAttachmentDTO } from './TaskService.js';
import type { DB, TaskAttachments } from '@skaly/shared';

export interface PresignInput {
  fileName: string;
  mimeType: string;
  fileSize: number;
}

export interface PresignResult {
  presignedUrl: string;
  fileKey: string;
}

export interface ConfirmInput {
  fileKey: string;
  fileName: string;
  mimeType: string;
  /** Declared size — advisory only; confirm stores the real HeadObject size. */
  fileSize: number;
}

export class TaskAttachmentService {
  private readonly audit = new AuditService();

  /**
   * Validate BEFORE issuing a URL, then presign a PUT (900s TTL).
   *
   * The returned `presignedUrl` is a PUT: the client MUST send
   * `Content-Type: <mimeType>` (the same MIME passed here) on its upload, or R2
   * rejects the signature.
   */
  async presignAttachment(
    taskId: string,
    input: PresignInput,
    currentUser: CurrentUser,
    trx: Executor,
  ): Promise<PresignResult> {
    const task = await this.assertReadAccess(taskId, currentUser, trx);
    await assertPeriodNotLocked(task.period, trx);

    if (!isAllowedMime(input.mimeType)) {
      throw new AppError('INVALID_FILE_TYPE', `File type ${input.mimeType} is not allowed.`, {
        allowed: ATTACHMENT_MIME_ALLOWLIST,
      });
    }
    if (input.fileSize > ATTACHMENT_MAX_BYTES) {
      throw new AppError('FILE_TOO_LARGE', 'File exceeds the 50MB per-file limit.', {
        maxBytes: ATTACHMENT_MAX_BYTES,
      });
    }
    const existing = await this.existingBytes(taskId, trx);
    if (existing + input.fileSize > TASK_ATTACHMENT_TOTAL_BYTES) {
      throw new AppError('TASK_ATTACHMENT_LIMIT_EXCEEDED', 'This task would exceed the 200MB attachment limit.', {
        totalBytes: TASK_ATTACHMENT_TOTAL_BYTES,
        existingBytes: existing,
      });
    }

    // The prefix comes from r2.ts, not a literal: the orphan sweep's scope
    // assertion is only worth anything if the writer and the sweeper agree on
    // one string (ADR-033).
    const fileKey = `${ATTACHMENTS_PREFIX}${taskId}/${randomUUID()}_${sanitizeFileName(input.fileName)}`;
    const presignedUrl = await getPresignedUploadUrl(fileKey, input.mimeType, UPLOAD_EXPIRY_SECONDS);
    return { presignedUrl, fileKey };
  }

  /**
   * Re-validate the ACTUAL uploaded object and persist the row (ADR-007). On any
   * size violation the orphan is deleted from R2 and NO row is written.
   */
  async confirmAttachment(
    taskId: string,
    input: ConfirmInput,
    currentUser: CurrentUser,
    trx: Transaction<DB>,
  ): Promise<TaskAttachmentDTO> {
    const task = await this.assertReadAccess(taskId, currentUser, trx);
    await assertPeriodNotLocked(task.period, trx);

    // A client can only confirm a key it was legitimately presigned under THIS task.
    if (!input.fileKey.startsWith(`${ATTACHMENTS_PREFIX}${taskId}/`)) {
      throw new AppError('VALIDATION_ERROR', 'fileKey does not belong to this task.');
    }

    const realSize = await headObjectSize(input.fileKey);
    if (realSize === null) {
      // HeadObject 404 — the presigned PUT never landed. Note: the code table
      // maps RESOURCE_NOT_FOUND → 404 (the spec's "400" is superseded here, as
      // AppError derives status from the code — same reconciliation as elsewhere).
      throw new AppError('RESOURCE_NOT_FOUND', 'Upload not found — please retry.');
    }

    if (realSize > ATTACHMENT_MAX_BYTES) {
      await deleteR2Object(input.fileKey);
      throw new AppError('FILE_TOO_LARGE', 'File exceeds the 50MB per-file limit.', {
        maxBytes: ATTACHMENT_MAX_BYTES,
        actualBytes: realSize,
      });
    }
    const existing = await this.existingBytes(taskId, trx);
    if (existing + realSize > TASK_ATTACHMENT_TOTAL_BYTES) {
      await deleteR2Object(input.fileKey);
      throw new AppError('TASK_ATTACHMENT_LIMIT_EXCEEDED', 'This task would exceed the 200MB attachment limit.', {
        totalBytes: TASK_ATTACHMENT_TOTAL_BYTES,
        existingBytes: existing,
        actualBytes: realSize,
      });
    }

    const row = await trx
      .insertInto('task_attachments')
      .values({
        task_id: taskId,
        file_name: input.fileName,
        file_key: input.fileKey,
        file_size: realSize,
        mime_type: input.mimeType,
        uploaded_by: currentUser.staffId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.audit.log({
      actorId: currentUser.staffId,
      action: 'INSERT',
      entity: 'task_attachments',
      entityId: row.id,
      after: { task_id: taskId, file_key: input.fileKey, file_size: realSize, mime_type: input.mimeType },
      trx,
    });

    return mapAttachment(row);
  }

  /**
   * Fresh 1-hour presigned GET. Same read permission as the task.
   *
   * The OTHER orphan direction — a row whose object is gone — is handled here,
   * LAZILY, rather than by a cron HEAD-storm over every attachment row
   * (ADR-033 §8). We already know the object's fate at exactly the moment
   * somebody cares, and a presigned URL for a missing key is worse than an
   * error: it hands the browser a link that 403s or 404s with no explanation.
   */
  async getAttachmentDownloadUrl(
    taskId: string,
    attachmentId: string,
    currentUser: CurrentUser,
    trx: Executor,
  ): Promise<{ downloadUrl: string }> {
    await this.assertReadAccess(taskId, currentUser, trx);

    const att = await trx
      .selectFrom('task_attachments')
      .select('file_key')
      .where('id', '=', attachmentId)
      .where('task_id', '=', taskId)
      .executeTakeFirst();
    if (!att) {
      throw new AppError('RESOURCE_NOT_FOUND', `Attachment ${attachmentId} does not exist on this task.`);
    }

    if ((await headObjectSize(att.file_key)) === null) {
      // No `missing_at` column is written: the state is re-derived by this same
      // HEAD next time, and a migration to persist it would be storage for its
      // own sake until something actually renders a "broken attachment" badge.
      logger.warn({ fileKey: att.file_key, attachmentId }, 'attachment row points at a missing R2 object');
      throw new AppError('RESOURCE_NOT_FOUND', 'This file is no longer available in storage.');
    }

    const downloadUrl = await getPresignedDownloadUrl(att.file_key, DOWNLOAD_EXPIRY_SECONDS);
    return { downloadUrl };
  }

  /**
   * Delete the R2 object + the row. admin/manager any; team_member only their own
   * uploaded attachment on a task they are assigned to. If DeleteObject fails we
   * still remove the row and warn — a dangling DB row is worse than an R2 orphan
   * (the orphan is swept by the 24h lifecycle rule).
   */
  async deleteAttachment(
    taskId: string,
    attachmentId: string,
    currentUser: CurrentUser,
    trx: Transaction<DB>,
  ): Promise<{ deleted: true }> {
    const task = await this.loadTask(taskId, trx);

    const att = await trx
      .selectFrom('task_attachments')
      .select(['id', 'file_key', 'uploaded_by'])
      .where('id', '=', attachmentId)
      .where('task_id', '=', taskId)
      .executeTakeFirst();
    if (!att) {
      throw new AppError('RESOURCE_NOT_FOUND', `Attachment ${attachmentId} does not exist on this task.`);
    }

    if (currentUser.role === 'admin' || currentUser.role === 'manager') {
      // full access
    } else if (currentUser.role === 'team_member') {
      const assignee = await this.isAssignee(taskId, currentUser.staffId, trx);
      if (!assignee || att.uploaded_by !== currentUser.staffId) {
        throw new AppError('PERMISSION_DENIED', 'You can only delete your own attachments on your assigned tasks.');
      }
    } else {
      throw new AppError('PERMISSION_DENIED', 'You do not have permission to delete this attachment.');
    }

    await assertPeriodNotLocked(task.period, trx);

    try {
      await deleteR2Object(att.file_key);
    } catch (err) {
      logger.warn({ err, fileKey: att.file_key }, 'R2 DeleteObject failed; removing DB row anyway');
    }

    await trx.deleteFrom('task_attachments').where('id', '=', attachmentId).execute();

    await this.audit.log({
      actorId: currentUser.staffId,
      action: 'DELETE',
      entity: 'task_attachments',
      entityId: attachmentId,
      before: { file_key: att.file_key, uploaded_by: att.uploaded_by },
      trx,
    });

    return { deleted: true };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async loadTask(taskId: string, trx: Executor): Promise<{ id: string; period: string }> {
    const task = await trx
      .selectFrom('tasks')
      .select(['id', 'period'])
      .where('id', '=', taskId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!task) {
      throw new AppError('RESOURCE_NOT_FOUND', `Task ${taskId} does not exist.`);
    }
    return task;
  }

  private async isAssignee(taskId: string, staffId: string, trx: Executor): Promise<boolean> {
    const row = await trx
      .selectFrom('task_assignees')
      .select('staff_id')
      .where('task_id', '=', taskId)
      .where('staff_id', '=', staffId)
      .executeTakeFirst();
    return Boolean(row);
  }

  /** admin/manager any; team_member if assignee; else 403. Returns the task. */
  private async assertReadAccess(
    taskId: string,
    currentUser: CurrentUser,
    trx: Executor,
  ): Promise<{ id: string; period: string }> {
    const task = await this.loadTask(taskId, trx);
    if (currentUser.role === 'admin' || currentUser.role === 'manager') return task;
    if (currentUser.role === 'team_member' && (await this.isAssignee(taskId, currentUser.staffId, trx))) {
      return task;
    }
    throw new AppError('PERMISSION_DENIED', 'You do not have permission to access this task’s attachments.');
  }

  private async existingBytes(taskId: string, trx: Executor): Promise<number> {
    const row = await trx
      .selectFrom('task_attachments')
      .select(sql<string>`coalesce(sum(file_size), 0)`.as('total'))
      .where('task_id', '=', taskId)
      .executeTakeFirst();
    return Number(row?.total ?? 0);
  }
}

// ── Module-private pure helpers ────────────────────────────────────────────────

function isAllowedMime(mime: string): boolean {
  return (ATTACHMENT_MIME_ALLOWLIST as readonly string[]).includes(mime);
}

/**
 * Make a user-supplied file name safe for an R2 key: strip any path, keep only
 * [A-Za-z0-9._-], collapse runs of '_', bound the length. The random UUID prefix
 * guarantees key uniqueness, so this only needs to be safe, not unique.
 */
function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 200);
  return cleaned || 'file';
}

function mapAttachment(row: Selectable<TaskAttachments>): TaskAttachmentDTO {
  return {
    id: row.id,
    fileName: row.file_name,
    fileSize: Number(row.file_size),
    mimeType: row.mime_type,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at instanceof Date ? row.uploaded_at.toISOString() : (row.uploaded_at as string | null),
  };
}
