/**
 * The report's data layer (ADR-027). Pure queries — no rendering, no R2, no
 * worker plumbing — so the numbers a report states can be tested without
 * spawning a thread or parsing a PDF.
 *
 * Reads the materialised views where they exist (migration 024), matching
 * UIUX §14's "all data from materialised views, never raw tables" for the stats
 * that already have one. Per-client operational detail has no view, so those
 * come from the module tables directly.
 */
import { AppError } from '../lib/errors.js';

import type { Executor } from '../services/BaseService.js';

export type ReportType = 'client_monthly' | 'org_monthly';

export interface ReportRequest {
  type: ReportType;
  period: string;
  clientId?: string | null;
}

export interface OrgMonthlyData {
  kind: 'org_monthly';
  period: string;
  periodLabel: string;
  attendancePct: number | null;
  activeStaffCount: number;
  activeClientCount: number;
  tasks: { total: number; done: number; pending: number; overdue: number };
  // staffId is carried for identity only — two colleagues share a display name
  // often enough that keying the PDF's rows by name dropped one of them.
  perStaff: Array<{
    staffId: string;
    name: string;
    role: string;
    assigned: number;
    done: number;
    overdue: number;
  }>;
  shoots: { total: number; completed: number; confirmed: number; unset: number };
  posts: number;
}

export interface ClientMonthlyData {
  kind: 'client_monthly';
  period: string;
  periodLabel: string;
  clientName: string;
  shootSlotsPerMonth: number;
  piecesPerVisit: number;
  slots: Array<{ index: number; status: string; date: string | null; freelancer: string | null; pieces: number }>;
  pipeline: {
    visitType: string | null;
    lastShootDate: string | null;
    rawReceivedAt: string | null;
    finalsReadyAt: string | null;
    postedAt: string | null;
    comingShootDate: string | null;
  } | null;
  calendar: Array<{ status: string; count: number }>;
}

export type ReportData = OrgMonthlyData | ClientMonthlyData;

const n = (v: unknown): number => Number(v ?? 0);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : (v as string | null));

/** Validates the request against real rows, so a bad period fails BEFORE a
 *  pending record is created rather than as a mystery `failed` row later. */
export async function assertReportRequest(req: ReportRequest, db: Executor): Promise<string> {
  const month = await db
    .selectFrom('months')
    .select('label')
    .where('period', '=', req.period)
    .executeTakeFirst();
  if (!month) {
    throw new AppError('PERIOD_NOT_FOUND', `There is no ${req.period} month to report on.`);
  }

  if (req.type === 'client_monthly') {
    if (!req.clientId) {
      throw new AppError('VALIDATION_ERROR', 'A client monthly report needs a clientId.');
    }
    const client = await db
      .selectFrom('clients')
      .select('id')
      .where('id', '=', req.clientId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!client) {
      throw new AppError('RESOURCE_NOT_FOUND', `clients row ${req.clientId} does not exist.`);
    }
  }
  return month.label;
}

export async function collectReportData(req: ReportRequest, db: Executor): Promise<ReportData> {
  const periodLabel = await assertReportRequest(req, db);
  return req.type === 'org_monthly'
    ? collectOrgMonthly(req.period, periodLabel, db)
    : collectClientMonthly(req.period, periodLabel, req.clientId!, db);
}

