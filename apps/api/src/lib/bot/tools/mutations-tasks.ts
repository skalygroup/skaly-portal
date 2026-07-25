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
import { TaskService } from '../../../services/TaskService.js';

import type { CurrentUser } from '../../../services/AttendanceService.js';
import type { TaskDetailDTO } from '../../../services/TaskService.js';
import type { DB } from '@skaly/shared';
import type { Kysely } from 'kysely';

const tasks = new TaskService();

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
  link: taskLink,
  async handler(input, currentUser, db) {
    const result = await db
      .transaction()
      .execute((trx) => tasks.update(input.taskId, { status: input.status }, currentUser, trx));
    return { text: `Task status is now ${result.status}.`, card: { type: 'mutation_result' } };
  },
});

export const setDeadlineTool = defineMutationTool({
  name: 'set_deadline',
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
  link: taskLink,
  async handler(input, currentUser, db) {
    await db
      .transaction()
      .execute((trx) => tasks.update(input.taskId, { deadline: input.deadline }, currentUser, trx));
    return { text: `Deadline set to ${input.deadline}.`, card: { type: 'mutation_result' } };
  },
});

export const assignTaskTool = defineMutationTool({
  name: 'assign_task',
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
  readCurrent: (input, currentUser, db) => readTask(input.taskId, currentUser, db),
  summary: {
    entity: 'Task',
    action: (input) => `Assign ${input.staffIds.length} ${input.staffIds.length === 1 ? 'person' : 'people'} to task`,
    target: (state) => state.description,
    period: (_input, state) => state.period,
    // `to` is left as the count: the summary is rendered server-side from the
    // validated input, and resolving ids → names here would need a second read
    // that TaskService.assign already does. The names land in the outcome message.
    changes: [
      {
        field: 'Assignees',
        from: (s) => s.assignees,
        to: (i) => `${i.staffIds.length} added`,
      },
    ],
  },
  link: taskLink,
  async handler(input, currentUser, db) {
    const result = await db
      .transaction()
      .execute((trx) => tasks.assign(input.taskId, input.staffIds, currentUser, trx));
    const names = result.assignees.map((a) => a.name).join(', ') || 'nobody';
    return { text: `Task is now assigned to ${names}.`, card: { type: 'mutation_result' } };
  },
});

export const createTaskTool = defineMutationTool({
  name: 'create_task',
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
  // Nothing exists yet, so there is no target to read and no version to capture.
  // The summary still comes from validated input — the model does not paraphrase it.
  readCurrent: (input) => Promise.resolve({ state: { period: input.date.slice(0, 7) } }),
  summary: {
    entity: 'Task',
    action: () => 'Create a new task',
    target: (state) => `A new task in ${state.period}`,
    period: (_input, state) => state.period,
    changes: [
      { field: 'Description', from: () => null, to: (i) => i.description },
      { field: 'Date', from: () => null, to: (i) => i.date },
      { field: 'Deadline', from: () => null, to: (i) => i.deadline },
      { field: 'Assignees', from: () => null, to: (i) => i.assigneeIds?.length ?? 0 },
    ],
  },
  link: taskLink,
  async handler(input, currentUser, db) {
    const result = await db.transaction().execute((trx) =>
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
    return { text: `Created "${result.description}".`, card: { type: 'mutation_result' } };
  },
});
