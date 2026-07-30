/**
 * MonthService — months has no soft-delete and no is_current column; "current"
 * is computed by BaseService.getCurrentPeriod (07-API-CONTRACT §months).
 *
 * Sprint 11 adds the write side. `months.locked` is what every service's
 * `assertPeriodNotLocked` has been reading since Sprint 3 — this is the code that
 * finally sets it, so a bug here presents as "every module is read-only" or, worse,
 * "the closed month is still editable".
 */
import { AuditService } from './AuditService.js';
import { getCurrentPeriod } from './BaseService.js';
import { transactionWithEmits } from '../lib/emit-after-commit.js';
import { AppError } from '../lib/errors.js';
import { broadcastToOrg } from '../sockets/index.js';

import type { CurrentUser } from './AttendanceService.js';
import type { Executor } from './BaseService.js';
import type { DB, Months } from '@skaly/shared';
import type { Selectable, Kysely } from 'kysely';

export interface MonthItem {
  period: string;
  label: string;
  locked: boolean;
  lockedAt: string | null;
  lockedBy: string | null;
  lockedByName: string | null;
  unlockedAt: string | null;
  unlockedBy: string | null;
  unlockedByName: string | null;
  unlockReason: string | null;
  createdAt: string;
}

type MonthRow = Selectable<Months> & { lockedByName?: string | null; unlockedByName?: string | null };

function toMonthItem(r: MonthRow): MonthItem {
  return {
    period: r.period,
    label: r.label,
    locked: r.locked,
    lockedAt: r.locked_at ? r.locked_at.toISOString() : null,
    lockedBy: r.locked_by,
    lockedByName: r.lockedByName ?? null,
    unlockedAt: r.unlocked_at ? r.unlocked_at.toISOString() : null,
    unlockedBy: r.unlocked_by,
    unlockedByName: r.unlockedByName ?? null,
    unlockReason: r.unlock_reason,
    createdAt: r.created_at.toISOString(),
  };
}

export class MonthService {
  private readonly audit = new AuditService();

  /**
   * The months read, with the actor NAMES resolved. "Locked by 3f9a-…" is not an
   * accountability record anyone can read, and the panel is the only place these
   * ids are ever shown — so the join lives here, once, and both the list and the
   * lock/unlock response go through it. A mutation that answered with bare uuids
   * while the list answered with names is the kind of drift nobody notices until
   * the row refreshes and the name appears from nowhere.
   */
  private withActorNames(trx: Executor) {
    return trx
      .selectFrom('months')
      .leftJoin('staff as locker', 'locker.id', 'months.locked_by')
      .leftJoin('staff as unlocker', 'unlocker.id', 'months.unlocked_by')
      .selectAll('months')
      .select(['locker.name as lockedByName', 'unlocker.name as unlockedByName']);
  }

  /** All months, newest period first. */
  async list(trx: Executor): Promise<MonthItem[]> {
    const rows = await this.withActorNames(trx).orderBy('months.period', 'desc').execute();
    return rows.map((r) => toMonthItem(r as MonthRow));
  }

  /** The current IST month row (latest-period fallback); throws PERIOD_NOT_FOUND if empty. */
  async current(trx: Executor): Promise<MonthItem> {
    return toMonthItem(await getCurrentPeriod(trx));
  }

  /**
   * Lock a period (admin only). Every module becomes read-only for it — that is
   * the consequence the confirmation dialog has to name, because it is invisible
   * from this screen and immediate everywhere else.
   *
   * Re-locking an already-locked period is ALREADY_PROCESSED rather than a silent
   * no-op: it would otherwise overwrite locked_at/locked_by, rewriting who closed
   * the month.
   */
  async lock(period: string, currentUser: CurrentUser, db: Kysely<DB>): Promise<MonthItem> {
    return this.setLock(period, true, null, currentUser, db);
  }

  /**
   * Unlock a period (admin only). A REASON IS REQUIRED — reopening a closed month
   * is the one action here that rewrites history, and `months.unlock_reason` exists
   * precisely so the next person can find out why.
   */
  async unlock(
    period: string,
    reason: string | undefined,
    currentUser: CurrentUser,
    db: Kysely<DB>,
  ): Promise<MonthItem> {
    const trimmed = reason?.trim();
    if (!trimmed) {
      throw new AppError('UNLOCK_REASON_REQUIRED', 'Say why this month is being reopened.');
    }
    if (trimmed.length > 500) {
      throw new AppError('VALIDATION_ERROR', 'Keep the unlock reason under 500 characters.');
    }
    return this.setLock(period, false, trimmed, currentUser, db);
  }

  /**
   * The one write. Lock and unlock differ in a boolean and which columns they
   * stamp; splitting them into two transactions would duplicate the role gate, the
   * existence check, the audit and the broadcast four times over.
   */
  private async setLock(
    period: string,
    locked: boolean,
    reason: string | null,
    currentUser: CurrentUser,
    db: Kysely<DB>,
  ): Promise<MonthItem> {
    if (currentUser.role !== 'admin') {
      throw new AppError('PERMISSION_DENIED', 'Only admins can lock or unlock a month.');
    }

    await transactionWithEmits(db, async (trx) => {
      const before = await trx
        .selectFrom('months')
        .selectAll()
        .where('period', '=', period)
        .forUpdate()
        .executeTakeFirst();
      if (!before) {
        throw new AppError('PERIOD_NOT_FOUND', `There is no ${period} month to change.`);
      }
      if (before.locked === locked) {
        throw new AppError(
          'ALREADY_PROCESSED',
          `${before.label} is already ${locked ? 'locked' : 'unlocked'}.`,
        );
      }

      await trx
        .updateTable('months')
        .set(
          locked
            ? { locked: true, locked_at: new Date(), locked_by: currentUser.staffId }
            : {
                locked: false,
                unlocked_at: new Date(),
                unlocked_by: currentUser.staffId,
                unlock_reason: reason,
              },
        )
        .where('period', '=', period)
        .execute();

      // entityId is NULL, not the period: audit_log.record_id is a UUID column and
      // `months` is keyed by CHAR(7). The period goes in the JSONB values, which
      // is where a reader looks anyway.
      await this.audit.log({
        actorId: currentUser.staffId,
        entity: 'months',
        entityId: null,
        action: 'UPDATE',
        before: { period, locked: before.locked },
        after: locked ? { period, locked: true } : { period, locked: false, unlockReason: reason },
        trx,
      });
    });

    // Every open grid for that period must stop offering edits that would now be
    // refused — a locked month the UI still lets you type into is worse than a
    // disabled one, because the failure arrives after the work.
    broadcastToOrg('month:lock_changed', { period, locked, actorStaffId: currentUser.staffId });

    const row = await this.withActorNames(db).where('months.period', '=', period).executeTakeFirstOrThrow();
    return toMonthItem(row as MonthRow);
  }
}
