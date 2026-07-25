/**
 * Task-domain query tools. All read through TaskService.getTasks with the JWT
 * `currentUser` — exactly as the REST GET /v1/tasks route does, so the bot-vs-REST
 * parity test (STEP 5) holds. list_tasks has a REST twin and must mirror it;
 * list_overdue_tasks / get_user_workload / get_project_status are bot-only, so
 * they may scope a team_member to their own rows via the JWT staffId (never an
 * input-schema staffId — reconciliation #4).
 */
import { z } from 'zod';

import { defineTool } from './types.js';
import { currentIstDate, currentIstPeriod } from '../../../services/BaseService.js';
import { TaskService, type TaskDTO } from '../../../services/TaskService.js';


const tasks = new TaskService();

/** Statuses that count as closed for overdue / workload maths. */
const CLOSED = new Set(['Done', 'Cancelled']);

const periodField = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM')
  .optional();
const periodProp = { type: 'string', description: 'Month as YYYY-MM. Defaults to the current IST month.' } as const;

function line(t: TaskDTO): string {
  const who = t.assignees.map((a) => a.name).join(', ') || 'unassigned';
  const due = t.deadline ? `, due ${t.deadline}` : '';
  const client = t.clientName ? ` [${t.clientName}]` : '';
  return `• ${t.description}${client} — ${t.status}${due} (${who})`;
}

export const listTasksTool = defineTool({
  name: 'list_tasks',
  family: 'tasks.read',
  capability: 'listing tasks',
  description:
    'List tasks for a month, optionally filtered by status or client. Returns only what the caller is authorised to see.',
  inputSchema: z.object({
    period: periodField,
    status: z.string().optional(),
    clientId: z.string().uuid().optional(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      period: periodProp,
      status: { type: 'string', enum: ['To Do', 'In Progress', 'Blocked', 'Done', 'Cancelled'] },
      clientId: { type: 'string', description: 'Filter to a single client by id.' },
    },
    required: [],
  },
  isMutation: false,
  async handler(input, currentUser, db) {
    const period = input.period ?? currentIstPeriod();
    const rows = await tasks.getTasks(
      { period, status: input.status, clientId: input.clientId },
      currentUser,
      db,
    );
    const text = rows.length
      ? `${rows.length} task(s) for ${period}:\n${rows.map(line).join('\n')}`
      : `No tasks for ${period}.`;
    return { text, card: { type: 'task_list', period, tasks: rows } };
  },
});

export const listOverdueTasksTool = defineTool({
  name: 'list_overdue_tasks',
  family: 'tasks.read',
  capability: 'listing overdue tasks',
  description:
    'List tasks whose deadline has passed and are not yet Done or Cancelled, for a month (defaults to current).',
  inputSchema: z.object({ period: periodField }),
  jsonSchema: { type: 'object', properties: { period: periodProp }, required: [] },
  isMutation: false,
  async handler(input, currentUser, db) {
    const period = input.period ?? currentIstPeriod();
    const today = currentIstDate();
    const all = await tasks.getTasks({ period }, currentUser, db);
    const overdue = all.filter((t) => t.deadline && t.deadline < today && !CLOSED.has(t.status));
    const text = overdue.length
      ? `${overdue.length} overdue task(s) as of ${today}:\n${overdue.map(line).join('\n')}`
      : `No overdue tasks as of ${today}.`;
    return { text, card: { type: 'overdue_list', period, asOf: today, tasks: overdue } };
  },
});

export const getUserWorkloadTool = defineTool({
  name: 'get_user_workload',
  family: 'tasks.read',
  capability: 'viewing workload summaries',
  description:
    'Summarise task workload per assignee for a month: open, overdue, and done counts. A team member sees only their own workload.',
  inputSchema: z.object({ period: periodField }),
  jsonSchema: { type: 'object', properties: { period: periodProp }, required: [] },
  isMutation: false,
  async handler(input, currentUser, db) {
    const period = input.period ?? currentIstPeriod();
    const today = currentIstDate();
    // 🔐 own: a team_member's workload is scoped to their own assigned tasks via
    // the JWT staffId — not an input the model can set.
    const filters =
      currentUser.role === 'team_member'
        ? { period, assigneeId: currentUser.staffId }
        : { period };
    const rows = await tasks.getTasks(filters, currentUser, db);

    const byUser = new Map<string, { staffId: string; name: string; open: number; overdue: number; done: number }>();
    for (const t of rows) {
      for (const a of t.assignees) {
        const e = byUser.get(a.id) ?? { staffId: a.id, name: a.name, open: 0, overdue: 0, done: 0 };
        if (CLOSED.has(t.status)) e.done += 1;
        else {
          e.open += 1;
          if (t.deadline && t.deadline < today) e.overdue += 1;
        }
        byUser.set(a.id, e);
      }
    }
    const users = [...byUser.values()].sort((a, b) => b.open - a.open);
    const text = users.length
      ? `Workload for ${period}:\n${users
          .map((u) => `• ${u.name}: ${u.open} open (${u.overdue} overdue), ${u.done} done`)
          .join('\n')}`
      : `No assigned tasks for ${period}.`;
    return { text, card: { type: 'workload', period, users } };
  },
});

export const getProjectStatusTool = defineTool({
  name: 'get_project_status',
  family: 'tasks.read',
  capability: 'viewing project status',
  // ponytail: TRD §9 lists this tool but does not pin its shape. Task-only BY
  // DESIGN, via the aggregate-subset rule: an aggregate tool's payload must be a
  // subset of what the LEAST-privileged role holding that tool can already see
  // elsewhere. A team_member has get_project_status (✅) but NOT get_content_pipeline
  // (❌), so rolling pipeline stage in would make the bot a side channel around its
  // own permission table. Safe ceiling = tools team_member already holds: tasks,
  // content_calendar, shoot_schedule. In-bounds enrichments if UX wants them: next
  // shoot date, posts scheduled/posted this month. Out of bounds: pipeline stage,
  // client summary, audit. Left as task-health until that call is made.
  description:
    'Report per-project (per-client) status for a month: task totals with done, overdue, and open counts.',
  inputSchema: z.object({ period: periodField }),
  jsonSchema: { type: 'object', properties: { period: periodProp }, required: [] },
  isMutation: false,
  async handler(input, currentUser, db) {
    const period = input.period ?? currentIstPeriod();
    const today = currentIstDate();
    const rows = await tasks.getTasks({ period }, currentUser, db);

    const byClient = new Map<string, { clientId: string | null; clientName: string; total: number; done: number; overdue: number; open: number }>();
    for (const t of rows) {
      const key = t.clientId ?? 'none';
      const e = byClient.get(key) ?? {
        clientId: t.clientId,
        clientName: t.clientName ?? 'No client',
        total: 0,
        done: 0,
        overdue: 0,
        open: 0,
      };
      e.total += 1;
      if (CLOSED.has(t.status)) e.done += 1;
      else {
        e.open += 1;
        if (t.deadline && t.deadline < today) e.overdue += 1;
      }
      byClient.set(key, e);
    }
    const projects = [...byClient.values()].sort((a, b) => b.open - a.open);
    const text = projects.length
      ? `Project status for ${period}:\n${projects
          .map((p) => `• ${p.clientName}: ${p.total} tasks — ${p.done} done, ${p.open} open, ${p.overdue} overdue`)
          .join('\n')}`
      : `No tasks for ${period}.`;
    return { text, card: { type: 'project_status', period, projects } };
  },
});
