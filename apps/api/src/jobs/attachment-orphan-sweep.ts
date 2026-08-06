/**
 * ADR-033 — the attachment orphan sweep.
 *
 * An R2 object whose `task_attachments` row never materialised (presign issued,
 * upload completed, confirm never called) is a genuine orphan wasting bytes.
 * An object that is mid-upload right now looks exactly the same, and so does
 * every CV, report, and nightly database backup — because they all share one
 * bucket (Infra §1).
 *
 * That is what makes this the most dangerous job in the sprint: the unscoped
 * version of "delete every key with no task_attachments row" deletes every
 * backup. The prefix is therefore ASSERTED, not commented (ADR-033 §2), and the
 * assertion runs before the first ListObjectsV2.
 *
 * Shape: list a page → drop anything too young → batch one DB lookup for the
 * rest → delete what has no row → audit each deletion. Idempotent: a second run
 * finds nothing, because the first one deleted it.
 */
import { ATTACHMENTS_PREFIX, deleteR2Objects, listR2Objects } from '../lib/r2.js';
import { AuditService } from '../services/AuditService.js';

import type { JobLogger } from './job-logger.js';
import type { Executor } from '../services/BaseService.js';

/**
 * How old an unreferenced key must be before it counts as abandoned.
 *
 * Four times UPLOAD_EXPIRY_SECONDS (900). The presign window is the real bound —
 * an hour is the margin for a clock skew or a slow confirm, and the cost of
 * waiting is one more hour of one orphan's bytes.
 */
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

export interface SweepSummary {
  scanned: number;
  orphaned: number;
  deleted: number;
  skippedTooRecent: number;
}

/**
 * Fail loudly on anything but the attachments prefix.
 *
 * A refactor that blanks or widens the prefix must stop here, on the first line,
 * rather than proceed into a full-bucket listing. Deliberately an equality check
 * and not `startsWith`: `attachments` without the slash would also match
 * `attachments-backup/`, and "close enough" is not a property this job may have.
 */
function assertAttachmentsPrefix(prefix: string): void {
  if (!prefix || prefix !== ATTACHMENTS_PREFIX) {
    throw new Error(
      `attachment sweep refused: prefix must be exactly "${ATTACHMENTS_PREFIX}", got "${prefix}". ` +
        'The bucket also holds CVs, reports, and backups (ADR-033).',
    );
  }
}

/**
 * Delete abandoned attachment uploads. Returns a summary for the caller to log.
 *
 * `now` is injectable so a test can age an object without waiting an hour.
 */
export async function attachmentOrphanSweep(
  db: Executor,
  opts: { prefix?: string; now?: Date; logger?: JobLogger } = {},
): Promise<SweepSummary> {
  const prefix = opts.prefix ?? ATTACHMENTS_PREFIX;
  assertAttachmentsPrefix(prefix);

  const now = opts.now ?? new Date();
  const audit = new AuditService();
  const summary: SweepSummary = { scanned: 0, orphaned: 0, deleted: 0, skippedTooRecent: 0 };

  let token: string | undefined;
  do {
    const { objects, nextToken } = await listR2Objects(prefix, token);
    token = nextToken;
    summary.scanned += objects.length;

    // Defence in depth: never act on a key the prefix filter did not actually
    // constrain. A List that returned something outside the prefix is a bug in
    // the layer below, and the sweep's job is to not compound it.
    const inScope = objects.filter((o) => o.key.startsWith(prefix));

    const aged = inScope.filter((o) => {
      // No LastModified means we cannot prove the object is old. Age is the only
      // protection a mid-upload object has, so unknown age is treated as young.
      if (!o.lastModified) return false;
      return now.getTime() - o.lastModified.getTime() >= ORPHAN_MIN_AGE_MS;
    });
    summary.skippedTooRecent += inScope.length - aged.length;
    if (aged.length === 0) continue;

    // ONE lookup per page, not one per object.
    const referenced = new Set(
      (
        await db
          .selectFrom('task_attachments')
          .select('file_key')
          .where(
            'file_key',
            'in',
            aged.map((o) => o.key),
          )
          .execute()
      ).map((r) => r.file_key),
    );

    const orphans = aged.filter((o) => !referenced.has(o.key));
    summary.orphaned += orphans.length;
    if (orphans.length === 0) continue;

    await deleteR2Objects(orphans.map((o) => o.key));
    summary.deleted += orphans.length;

    // Audited one row per key: this is an unattended deleter, and the audit trail
    // is the only way anyone ever finds out what it removed. The volume is bounded
    // by how many uploads were abandoned, which is small — unlike the retention
    // job, where per-row auditing would mean 15k rows for one run.
    for (const o of orphans) {
      await audit.log({
        actorId: null, // System Actor + changed_by_source 'system' (C-04)
        action: 'DELETE',
        entity: 'task_attachments',
        entityId: null, // an orphan has no row — that is what makes it an orphan
        before: {
          file_key: o.key,
          reason: 'orphan',
          age_hours: o.lastModified
            ? Math.round((now.getTime() - o.lastModified.getTime()) / 3_600_000)
            : null,
        },
        trx: db,
      });
    }
  } while (token);

  opts.logger?.info({ ...summary, prefix }, 'attachment orphan sweep complete');
  return summary;
}
