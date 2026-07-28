/**
 * Task-domain MUTATION tools (Sprint 9 STEP 4, TRD §9.3).
 *
 * Every one is a thin wrapper over the same `TaskService` method the REST route
 * calls, with the JWT `currentUser`. No raw queries, no re-implemented validation,
 * no error reshaping — the dependency block (DEPENDENCY_UNRESOLVED 400), the
 * team_member ownership backstop (403), the period lock (423) and the cycle guard
 * all pass through exactly as REST produces them. That is what makes the
 * write-parity test (STEP 7) meaningful rather than a tautology.
 *
 * ADR-008: `tasks` is UNVERSIONED. None of these capture or send a version.
 *
 * Reconciliation #4 holds for mutations too: no input schema carries a staffId for
 * the *actor*. `assign_task`'s `staffIds` are the assignees, which is the operation
 * itself, not an identity claim — the actor is still the JWT.
 */
import { z } from 'zod';

import { defineMutationTool } from './types.js';
import { transactionWithEmits } from '../../../lib/emit-after-commit.js';
import { AppError } from '../../../lib/errors.js';
import { ClientService } from '../../../services/ClientService.js';
import { TaskService } from '../../../services/TaskService.js';

import type { CurrentUser } from '../../../services/AttendanceService.js';
import type { TaskDetailDTO } from '../../../services/TaskService.js';
import type { DB } from '@skaly/shared';
import type { Kysely } from 'kysely';

const tasks = new TaskService();
const clients = new ClientService();

const TASK_STATUSES = ['To Do', 'In Progress', 'Blocked', 'Done', 'Cancelled'] as const;
const uuid = z.string().uuid();
const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

/** The turn-1 read every task tool shares. RESOURCE_NOT_FOUND surfaces here, so a
 *  hallucinated id dies before any pending state is created. */
async function readTask(taskId: string, currentUser: CurrentUser, db: Kysely<DB>) {
  const task = await tasks.getTask(taskId, currentUser, db);
  return {
    state: {
      id: task.id,
      description: task.description,
      period: task.period,
      status: task.status,
      deadline: task.deadline,
      assignees: task.assignees.map((a) => a.name).join(', '),
    },
  };
}

/** APPFLOW §12's convention. `highlight` is the row the grid flashes gold. */
const taskLink = (result: TaskDetailDTO): string =>
  `/tasks?period=${result.period}&highlight=${result.id}`;

export const updateTaskStatusTool = defineMutationTool({
  name: 'update_task_status',
  family: 'tasks.write',
  capability: 'changing a task status',
  description:
    "Change a task's status. You must look the task up with a query tool first to get its id.",
  inputSchema: z.object({ taskId: uuid, status: z.enum(TASK_STATUSES) }),
  jsonSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The task id, obtained from a query tool.' },
      status: { type: 'string', enum: [...TASK_STATUSES] },
    },
    required: ['taskId', 'status'],
  },
  readCurrent: (input, currentUser, db) => readTask(input.taskId, currentUser, db),
  summary: {
    entity: 'Task',
    action: (input) => `Mark task as ${input.status}`,
    target: (state) => state.description,
    period: (_input, state) => state.period,
    changes: [{ field: 'Status', from: (s) => s.status, to: (i) => i.status }],
  },
  async handler(input, currentUser, db) {
    const result = await transactionWithEmits(db, (trx) => tasks.update(input.taskId, { status: input.status }, currentUser, trx));
    return { text: `Task status is now ${result.status}.`, card: { type: 'mutation_result' }, link: taskLink(result) };
  },
});

export const setDeadlineTool = defineMutationTool({
  name: 'set_deadline',
  family: 'tasks.write',
  capability: 'changing a task deadline',
  description:
    "Set or change a task's deadline. Look the task up with a query tool first to get its id.",
  inputSchema: z.object({ taskId: uuid, deadline: dateField }),
  jsonSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The task id, obtained from a query tool.' },
      deadline: { type: 'string', description: 'Deadline as YYYY-MM-DD.' },
    },
    required: ['taskId', 'deadline'],
  },
  readCurrent: (input, currentUser, db) => readTask(input.taskId, currentUser, db),
  summary: {
    entity: 'Task',
    action: () => 'Change task deadline',
    target: (state) => state.description,
    period: (_input, state) => state.period,
    changes: [{ field: 'Deadline', from: (s) => s.deadline, to: (i) => i.deadline }],
  },
  async handler(input, currentUser, db) {
    const result = await transactionWithEmits(db, (trx) => tasks.update(input.taskId, { deadline: input.deadline }, currentUser, trx));
    return { text: `Deadline set to ${input.deadline}.`, card: { type: 'mutation_result' }, link: taskLink(result) };
  },
});

