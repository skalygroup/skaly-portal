/**
 * AttendanceService — the read/write core behind the Staff Attendance grid
 * (04-APPFLOW §4, 07-API-CONTRACT §5, 08-AUTH-MATRIX §7).
 *
 *   - getGrid   — the whole grid in one read (all staff columns × dates).
 *   - update    — ownership-safe, optimistic-locked, audited single-cell write.
 *   - backfillCurrentPeriod — mid-month hire: one row per date from today (IST)
 *                 through end-of-period (finishes the Sprint 1 stub).
 *
 * INVARIANTS:
 *   - optimisticUpdate is the ONLY write path for attendance_logs (versioned).
 *   - Every write: assertPeriodNotLocked BEFORE, AuditService.log AFTER.
 *   - day_type is never set by update() — only generatePeriodRows,
 *     backfillCurrentPeriod, and HolidayService set it.
 */
import { sql, type Selectable, type Transaction } from 'kysely';

import { AuditService } from './AuditService.js';
import {
  assertPeriodNotLocked,
  currentIstDate,
  getCurrentPeriod,
  optimisticUpdate,
  type Executor,
} from './BaseService.js';
import { AppError } from '../lib/errors.js';
import { classifyDay, datesInPeriod } from '../lib/period-days.js';
import { softDeletable } from '../lib/queries.js';


import type { AttendanceLogs, DB } from '@skaly/shared';
import type { Role } from '@skaly/shared/schemas/auth';

/** The acting user, projected from request.user by the route (STEP 6). */
export interface CurrentUser {
  staffId: string;
  role: Role;
}

/** The fields a PATCH may change (day_type is intentionally excluded). */
export interface AttendancePatch {
  present?: boolean;
  work_log?: string | null;
}

/** work_log ceiling (05-BACKEND-SCHEMA attendance_logs; also enforced in Zod). */
export const WORK_LOG_MAX = 2000;

/** One grid cell in the 07-API-CONTRACT §5 shape (camelCase wire fields). */
export interface AttendanceLogDTO {
  id: string;
  period: string;
  staffId: string;
  date: string;
  dayType: string;
  present: boolean;
  workLog: string | null;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface AttendanceGrid {
  attendanceLogs: AttendanceLogDTO[];
  holidays: { id: string; date: string; name: string }[];
  staffList: { id: string; name: string; role: string; avatarUrl: string | null }[];
  editableStaffIds: string[];
}

/** Map a raw attendance_logs row to the §5 wire shape. Exported for the route
 * (PATCH returns the same cell shape). `date` is pre-formatted 'YYYY-MM-DD'. */
export function attendanceLogToDTO(
  row: Omit<Selectable<AttendanceLogs>, 'date'> & { date: string },
): AttendanceLogDTO {
  return {
    id: row.id,
    period: row.period,
    staffId: row.staff_id,
    date: row.date,
    dayType: row.day_type,
    present: row.present,
    workLog: row.work_log,
    version: row.version,
    // timestamptz → ISO string for the wire (matches the other services' DTOs).
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : (row.updated_at ?? null),
    updatedBy: row.updated_by,
  };
}

export class AttendanceService {
  private readonly audit = new AuditService();

  /**
   * The full grid for `period`. admin/manager get every column editable;
   * team_member gets the full grid for display but only their own column in
   * `editableStaffIds` (the backend still enforces ownership on PATCH).
   * freelancer never reaches here — the route 403s first (STEP 6).
   */
  async getGrid(period: string, currentUser: CurrentUser, trx: Executor): Promise<AttendanceGrid> {
    if (currentUser.role === 'freelancer') {
      throw new AppError('PERMISSION_DENIED', 'Freelancers have no attendance access.');
    }

    // date via to_char so it's a stable 'YYYY-MM-DD' string, not a pg Date.
    const logs = await trx
      .selectFrom('attendance_logs')
      .select([
        'id',
        'period',
        'staff_id',
        sql<string>`to_char(date, 'YYYY-MM-DD')`.as('date'),
        'day_type',
        'present',
        'work_log',
        'version',
        'updated_at',
        'updated_by',
      ])
      .where('period', '=', period)
      .execute();

    const holidays = await trx
      .selectFrom('holidays')
      .select(['id', sql<string>`to_char(date, 'YYYY-MM-DD')`.as('date'), 'name'])
      .where('period', '=', period)
      .where('active', '=', true)
      .where('removed_at', 'is', null)
      .orderBy('date')
      .execute();

    // Columns = active, non-deleted staff, alphabetical by name (= column order).
    const staffList = await softDeletable(
      trx.selectFrom('staff').select(['id', 'name', 'role', 'avatar_url']),
    )
      .where('active', '=', true)
      .orderBy('name')
      .execute();

    const editableStaffIds =
      currentUser.role === 'team_member' ? [currentUser.staffId] : staffList.map((s) => s.id);

    return {
      attendanceLogs: logs.map((r) =>
        attendanceLogToDTO(r as Omit<Selectable<AttendanceLogs>, 'date'> & { date: string }),
      ),
      holidays: holidays.map((h) => ({ id: h.id, date: h.date, name: h.name })),
      staffList: staffList.map((s) => ({ id: s.id, name: s.name, role: s.role, avatarUrl: s.avatar_url })),
      editableStaffIds,
    };
  }

