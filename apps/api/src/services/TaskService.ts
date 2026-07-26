/**
 * TaskService — the Work Allocation module's backend brain (04-APPFLOW §5,
 * 07-API-CONTRACT §7, 08-AUTH-MATRIX §4). Executes the five pre-Sprint-4 ADRs:
 *
 *   - ADR-006 — task_assigned fans out ONE notification per newly-added,
 *     non-actor assignee, in the same transaction as the task_assignees insert.
 *   - ADR-008 — tasks are NOT versioned: plain guarded last-write-wins UPDATE,
 *     never optimisticUpdate, no `version`, no STALE_DATA.
 *   - ADR-009 — a SINGLE dependency_id self-FK. Write-time cycle prevention
 *     (bounded walk), the Done-block (DEPENDENCY_UNRESOLVED 400), and the
 *     dependency_resolved fan-out on completion — never an auto-status-change.
 *
 * INVARIANTS:
 *   - Every write method composes inside the CALLER's transaction (routes/tests
 *     open it, exactly like HolidayService). Notifications + audit ride the same
 *     trx as the write they describe.
 *   - The service is the security boundary: the team_member ownership backstop
 *     lives here, not only in the UI (Auth-Matrix §4).
 *   - Reads exclude soft-deleted tasks. camelCase at the boundary, snake_case in
 *     the DB.
 */
import { randomUUID } from 'node:crypto';

import { sql, type Kysely, type Transaction } from 'kysely';

import { AuditService } from './AuditService.js';
import { assertPeriodNotLocked, type Executor } from './BaseService.js';
import { NotificationService } from './NotificationService.js';
import { db } from '../lib/db.js';
import { transactionWithEmits } from '../lib/emit-after-commit.js';
import { AppError } from '../lib/errors.js';
import { softDelete, softDeletable } from '../lib/queries.js';

import type { CurrentUser } from './AttendanceService.js';
import type { DB } from '@skaly/shared';

/** Status / priority CHECK enums (05-BACKEND-SCHEMA tasks). */
export const TASK_STATUSES = ['To Do', 'In Progress', 'Blocked', 'Done', 'Cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface TaskFilters {
  period: string;
  date?: string;
  status?: string;
  clientId?: string;
  assigneeId?: string;
  priority?: string;
}

export interface TaskCreateInput {
  period: string;
  /** 'YYYY-MM-DD'. */
  date: string;
  description: string;
  clientId?: string | null;
  assigneeIds: string[];
  priority?: string | null;
  dependencyId?: string | null;
  /** 'YYYY-MM-DD'. */
  deadline?: string | null;
  remark?: string | null;
}

/** The fields a PATCH may change. No `version` (ADR-008). */
export interface TaskPatch {
  description?: string;
  clientId?: string | null;
  priority?: string | null;
  dependencyId?: string | null;
  deadline?: string | null;
  remark?: string | null;
  status?: string;
  result?: string | null;
}

