/**
 * MonthService — read side (07-API-CONTRACT §months). months has no soft-delete
 * and no is_current column; "current" is computed by BaseService.getCurrentPeriod.
 */
import { getCurrentPeriod } from './BaseService.js';

import type { Executor } from './BaseService.js';
import type { Months } from '@skaly/shared';
import type { Selectable } from 'kysely';

export interface MonthItem {
  period: string;
  label: string;
  locked: boolean;
  lockedAt: string | null;
  lockedBy: string | null;
  unlockedAt: string | null;
  unlockedBy: string | null;
  unlockReason: string | null;
  createdAt: string;
}

function toMonthItem(r: Selectable<Months>): MonthItem {
  return {
    period: r.period,
    label: r.label,
    locked: r.locked,
    lockedAt: r.locked_at ? r.locked_at.toISOString() : null,
    lockedBy: r.locked_by,
    unlockedAt: r.unlocked_at ? r.unlocked_at.toISOString() : null,
    unlockedBy: r.unlocked_by,
    unlockReason: r.unlock_reason,
    createdAt: r.created_at.toISOString(),
  };
}

export class MonthService {
  /** All months, newest period first. */
  async list(trx: Executor): Promise<MonthItem[]> {
    const rows = await trx.selectFrom('months').selectAll().orderBy('period', 'desc').execute();
    return rows.map(toMonthItem);
  }

  /** The current IST month row (latest-period fallback); throws PERIOD_NOT_FOUND if empty. */
  async current(trx: Executor): Promise<MonthItem> {
    return toMonthItem(await getCurrentPeriod(trx));
  }
}