  /**
   * Update one attendance cell. Ownership backstop → 423 lock gate → validate →
   * optimistic write → audit. Returns the full updated row (07-API-CONTRACT §1.1).
   * Caller wraps this in a transaction so the write + audit commit atomically.
   */
  async update(
    attendanceId: string,
    patch: AttendancePatch,
    currentUser: CurrentUser,
    expectedVersion: number,
    trx: Executor,
  ): Promise<Selectable<AttendanceLogs>> {
    const row = await trx
      .selectFrom('attendance_logs')
      .select(['staff_id', 'period', 'present', 'work_log'])
      .where('id', '=', attendanceId)
      .executeTakeFirst();

    if (!row) {
      throw new AppError('RESOURCE_NOT_FOUND', `attendance_logs row ${attendanceId} does not exist.`);
    }

    // Column-ownership backstop (AUTH-MATRIX §7): a team_member may edit only
    // their own column. The frontend disabling is UX; this is the boundary.
    if (currentUser.role === 'team_member' && row.staff_id !== currentUser.staffId) {
      throw new AppError('PERMISSION_DENIED', 'You can only update your own attendance.');
    }

    await assertPeriodNotLocked(row.period, trx); // 423 PERIOD_LOCKED

    if (patch.work_log != null && patch.work_log.length > WORK_LOG_MAX) {
      throw new AppError('VALIDATION_ERROR', `work_log exceeds ${WORK_LOG_MAX} characters.`, {
        max: WORK_LOG_MAX,
      });
    }

    // Build the change set — day_type is NEVER touched here.
    const changes: AttendancePatch & { updated_by: string } = { updated_by: currentUser.staffId };
    if (patch.present !== undefined) changes.present = patch.present;
    if (patch.work_log !== undefined) changes.work_log = patch.work_log;

    const updated = await optimisticUpdate(
      'attendance_logs',
      attendanceId,
      expectedVersion,
      changes,
      trx,
    );

    await this.audit.log({
      actorId: currentUser.staffId,
      action: 'UPDATE',
      entity: 'attendance_logs',
      entityId: attendanceId,
      before: { present: row.present, work_log: row.work_log },
      after: { present: updated.present, work_log: updated.work_log },
      trx,
    });

    return updated;
  }

  /**
   * Mid-month hire backfill (finishes the Sprint 1 stub, called by the
   * signup-approval flow). One attendance_logs row per date from today (IST)
   * through end of the current period — working, sunday AND holiday days, so the
   * new column matches the grid the other staff already have. Idempotent via the
   * (period, staff_id, date) unique key. Returns the number of rows created.
   */
  async backfillCurrentPeriod(newStaffId: string, trx: Transaction<DB>): Promise<number> {
    const { period } = await getCurrentPeriod(trx);

    const holidayRows = await trx
      .selectFrom('holidays')
      .select(sql<string>`to_char(date, 'YYYY-MM-DD')`.as('d'))
      .where('period', '=', period)
      .where('active', '=', true)
      .where('removed_at', 'is', null)
      .execute();
    const holidaySet = new Set(holidayRows.map((h) => h.d));

    const today = currentIstDate();
    const dates = datesInPeriod(period).filter((d) => d >= today);
    if (dates.length === 0) return 0;

    const rows = dates.map((date) => ({
      period,
      staff_id: newStaffId,
      date,
      day_type: classifyDay(date, holidaySet),
      present: false,
      version: 1,
    }));

    const inserted = await trx
      .insertInto('attendance_logs')
      .values(rows)
      .onConflict((oc) => oc.columns(['period', 'staff_id', 'date']).doNothing())
      .returning('id')
      .execute();

    return inserted.length;
  }
}