export interface TaskAssigneeDTO {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface TaskAttachmentDTO {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string | null;
  uploadedBy: string;
  uploadedAt: string | null;
}

/** A task in the 07-API-CONTRACT §7 wire shape (list row). */
export interface TaskDTO {
  id: string;
  period: string;
  date: string;
  description: string;
  clientId: string | null;
  clientName: string | null;
  status: string;
  priority: string | null;
  dependencyId: string | null;
  dependencyDescription: string | null;
  /** dependency_id set AND that task's status ≠ 'Done'. */
  dependencyBlocked: boolean;
  deadline: string | null;
  remark: string | null;
  result: string | null;
  assignees: TaskAssigneeDTO[];
  attachmentCount: number;
  createdBy: string;
  createdAt: string | null;
}

/** getTask adds the full attachments list (for the row-expansion panel). */
export interface TaskDetailDTO extends TaskDTO {
  attachments: TaskAttachmentDTO[];
}

/** The base tasks row shape shared by getTasks / getTask, pre-stitch. */
interface TaskBaseRow {
  id: string;
  period: string;
  date: string;
  description: string;
  client_id: string | null;
  client_name: string | null;
  status: string;
  priority: string | null;
  dependency_id: string | null;
  dep_description: string | null;
  dep_status: string | null;
  deadline: string | null;
  remark: string | null;
  result: string | null;
  created_by: string;
  created_at: Date | null;
}

const BASE_COLUMNS = [
  'tasks.id as id',
  'tasks.period as period',
  sql<string>`to_char(tasks.date, 'YYYY-MM-DD')`.as('date'),
  'tasks.description as description',
  'tasks.client_id as client_id',
  'clients.name as client_name',
  'tasks.status as status',
  'tasks.priority as priority',
  'tasks.dependency_id as dependency_id',
  'dep.description as dep_description',
  'dep.status as dep_status',
  sql<string | null>`to_char(tasks.deadline, 'YYYY-MM-DD')`.as('deadline'),
  'tasks.remark as remark',
  'tasks.result as result',
  'tasks.created_by as created_by',
  'tasks.created_at as created_at',
] as const;

export class TaskService {
  private readonly audit = new AuditService();
  private readonly notifications = new NotificationService();

  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * Role scope (Auth-Matrix §4): admin/manager/team_member all read ALL tasks;
   * freelancer is blocked at the route and never reaches here. `assigneeId`
   * matches "is one of the assignees". Returns each task with its assignees,
   * attachment count, client name and derived `dependencyBlocked`.
   */
  async getTasks(filters: TaskFilters, _currentUser: CurrentUser, trx: Executor): Promise<TaskDTO[]> {
    let q = trx
      .selectFrom('tasks')
      .leftJoin('clients', 'clients.id', 'tasks.client_id')
      // Self-join for the dependency summary. softDeletable() can't be used on a
      // multi-table select — bare `deleted_at` would be ambiguous — so the
      // tombstone filter is applied explicitly on the qualified column.
      .leftJoin('tasks as dep', 'dep.id', 'tasks.dependency_id')
      .where('tasks.deleted_at', 'is', null)
      .where('tasks.period', '=', filters.period);

    if (filters.date) q = q.where('tasks.date', '=', sql<string>`${filters.date}::date`);
    if (filters.status) q = q.where('tasks.status', '=', filters.status);
    if (filters.clientId) q = q.where('tasks.client_id', '=', filters.clientId);
    if (filters.priority) q = q.where('tasks.priority', '=', filters.priority);
    if (filters.assigneeId) {
      const assigneeId = filters.assigneeId;
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom('task_assignees')
            .select(sql`1`.as('one'))
            .whereRef('task_assignees.task_id', '=', 'tasks.id')
            .where('task_assignees.staff_id', '=', assigneeId),
        ),
      );
    }

    const rows = (await q
      .select(BASE_COLUMNS)
      .orderBy('tasks.date')
      .orderBy('tasks.created_at')
      .execute()) as TaskBaseRow[];

    const taskIds = rows.map((r) => r.id);
    const [assigneesByTask, countsByTask] = await Promise.all([
      this.loadAssignees(taskIds, trx),
      this.loadAttachmentCounts(taskIds, trx),
    ]);