export const assignTaskTool = defineMutationTool({
  name: 'assign_task',
  family: 'tasks.write',
  capability: 'assigning tasks',
  description:
    'Add one or more staff members as assignees on a task. Look up both the task and the staff with query tools first to get their ids. Existing assignees are kept.',
  inputSchema: z.object({ taskId: uuid, staffIds: z.array(uuid).min(1) }),
  jsonSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The task id, obtained from a query tool.' },
      staffIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Staff ids to add as assignees. These are the people being assigned, not the requester.',
      },
    },
    required: ['taskId', 'staffIds'],
  },
  /**
   * Resolves the requested ids to NAMES and diffs them against the current set.
   *
   * The card must show who (ADR-014 §4 — the user consents to specific values).
   * "2 added" reads identically whether those are the two people they meant or two
   * ids the model resolved wrongly, and by the time the outcome message names them
   * the consent has already happened.
   *
   * Only the DELTA is shown: re-confirming an assignment that is mostly unchanged
   * must not look like it is reassigning everyone.
   */
  async readCurrent(input, currentUser, db) {
    const task = await tasks.getTask(input.taskId, currentUser, db);
    // Same validation the write does — an inactive assignee is rejected here,
    // before consent, rather than after it.
    const requested = await tasks.resolveActiveStaff(input.staffIds, db);

    const already = new Set(task.assignees.map((a) => a.id));
    const added = requested.filter((s) => !already.has(s.id));

    const state = {
      description: task.description,
      period: task.period,
      current: task.assignees.map((a) => a.name).join(', '),
      added: added.map((s) => `+ ${s.name}`).join(', '),
      addedCount: added.length,
    };

    if (added.length === 0) {
      const names = requested.map((s) => s.name).join(', ');
      return { state, noChange: `${names} ${requested.length === 1 ? 'is' : 'are'} already assigned to that task.` };
    }
    return { state };
  },
  summary: {
    entity: 'Task',
    action: (_input) => 'Assign people to task',
    target: (state) => state.description,
    period: (_input, state) => state.period,
    changes: [{ field: 'Assignees', from: (s) => s.current, to: (_i, s) => s.added }],
  },
  async handler(input, currentUser, db) {
    const result = await transactionWithEmits(db, (trx) => tasks.assign(input.taskId, input.staffIds, currentUser, trx));
    const names = result.assignees.map((a) => a.name).join(', ') || 'nobody';
    return { text: `Task is now assigned to ${names}.`, card: { type: 'mutation_result' }, link: taskLink(result) };
  },
});

export const createTaskTool = defineMutationTool({
  name: 'create_task',
  family: 'tasks.write',
  capability: 'creating tasks',
  description:
    'Create a task. admin/manager only. Look up the client and any assignees with query tools first to get their ids.',
  inputSchema: z.object({
    description: z.string().min(1).max(500),
    date: dateField,
    clientId: uuid.optional(),
    assigneeIds: z.array(uuid).optional(),
    deadline: dateField.optional(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'What the task is.' },
      date: { type: 'string', description: 'The task date as YYYY-MM-DD. Its month becomes the period.' },
      clientId: { type: 'string', description: 'Optional client id from a query tool.' },
      assigneeIds: { type: 'array', items: { type: 'string' }, description: 'Optional staff ids to assign.' },
      deadline: { type: 'string', description: 'Optional deadline as YYYY-MM-DD.' },
    },
    required: ['description', 'date'],
  },
  /**
   * The task does not exist yet, so there is no target row — but the ids in the
   * input still have to become names before the user is asked to approve them.
   * A card reading `Client: e0000000-…` is not a value anyone can consent to.
   */
  async readCurrent(input, _currentUser, db) {
    const assignees = await tasks.resolveActiveStaff(input.assigneeIds ?? [], db);
    const client = input.clientId
      ? (await clients.list({ includeInactive: true }, db)).find((c) => c.id === input.clientId)
      : undefined;
    if (input.clientId && !client) {
      throw new AppError('RESOURCE_NOT_FOUND', `clients row ${input.clientId} does not exist.`);
    }
    return {
      state: {
        period: input.date.slice(0, 7),
        clientName: client?.name ?? null,
        assigneeNames: assignees.map((a) => a.name).join(', '),
      },
    };
  },
  summary: {
    entity: 'Task',
    action: () => 'Create a new task',
    target: (state) => `A new task in ${state.period}`,
    period: (_input, state) => state.period,
    changes: [
      { field: 'Description', from: () => null, to: (i) => i.description },
      { field: 'Date', from: () => null, to: (i) => i.date },
      { field: 'Deadline', from: () => null, to: (i) => i.deadline },
      { field: 'Client', from: () => null, to: (_i, s) => s.clientName },
      { field: 'Assignees', from: () => null, to: (_i, s) => s.assigneeNames },
    ],
  },
  async handler(input, currentUser, db) {
    const result = await transactionWithEmits(db, (trx) =>
      tasks.create(
        {
          description: input.description,
          date: input.date,
          period: input.date.slice(0, 7),
          clientId: input.clientId,
          assigneeIds: input.assigneeIds ?? [],
          deadline: input.deadline,
        },
        currentUser,
        trx,
      ),
    );
    return { text: `Created "${result.description}".`, card: { type: 'mutation_result' }, link: taskLink(result) };
  },
});
