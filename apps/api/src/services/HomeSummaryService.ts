/**
 * HomeSummaryService — GET /v1/home-summary, the numbers the home page leads with
 * (UIUX §5 role-specific widgets).
 *
 * ⚠️ WHY THIS EXISTS AT ALL, rather than the home page calling the module
 * endpoints and counting client-side: `GET /v1/attendance` alone is 516KB at
 * representative volume, and tasks is another 57KB. Deriving four numbers from
 * ~600KB would make the landing page the heaviest route in the product — the one
 * every user hits first, every morning, on every login. This returns about 1KB.
 *
 * ⚠️ AND NOT FROM THE MATERIALISED VIEWS, tempting as `dashboard_org_stats`
 * looks: those are refreshed by rollover Tier 2, i.e. once a MONTH (ADR-035). A
 * home page reporting "3 tasks overdue" from a snapshot taken on the 1st is worse
 * than no number, because it looks live. These are live aggregates over indexed
 * columns — `idx_tasks_period_status` and `idx_tasks_assignee` carry them.
 *
 * SCOPING follows the same rule as every other read: what a role may see, not
 * what is convenient. A team member's counts are THEIR OWN; an admin's are the
 * organisation's. The API is the layer that enforces it — the home page renders
 * whatever this returns, and cannot widen it.
 */
import { sql } from 'kysely';

import { currentIstDate, type Executor } from './BaseService.js';

import type { CurrentUser } from './AttendanceService.js';

/** Every field is optional-by-role: a freelancer has no task counts to speak of. */
export interface HomeSummary {
  period: string;
  /** Whose numbers these are — the UI says so out loud rather than implying it. */
  scope: 'own' | 'organisation';
  tasks: {
    todo: number;
    inProgress: number;
    blocked: number;
    done: number;
    /** Past deadline and not Done/Cancelled. The one number worth acting on. */
    overdue: number;
  } | null;
  attendance: {
    presentDays: number;
    workingDays: number;
    /** Null rather than 0 when the month has no working days yet — 0% is a lie. */
    pct: number | null;
  } | null;
  shoots: {
    confirmed: number;
    unset: number;
    /** The next confirmed shoot on or after today, 'YYYY-MM-DD'. */
    nextDate: string | null;
  } | null;
  /** Admin only — the queue nobody else can action (UIUX §5 signup badge). */
  pendingSignups: number | null;
}

const n = (v: unknown): number => Number(v ?? 0);

export class HomeSummaryService {
  async get(period: string, currentUser: CurrentUser, trx: Executor): Promise<HomeSummary> {
    const { role } = currentUser;
    const isManagerial = role === 'admin' || role === 'manager';
    const today = currentIstDate();

    return {
      period,
      scope: isManagerial ? 'organisation' : 'own',
      tasks: role === 'freelancer' ? null : await this.tasks(period, currentUser, today, trx),
      attendance:
        role === 'freelancer' ? null : await this.attendance(period, currentUser, trx),
      shoots: await this.shoots(period, currentUser, today, trx),
      pendingSignups: role === 'admin' ? await this.pendingSignups(trx) : null,
    };
  }

  /**
   * Counts by status, plus overdue.
   *
   * A team member sees only tasks ASSIGNED to them — the same scoping
   * `TaskService` applies, expressed here as an EXISTS against task_assignees so
   * the count cannot drift from the list the Tasks module shows them.
   */
  private async tasks(period: string, user: CurrentUser, today: string, trx: Executor) {
    const isManagerial = user.role === 'admin' || user.role === 'manager';

    let q = trx
      .selectFrom('tasks')
      .select([
        sql<string>`count(*) FILTER (WHERE status = 'To Do')`.as('todo'),
        sql<string>`count(*) FILTER (WHERE status = 'In Progress')`.as('in_progress'),
        sql<string>`count(*) FILTER (WHERE status = 'Blocked')`.as('blocked'),
        sql<string>`count(*) FILTER (WHERE status = 'Done')`.as('done'),
        sql<string>`count(*) FILTER (WHERE deadline < ${today}::date
          AND status NOT IN ('Done','Cancelled'))`.as('overdue'),
      ])
      .where('period', '=', period)
      .where('deleted_at', 'is', null);

    if (!isManagerial) {
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom('task_assignees')
            .select('task_id')
            .whereRef('task_assignees.task_id', '=', 'tasks.id')
            .where('task_assignees.staff_id', '=', user.staffId),
        ),
      );
    }

    const r = await q.executeTakeFirstOrThrow();
    return {
      todo: n(r.todo),
      inProgress: n(r.in_progress),
      blocked: n(r.blocked),
      done: n(r.done),
      overdue: n(r.overdue),
    };
  }

  /**
   * Present days over working days.
   *
   * Counted over `day_type = 'working'` only, so Sundays and holidays never drag
   * the percentage down — a month that is 40% Sundays would otherwise read as
   * poor attendance when nobody was expected in.
   */
  private async attendance(period: string, user: CurrentUser, trx: Executor) {
    const isManagerial = user.role === 'admin' || user.role === 'manager';

    let q = trx
      .selectFrom('attendance_logs')
      .select([
        sql<string>`count(*) FILTER (WHERE day_type = 'working')`.as('working'),
        sql<string>`count(*) FILTER (WHERE day_type = 'working' AND present)`.as('present'),
      ])
      .where('period', '=', period);

    if (!isManagerial) q = q.where('staff_id', '=', user.staffId);

    const r = await q.executeTakeFirstOrThrow();
    const workingDays = n(r.working);
    const presentDays = n(r.present);
    return {
      presentDays,
      workingDays,
      pct: workingDays > 0 ? Math.round((presentDays / workingDays) * 1000) / 10 : null,
    };
  }

  /** A freelancer sees only their own slots — the ADR-011 row-level isolation. */
  private async shoots(period: string, user: CurrentUser, today: string, trx: Executor) {
    let q = trx
      .selectFrom('shoot_schedules')
      .select([
        sql<string>`count(*) FILTER (WHERE slot_status = 'Confirmed')`.as('confirmed'),
        sql<string>`count(*) FILTER (WHERE slot_status = 'Unset')`.as('unset'),
        sql<string | null>`to_char(min(slot_date) FILTER (
          WHERE slot_status = 'Confirmed' AND slot_date >= ${today}::date
        ), 'YYYY-MM-DD')`.as('next_date'),
      ])
      .where('period', '=', period);

    if (user.role === 'freelancer') q = q.where('freelancer_id', '=', user.staffId);

    const r = await q.executeTakeFirstOrThrow();
    return { confirmed: n(r.confirmed), unset: n(r.unset), nextDate: r.next_date ?? null };
  }

  private async pendingSignups(trx: Executor): Promise<number> {
    const r = await trx
      .selectFrom('signup_requests')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();
    return n(r.n);
  }
}