    return rows.map((r) => this.mapBase(r, assigneesByTask.get(r.id) ?? [], countsByTask.get(r.id) ?? 0));
  }

  /** Single task with full assignees, attachments list and dependency summary. */
  async getTask(id: string, _currentUser: CurrentUser, trx: Executor): Promise<TaskDetailDTO> {
    const row = (await trx
      .selectFrom('tasks')
      .leftJoin('clients', 'clients.id', 'tasks.client_id')
      .leftJoin('tasks as dep', 'dep.id', 'tasks.dependency_id')
      .where('tasks.deleted_at', 'is', null)
      .where('tasks.id', '=', id)
      .select(BASE_COLUMNS)
      .executeTakeFirst()) as TaskBaseRow | undefined;

    if (!row) {
      throw new AppError('RESOURCE_NOT_FOUND', `Task ${id} does not exist.`);
    }

    const [assigneesByTask, attachments] = await Promise.all([
      this.loadAssignees([id], trx),
      this.loadAttachments(id, trx),
    ]);

    return {
      ...this.mapBase(row, assigneesByTask.get(id) ?? [], attachments.length),
      attachments,
    };
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /**
   * Create a task with an assignee set. admin/manager only (route-gated;
   * asserted defensively). Cycle-checks the dependency, inserts the task,
   * fans out task_assigned per non-actor assignee (ADR-006), audits.
   */
  async create(input: TaskCreateInput, currentUser: CurrentUser, trx: Transaction<DB>): Promise<TaskDetailDTO> {
    this.assertAdminOrManager(currentUser);

    await assertPeriodNotLocked(input.period, trx);

    const taskId = randomUUID();

    if (input.dependencyId) {
      await this.assertDependencyExists(input.dependencyId, trx);
      // A brand-new id can't yet be depended upon; the walk still validates that
      // the chosen dependency's chain is itself acyclic (ADR-009).
      await this.assertNoDependencyCycle(taskId, input.dependencyId, trx);
    }

    const assigneeIds = [...new Set(input.assigneeIds)];
    await this.resolveActiveStaff(assigneeIds, trx);

    await trx
      .insertInto('tasks')
      .values({
        id: taskId,
        period: input.period,
        date: input.date,
        description: input.description,
        client_id: input.clientId ?? null,
        status: 'To Do',
        priority: input.priority ?? null,
        dependency_id: input.dependencyId ?? null,
        remark: input.remark ?? null,
        deadline: input.deadline ?? null,
        result: null,
        created_by: currentUser.staffId,
      })
      .execute();

    // ADR-006 fan-out: insert each assignee, and within the loop notify every
    // assignee that is not the acting user.
    for (const staffId of assigneeIds) {
      await trx
        .insertInto('task_assignees')
        .values({ task_id: taskId, staff_id: staffId, assigned_by: currentUser.staffId })
        .execute();

      if (staffId !== currentUser.staffId) {
        await this.notifications.create({
          recipientId: staffId,
          type: 'task_assigned',
          title: input.description,
          body: 'You were assigned a task',
          data: {
            taskId,
            taskDescription: input.description,
            assignedBy: currentUser.staffId,
            dueDate: input.deadline ?? null,
            link: `/tasks?period=${input.period}&highlight=${taskId}`,
          },
          trx,
        });
      }
    }

    await this.audit.log({
      actorId: currentUser.staffId,
      action: 'INSERT',
      entity: 'tasks',
      entityId: taskId,
      after: {
        period: input.period,
        date: input.date,
        description: input.description,
        status: 'To Do',
        client_id: input.clientId ?? null,
        priority: input.priority ?? null,
        dependency_id: input.dependencyId ?? null,
        deadline: input.deadline ?? null,
        assigneeIds,
      },
      trx,
    });

    return this.getTask(taskId, currentUser, trx);
  }

  /**
   * Field edits + status transitions. No `version` — last-write-wins (ADR-008).
   * Enforces the team_member ownership backstop, the dependency cycle check, the
   * Done-block (DEPENDENCY_UNRESOLVED), and the dependency_resolved fan-out.
   */
  async update(id: string, patch: TaskPatch, currentUser: CurrentUser, trx: Transaction<DB>): Promise<TaskDetailDTO> {
    const task = await this.loadTaskRow(id, trx);

    // (b) Ownership backstop — the security boundary (Auth-Matrix §4).
    if (currentUser.role === 'team_member') {
      const provided = providedKeys(patch);
      const disallowed = provided.filter((k) => k !== 'status' && k !== 'result');
      if (disallowed.length > 0) {
        throw new AppError(
          'PERMISSION_DENIED',
          'You can only update the status and result of your own assigned tasks.',
        );
      }
      const isAssignee = await trx
        .selectFrom('task_assignees')
        .select('staff_id')
        .where('task_id', '=', id)
        .where('staff_id', '=', currentUser.staffId)
        .executeTakeFirst();
      if (!isAssignee) {
        throw new AppError(
          'PERMISSION_DENIED',
          'You can only update the status and result of your own assigned tasks.',
        );
      }
    } else if (currentUser.role !== 'admin' && currentUser.role !== 'manager') {
      // Freelancer / anything else — blocked at the route, denied here too.
      throw new AppError('PERMISSION_DENIED', 'You do not have permission to edit tasks.');
    }

    await assertPeriodNotLocked(task.period, trx);

    // (d) Cycle check only when dependency_id is actually changing.
    const dependencyChanging =
      patch.dependencyId !== undefined && (patch.dependencyId ?? null) !== task.dependency_id;
    if (dependencyChanging && patch.dependencyId) {
      await this.assertDependencyExists(patch.dependencyId, trx);
      await this.assertNoDependencyCycle(id, patch.dependencyId, trx);
    }

    // (e) Done-block (ADR-009): check against the EFFECTIVE dependency (a PATCH
    // may set a new dependency and status='Done' in one call).
    if (patch.status === 'Done') {
      const effectiveDependencyId =
        patch.dependencyId !== undefined ? patch.dependencyId : task.dependency_id;
      if (effectiveDependencyId) {
        const dep = await trx
          .selectFrom('tasks')
          .select(['id', 'description', 'status'])
          .where('id', '=', effectiveDependencyId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (dep && dep.status !== 'Done') {
          throw new AppError('DEPENDENCY_UNRESOLVED', 'This task is blocked by an unresolved dependency.', {
            dependencyTask: { id: dep.id, description: dep.description, status: dep.status },
          });
        }
      }
    }

    // (f) Plain guarded update — last-write-wins.
    const set = toUpdateSet(patch);
    if (Object.keys(set).length === 0) {
      throw new AppError('VALIDATION_ERROR', 'No fields to update.');
    }
    await trx
      .updateTable('tasks')
      .set(set)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .execute();

    await this.audit.log({
      actorId: currentUser.staffId,
      action: 'UPDATE',
      entity: 'tasks',
      entityId: id,
      before: beforeSnapshot(task, patch),
      after: set,
      trx,
    });

    // (h) dependency_resolved (ADR-009): only on a genuine transition INTO Done.
    if (patch.status === 'Done' && task.status !== 'Done') {
      await this.fanOutDependencyResolved(id, currentUser, trx);
    }

    return this.getTask(id, currentUser, trx);
  }

  /**
   * Thin status-only wrapper. Opens its own transaction (Testing-Strategy §4.2
   * calls `updateStatus(currentUser, id, 'Done')` — no `version` arg, ADR-008).
   */
  async updateStatus(
    currentUser: CurrentUser,
    id: string,
    status: string,
    executor: Kysely<DB> = db,
  ): Promise<TaskDetailDTO> {
    return transactionWithEmits(executor, (trx) => this.update(id, { status }, currentUser, trx));
  }

  /** Soft-delete. admin/manager only. Assignee rows are preserved (no cascade on soft-delete). */
  async remove(id: string, currentUser: CurrentUser, trx: Transaction<DB>): Promise<{ deleted: true }> {
    this.assertAdminOrManager(currentUser);
    const task = await this.loadTaskRow(id, trx);
    await assertPeriodNotLocked(task.period, trx);
    await softDelete('tasks', id, currentUser.staffId, trx);
    await this.audit.log({
      actorId: currentUser.staffId,
      action: 'DELETE',
      entity: 'tasks',
      entityId: id,
      before: { status: task.status, period: task.period },
      trx,
    });
    return { deleted: true };
  }

  /**
   * Add assignees. admin/manager only. Inserts only NEW staffIds and fans out
   * task_assigned to the newly-added, non-actor ones — never re-notifies an
   * existing assignee (ADR-006).
   */
  async assign(id: string, staffIds: string[], currentUser: CurrentUser, trx: Transaction<DB>): Promise<TaskDetailDTO> {
    this.assertAdminOrManager(currentUser);
    const task = await this.loadTaskRow(id, trx);
    await assertPeriodNotLocked(task.period, trx);

    const requested = [...new Set(staffIds)];
    await this.resolveActiveStaff(requested, trx);

    const existing = await trx
      .selectFrom('task_assignees')
      .select('staff_id')
      .where('task_id', '=', id)
      .execute();
    const existingSet = new Set(existing.map((e) => e.staff_id));
    const newIds = requested.filter((s) => !existingSet.has(s));

    if (newIds.length > 0) {
      await trx
        .insertInto('task_assignees')
        .values(newIds.map((s) => ({ task_id: id, staff_id: s, assigned_by: currentUser.staffId })))
        .onConflict((oc) => oc.columns(['task_id', 'staff_id']).doNothing())
        .execute();

      for (const staffId of newIds) {
        if (staffId === currentUser.staffId) continue;
        await this.notifications.create({
          recipientId: staffId,
          type: 'task_assigned',
          title: task.description,
          body: 'You were assigned a task',
          data: {
            taskId: id,
            taskDescription: task.description,
            assignedBy: currentUser.staffId,
            dueDate: task.deadline ?? null,
            link: `/tasks?period=${task.period}&highlight=${id}`,
          },
          trx,
        });
      }

      await this.audit.log({
        actorId: currentUser.staffId,
        action: 'UPDATE',
        entity: 'task_assignees',
        entityId: id,
        after: { added: newIds },
        trx,
      });
    }

    return this.getTask(id, currentUser, trx);
  }

  /** Remove one assignee. admin/manager only. No notification (ADR-006). */
  async unassign(id: string, staffId: string, currentUser: CurrentUser, trx: Transaction<DB>): Promise<TaskDetailDTO> {
    this.assertAdminOrManager(currentUser);
    const task = await this.loadTaskRow(id, trx);
    await assertPeriodNotLocked(task.period, trx);

    await trx
      .deleteFrom('task_assignees')
      .where('task_id', '=', id)
      .where('staff_id', '=', staffId)
      .execute();

    await this.audit.log({
      actorId: currentUser.staffId,
      action: 'UPDATE',
      entity: 'task_assignees',
      entityId: id,
      before: { removed: staffId },
      trx,
    });

    return this.getTask(id, currentUser, trx);
  }

  // ── Dependency integrity (ADR-009) ──────────────────────────────────────────

  /**
   * Reject a dependency edge that would create a cycle. Walk the dependency_id
   * chain from the PROPOSED dependency; if it reaches `taskId`, the edge closes a
   * loop. A visited Set guarantees termination even on already-dirty data; the
   * task-count cap is a second defensive bound. The DB tasks_no_self_dep CHECK
   * remains the 1-cycle backstop.
   */
  async assertNoDependencyCycle(taskId: string, proposedDependencyId: string, trx: Executor): Promise<void> {
    const { count } = await trx
      .selectFrom('tasks')
      .select(sql<number>`count(*)::int`.as('count'))
      .executeTakeFirstOrThrow();

    const visited = new Set<string>();
    let current: string | null = proposedDependencyId;
    let steps = 0;

    while (current) {
      if (current === taskId) {
        throw new AppError('VALIDATION_ERROR', 'This dependency would create a cycle.', {
          message: 'This dependency would create a cycle',
        });
      }
      if (visited.has(current)) break; // pre-existing cycle not involving taskId — terminate
      visited.add(current);
      if (++steps > count) break; // defensive cap

      const row: { dependency_id: string | null } | undefined = await trx
        .selectFrom('tasks')
        .select('dependency_id')
        .where('id', '=', current)
        .executeTakeFirst();
      current = row?.dependency_id ?? null;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private assertAdminOrManager(currentUser: CurrentUser): void {
    if (currentUser.role !== 'admin' && currentUser.role !== 'manager') {
      throw new AppError('PERMISSION_DENIED', 'Only an admin or manager may perform this action.');
    }
  }

  /** Load the minimal task row for a write path, or 404. Dates as 'YYYY-MM-DD'. */
  private async loadTaskRow(id: string, trx: Executor): Promise<{
    id: string;
    period: string;
    status: string;
    description: string;
    dependency_id: string | null;
    deadline: string | null;
    priority: string | null;
    client_id: string | null;
    remark: string | null;
    result: string | null;
  }> {
    const row = await trx
      .selectFrom('tasks')
      .where('deleted_at', 'is', null)
      .where('id', '=', id)
      .select([
        'id',
        'period',
        'status',
        'description',
        'dependency_id',
        sql<string | null>`to_char(deadline, 'YYYY-MM-DD')`.as('deadline'),
        'priority',
        'client_id',
        'remark',
        'result',
      ])
      .executeTakeFirst();
    if (!row) {
      throw new AppError('RESOURCE_NOT_FOUND', `Task ${id} does not exist.`);
    }
    return row;
  }

  private async assertDependencyExists(dependencyId: string, trx: Executor): Promise<void> {
    const dep = await trx
      .selectFrom('tasks')
      .select('id')
      .where('id', '=', dependencyId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!dep) {
      throw new AppError('VALIDATION_ERROR', 'Dependency task not found.', { dependencyId });
    }
  }

  /**
   * Validate that every id is active, non-deleted staff — and return their names.
   *
   * Public and name-returning since Sprint 9: `assign_task`'s confirmation card has
   * to show WHO is being assigned, not a count (ADR-014 §4 — the user consents to
   * specific values). This is the query that already runs before the write, so
   * calling it at turn 1 also means an inactive assignee is rejected before the
   * user consents rather than after.
   */
  async resolveActiveStaff(staffIds: string[], trx: Executor): Promise<Array<{ id: string; name: string }>> {
    if (staffIds.length === 0) return [];
    const found = await trx
      .selectFrom('staff')
      .select(['id', 'name'])
      .where('id', 'in', staffIds)
      .where('active', '=', true)
      .where('deleted_at', 'is', null)
      .execute();
    if (found.length !== staffIds.length) {
      throw new AppError('VALIDATION_ERROR', 'One or more assignees are not active staff.');
    }
    return found;
  }

  private async fanOutDependencyResolved(
    resolvedTaskId: string,
    currentUser: CurrentUser,
    trx: Transaction<DB>,
  ): Promise<void> {
    const dependents = await trx
      .selectFrom('tasks')
      .select(['id', 'description', 'period'])
      .where('dependency_id', '=', resolvedTaskId)
      .where('deleted_at', 'is', null)
      .execute();

    for (const dependent of dependents) {
      const assignees = await trx
        .selectFrom('task_assignees')
        .select('staff_id')
        .where('task_id', '=', dependent.id)
        .execute();

      for (const { staff_id } of assignees) {
        if (staff_id === currentUser.staffId) continue; // actor-excluded
        await this.notifications.create({
          recipientId: staff_id,
          type: 'dependency_resolved',
          title: dependent.description,
          body: 'A task you were waiting on is now done.',
          data: {
            taskId: dependent.id,
            taskDescription: dependent.description,
            resolvedDependencyId: resolvedTaskId,
            link: `/tasks?period=${dependent.period}&highlight=${dependent.id}`,
          },
          trx,
        });
      }
    }
  }

  private async loadAssignees(taskIds: string[], trx: Executor): Promise<Map<string, TaskAssigneeDTO[]>> {
    const map = new Map<string, TaskAssigneeDTO[]>();
    if (taskIds.length === 0) return map;
    const rows = await trx
      .selectFrom('task_assignees')
      .innerJoin('staff', 'staff.id', 'task_assignees.staff_id')
      .select([
        'task_assignees.task_id as task_id',
        'staff.id as id',
        'staff.name as name',
        'staff.avatar_url as avatar_url',
      ])
      .where('task_assignees.task_id', 'in', taskIds)
      .orderBy('task_assignees.assigned_at')
      .execute();
    for (const r of rows) {
      const list = map.get(r.task_id) ?? [];
      list.push({ id: r.id, name: r.name, avatarUrl: r.avatar_url });
      map.set(r.task_id, list);
    }
    return map;
  }

  private async loadAttachmentCounts(taskIds: string[], trx: Executor): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (taskIds.length === 0) return map;
    const rows = await trx
      .selectFrom('task_attachments')
      .select(['task_id', sql<string>`count(*)`.as('cnt')])
      .where('task_id', 'in', taskIds)
      .groupBy('task_id')
      .execute();
    for (const r of rows) map.set(r.task_id, Number(r.cnt));
    return map;
  }

  private async loadAttachments(taskId: string, trx: Executor): Promise<TaskAttachmentDTO[]> {
    const rows = await trx
      .selectFrom('task_attachments')
      .select([
        'id',
        'file_name',
        'file_size',
        'mime_type',
        'uploaded_by',
        'uploaded_at',
      ])
      .where('task_id', '=', taskId)
      .orderBy('uploaded_at')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      fileName: r.file_name,
      fileSize: Number(r.file_size),
      mimeType: r.mime_type,
      uploadedBy: r.uploaded_by,
      uploadedAt: r.uploaded_at instanceof Date ? r.uploaded_at.toISOString() : (r.uploaded_at as string | null),
    }));
  }

  private mapBase(row: TaskBaseRow, assignees: TaskAssigneeDTO[], attachmentCount: number): TaskDTO {
    return {
      id: row.id,
      period: row.period,
      date: row.date,
      description: row.description,
      clientId: row.client_id,
      clientName: row.client_name,
      status: row.status,
      priority: row.priority,
      dependencyId: row.dependency_id,
      dependencyDescription: row.dep_description,
      dependencyBlocked: row.dependency_id !== null && row.dep_status !== 'Done',
      deadline: row.deadline,
      remark: row.remark,
      result: row.result,
      assignees,
      attachmentCount,
      createdBy: row.created_by,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }

  /**
   * The overdue sweep — `task_overdue`'s producer (ADR-020).
   *
   * The type has existed in the enum since Sprint 4 with nothing emitting it. Built
   * as a SERVICE METHOD, not a cron: Sprint 12 owns scheduling, and a job whose logic
   * is already tested is a one-liner to schedule. Written now because the gap was
   * found now, and a producer that exists is a producer that can be tested.
   *
   * "Overdue" is a task past its `deadline` that is neither Done nor Cancelled.
   * `date` is the planned working day; `deadline` is the commitment, and only the
   * commitment can be missed.
   *
   * Every run notifies every assignee — the dedup guard in NotificationService is
   * what stops that becoming a daily repeat for the same task, and it lives there
   * rather than here so the next repeating producer inherits it for free.
   */
  async notifyOverdue(db: Kysely<DB>): Promise<number> {
    return transactionWithEmits(db, async (trx) => {
      const overdue = await softDeletable(
        trx
          .selectFrom('tasks')
          .innerJoin('task_assignees', 'task_assignees.task_id', 'tasks.id')
          .select([
            'tasks.id as id',
            'tasks.description as description',
            'tasks.period as period',
            'tasks.deadline as deadline',
            'task_assignees.staff_id as staff_id',
          ]),
      )
        .where('tasks.deadline', 'is not', null)
        .where('tasks.deadline', '<', sql<string>`current_date`)
        .where('tasks.status', 'not in', ['Done', 'Cancelled'])
        .execute();

      let sent = 0;
      for (const row of overdue) {
        const created = await this.notifications.create({
          recipientId: row.staff_id,
          type: 'task_overdue',
          title: row.description,
          body: `Was due ${String(row.deadline)}`,
          data: { taskId: row.id, period: row.period, deadline: row.deadline, recordId: row.id },
          // (recipient, type, task) — the dedup key. Without it this sweep re-notifies
          // the same task to the same person on every run, forever, and the bell
          // becomes noise the user learns to ignore.
          recordId: row.id,
          trx,
        });
        if (created) sent += 1;
      }
      return sent;
    });
  }
}