async function collectOrgMonthly(
  period: string,
  periodLabel: string,
  db: Executor,
): Promise<OrgMonthlyData> {
  const org = await db
    .selectFrom('dashboard_org_stats')
    .select(['attendance_pct', 'active_staff_count'])
    .where('period', '=', period)
    .executeTakeFirst();

  const clients = await db
    .selectFrom('clients')
    .select((eb) => eb.fn.countAll().as('c'))
    .where('deleted_at', 'is', null)
    .where('active', '=', true)
    .executeTakeFirstOrThrow();

  const perStaffRows = await db
    .selectFrom('dashboard_staff_task_stats as s')
    .innerJoin('staff', 'staff.id', 's.staff_id')
    .select([
      'staff.id as staff_id',
      'staff.name',
      'staff.role',
      's.total_assigned',
      's.tasks_done',
      's.tasks_overdue',
    ])
    .where('s.period', '=', period)
    .where('staff.deleted_at', 'is', null)
    .orderBy('s.total_assigned', 'desc')
    .orderBy('staff.name', 'asc')
    .execute();

  const taskTotals = await db
    .selectFrom('tasks')
    .select((eb) => [
      eb.fn.countAll().as('total'),
      eb.fn.count(eb.case().when('status', '=', 'Done').then(1).end()).as('done'),
    ])
    .where('period', '=', period)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();

  const shootRows = await db
    .selectFrom('shoot_schedules')
    .select(['slot_status', (eb) => eb.fn.countAll().as('c')])
    .where('period', '=', period)
    .groupBy('slot_status')
    .execute();
  const byStatus = new Map(shootRows.map((r) => [r.slot_status, n(r.c)]));

  const posts = await db
    .selectFrom('content_calendar')
    .select((eb) => eb.fn.countAll().as('c'))
    .where('period', '=', period)
    .where('status', '=', 'Posted')
    .executeTakeFirstOrThrow();

  const done = n(taskTotals.done);
  const total = n(taskTotals.total);

  return {
    kind: 'org_monthly',
    period,
    periodLabel,
    // The view has no row for a period with no attendance yet — null renders as
    // "—" rather than as a confident 0%.
    attendancePct: org?.attendance_pct === null || org === undefined ? null : Number(org.attendance_pct),
    activeStaffCount: n(org?.active_staff_count),
    activeClientCount: n(clients.c),
    tasks: {
      total,
      done,
      pending: total - done,
      overdue: perStaffRows.reduce((acc, r) => acc + n(r.tasks_overdue), 0),
    },
    perStaff: perStaffRows.map((r) => ({
      staffId: r.staff_id,
      name: r.name,
      role: r.role,
      assigned: n(r.total_assigned),
      done: n(r.tasks_done),
      overdue: n(r.tasks_overdue),
    })),
    shoots: {
      total: [...byStatus.values()].reduce((a, b) => a + b, 0),
      completed: byStatus.get('Completed') ?? 0,
      confirmed: byStatus.get('Confirmed') ?? 0,
      unset: byStatus.get('Unset') ?? 0,
    },
    posts: n(posts.c),
  };
}

async function collectClientMonthly(
  period: string,
  periodLabel: string,
  clientId: string,
  db: Executor,
): Promise<ClientMonthlyData> {
  const client = await db
    .selectFrom('clients')
    .select(['name', 'shoot_slots_per_month', 'pieces_per_visit'])
    .where('id', '=', clientId)
    .executeTakeFirstOrThrow();

  const slots = await db
    .selectFrom('shoot_schedules as s')
    .leftJoin('staff as f', 'f.id', 's.freelancer_id')
    .select([
      's.slot_index',
      's.slot_status',
      's.slot_date',
      's.pieces_expected',
      'f.name as freelancerName',
    ])
    .where('s.period', '=', period)
    .where('s.client_id', '=', clientId)
    .orderBy('s.slot_index', 'asc')
    .execute();

  const pipeline = await db
    .selectFrom('content_pipelines')
    .select([
      'visit_type',
      'last_shoot_date',
      'raw_received_at',
      'finals_ready_at',
      'posted_at',
      'coming_shoot_date',
    ])
    .where('period', '=', period)
    .where('client_id', '=', clientId)
    .executeTakeFirst();

  const calendar = await db
    .selectFrom('content_calendar')
    .select(['status', (eb) => eb.fn.countAll().as('c')])
    .where('period', '=', period)
    .where('client_id', '=', clientId)
    .groupBy('status')
    .orderBy('status', 'asc')
    .execute();

  return {
    kind: 'client_monthly',
    period,
    periodLabel,
    clientName: client.name,
    shootSlotsPerMonth: client.shoot_slots_per_month,
    piecesPerVisit: client.pieces_per_visit,
    slots: slots.map((s) => ({
      index: s.slot_index,
      status: s.slot_status,
      // DATE columns are identity-parsed to 'YYYY-MM-DD' strings (lib/db.ts), so
      // a calendar date cannot shift a day on the way into a PDF.
      date: (s.slot_date as string | null) ?? null,
      freelancer: s.freelancerName,
      pieces: s.pieces_expected,
    })),
    pipeline: pipeline
      ? {
          visitType: pipeline.visit_type,
          lastShootDate: (pipeline.last_shoot_date as string | null) ?? null,
          rawReceivedAt: iso(pipeline.raw_received_at),
          finalsReadyAt: iso(pipeline.finals_ready_at),
          postedAt: iso(pipeline.posted_at),
          comingShootDate: (pipeline.coming_shoot_date as string | null) ?? null,
        }
      : null,
    calendar: calendar.map((r) => ({ status: r.status, count: n(r.c) })),
  };
}
