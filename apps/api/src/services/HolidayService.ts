/**
 * HolidayService — create/remove holidays and keep the attendance grid in sync
 * (audit H-01; 05-BACKEND-SCHEMA holidays + §11 grants; AUTH-MATRIX §4).
 *
 *   - create — insert the holiday and flip that date's WORKING rows → holiday.
 *   - remove — audit H-01: soft-deactivate the holiday AND revert its holiday
 *              rows → working, in ONE transaction. Half-applied removal leaves a
 *              phantom gold, non-interactive day; that's the whole finding.
 *
 * INVARIANTS:
 *   - Removal is SOFT (active=false, removed_at, removed_by). The app role has no
 *     DELETE grant on holidays (§11) — never DELETE FROM holidays.
 *   - Holiday logic only ever touches WORKING/HOLIDAY rows; sunday rows are left
 *     alone (a holiday on a Sunday changes nothing — reconciliation #4).
 *   - The socket broadcast fires AFTER the DB writes, fire-and-forget: a socket
 *     failure (or sockets not yet initialised) is logged, never rolled back onto
 *     the DB. (Bell notifications for holidays are Sprint 10 — not here.)
 */
import { sql, type Selectable, type Transaction } from 'kysely';

import { AuditService } from './AuditService.js';
import { assertPeriodNotLocked } from './BaseService.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getIo } from '../sockets/index.js';


import type { CurrentUser } from './AttendanceService.js';
import type { Executor } from './BaseService.js';
import type { DB, Holidays } from '@skaly/shared';

export interface HolidayItem {
  id: string;
  period: string;
  date: string;
  name: string;
}

const NOTIFY_NAMESPACE = '/ws/notify';
const ORG_ROOM = 'org:all';

export interface HolidayCreateInput {
  period: string;
  /** 'YYYY-MM-DD'. */
  date: string;
  name: string;
  currentUser: CurrentUser;
  trx: Transaction<DB>;
}

export class HolidayService {
  private readonly audit = new AuditService();

  /** Active holidays for a period, date-ascending (GET /v1/holidays). */
  async list(period: string, trx: Executor): Promise<HolidayItem[]> {
    return trx
      .selectFrom('holidays')
      .select(['id', 'period', sql<string>`to_char(date, 'YYYY-MM-DD')`.as('date'), 'name'])
      .where('period', '=', period)
      .where('active', '=', true)
      .where('removed_at', 'is', null)
      .orderBy('date')
      .execute();
  }

  /**
   * Add a holiday and flip that date's working rows to holiday. admin/manager.
   */
  async create(input: HolidayCreateInput): Promise<Selectable<Holidays>> {
    const { period, date, name, currentUser, trx } = input;

    await assertPeriodNotLocked(period, trx);

    const holiday = await trx
      .insertInto('holidays')
      .values({ period, date, name, active: true, added_by: currentUser.staffId })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Only working days flip; sunday rows are intentionally left as-is.
    await trx
      .updateTable('attendance_logs')
      .set({ day_type: 'holiday' })
      .where('period', '=', period)
      .where('date', '=', sql<Date>`${date}::date`)
      .where('day_type', '=', 'working')
      .execute();

    await this.audit.log({
      actorId: currentUser.staffId,
      action: 'INSERT',
      entity: 'holidays',
      entityId: holiday.id,
      after: { period, date, name, active: true },
      trx,
    });

    this.broadcast('attendance:holiday_added', { period, date, name });
    return holiday;
  }

  /**
   * Remove a holiday (audit H-01). Soft-deactivate the holiday AND revert its
   * holiday attendance rows to working — atomically. admin/manager.
   */
  async remove(
    holidayId: string,
    currentUser: CurrentUser,
    trx: Transaction<DB>,
  ): Promise<{ removed: true }> {
    // date as a stable 'YYYY-MM-DD' string for the revert filter + the broadcast.
    const holiday = await trx
      .selectFrom('holidays')
      .select(['id', 'period', 'name', sql<string>`to_char(date, 'YYYY-MM-DD')`.as('date')])
      .where('id', '=', holidayId)
      .where('active', '=', true)
      .executeTakeFirst();

    // Not found, or already removed (active=false) — same outcome.
    if (!holiday) {
      throw new AppError('RESOURCE_NOT_FOUND', `Active holiday ${holidayId} does not exist.`);
    }

    await assertPeriodNotLocked(holiday.period, trx);

    // ── The H-01 atomic pair — both on the caller's transaction ──────────────
    // (a) soft-deactivate the holiday (no DELETE grant on holidays).
    await trx
      .updateTable('holidays')
      .set({ active: false, removed_at: sql`now()`, removed_by: currentUser.staffId })
      .where('id', '=', holidayId)
      .execute();

    // (b) revert the flip: holiday → working for that exact date/period.
    await trx
      .updateTable('attendance_logs')
      .set({ day_type: 'working' })
      .where('period', '=', holiday.period)
      .where('date', '=', sql<Date>`${holiday.date}::date`)
      .where('day_type', '=', 'holiday')
      .execute();

    await this.audit.log({
      actorId: currentUser.staffId,
      action: 'UPDATE',
      entity: 'holidays',
      entityId: holiday.id,
      before: { active: true },
      after: { active: false, removed_by: currentUser.staffId },
      trx,
    });

    this.broadcast('attendance:holiday_removed', { period: holiday.period, date: holiday.date });
    return { removed: true };
  }

  /**
   * Broadcast a grid-sync event to every connected client (org:all). Fire-and-
   * forget: a socket failure never rolls back the committed holiday change.
   * Cross-user live refresh + bell notifications are wired in Sprint 10.
   */
  private broadcast(event: 'attendance:holiday_added' | 'attendance:holiday_removed', payload: Record<string, string>): void {
    try {
      getIo().of(NOTIFY_NAMESPACE).to(ORG_ROOM).emit(event, payload);
    } catch (err) {
      logger.warn({ err, event, payload }, 'holiday broadcast emit failed');
    }
  }
}