// ── Module-private pure helpers ────────────────────────────────────────────────

/** Keys of `patch` that were actually provided (value !== undefined). */
function providedKeys(patch: TaskPatch): string[] {
  return Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
}

/** Map a camelCase patch to the snake_case UPDATE set (only provided keys). */
function toUpdateSet(patch: TaskPatch): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.clientId !== undefined) set.client_id = patch.clientId;
  if (patch.priority !== undefined) set.priority = patch.priority;
  if (patch.dependencyId !== undefined) set.dependency_id = patch.dependencyId;
  if (patch.deadline !== undefined) set.deadline = patch.deadline;
  if (patch.remark !== undefined) set.remark = patch.remark;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.result !== undefined) set.result = patch.result;
  return set;
}

/** The pre-update values of the columns this patch touches (for the audit before-image). */
function beforeSnapshot(
  task: { status: string; dependency_id: string | null; priority: string | null; client_id: string | null; remark: string | null; result: string | null; deadline: string | null; description: string },
  patch: TaskPatch,
): Record<string, unknown> {
  const before: Record<string, unknown> = {};
  if (patch.description !== undefined) before.description = task.description;
  if (patch.clientId !== undefined) before.client_id = task.client_id;
  if (patch.priority !== undefined) before.priority = task.priority;
  if (patch.dependencyId !== undefined) before.dependency_id = task.dependency_id;
  if (patch.deadline !== undefined) before.deadline = task.deadline;
  if (patch.remark !== undefined) before.remark = task.remark;
  if (patch.status !== undefined) before.status = task.status;
  if (patch.result !== undefined) before.result = task.result;
  return before;
}
