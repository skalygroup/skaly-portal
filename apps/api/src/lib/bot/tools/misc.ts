/**
 * Remaining query tools: holidays, client summary, audit log. get_audit_log is
 * admin-only — the permission filter already excludes it for everyone else, and
 * the handler asserts it too (defence in depth). A PERMISSION_DENIED here is
 * mapped to the friendly refusal by BotService (Error-Handling §6).
 */
import { z } from 'zod';

import { defineTool } from './types.js';
import { AppError } from '../../../lib/errors.js';
import { AuditService } from '../../../services/AuditService.js';
import { currentIstPeriod } from '../../../services/BaseService.js';
import { ClientService } from '../../../services/ClientService.js';
import { HolidayService } from '../../../services/HolidayService.js';


const holidays = new HolidayService();
const clients = new ClientService();
const audit = new AuditService();

const periodField = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM')
  .optional();

export const getHolidayListTool = defineTool({
  name: 'get_holiday_list',
  family: 'holidays.read',
  capability: 'viewing the holiday list',
  description: 'List the holidays configured for a month (defaults to the current month).',
  inputSchema: z.object({ period: periodField }),
  jsonSchema: {
    type: 'object',
    properties: { period: { type: 'string', description: 'Month as YYYY-MM. Defaults to the current IST month.' } },
    required: [],
  },
  isMutation: false,
  async handler(input, _currentUser, db) {
    const period = input.period ?? currentIstPeriod();
    const list = await holidays.list(period, db);
    const text = list.length
      ? `Holidays for ${period}:\n${JSON.stringify(list)}`
      : `No holidays configured for ${period}.`;
    return { text, card: { type: 'holiday_list', period, holidays: list } };
  },
});

export const getClientSummaryTool = defineTool({
  name: 'get_client_summary',
  family: 'clients.read',
  capability: 'viewing the client list',
  description:
    'Summarise the clients (id and name). Pass includeInactive to also see deactivated ones — needed to reactivate a client.',
  inputSchema: z.object({ includeInactive: z.boolean().optional() }),
  jsonSchema: {
    type: 'object',
    properties: { includeInactive: { type: 'boolean', description: 'Include deactivated clients. Defaults to false.' } },
    required: [],
  },
  isMutation: false,
  async handler(input, _currentUser, db) {
    const list = await clients.list({ includeInactive: input.includeInactive ?? false }, db);
    const text = list.length ? `${list.length} client(s):\n${JSON.stringify(list)}` : 'No clients found.';
    return { text, card: { type: 'client_summary', clients: list } };
  },
});

export const getAuditLogTool = defineTool({
  name: 'get_audit_log',
  family: 'audit.read',
  capability: 'viewing the audit log',
  description: 'Read the most recent audit-log entries (admin only). Optionally filter by table name.',
  inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional(), tableName: z.string().optional() }),
  jsonSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'How many entries to return (1-100, default 20).' },
      tableName: { type: 'string', description: 'Filter to one table, e.g. "tasks" or "user_permissions".' },
    },
    required: [],
  },
  isMutation: false,
  async handler(input, currentUser, db) {
    // Defence in depth — the service asserts admin too (for the Sprint 11 UI path).
    if (currentUser.role !== 'admin') {
      throw new AppError('PERMISSION_DENIED', 'The audit log is available to admins only.');
    }
    const { entries, hasMore } = await audit.query(
      { callerRole: currentUser.role, limit: input.limit, tableName: input.tableName },
      db,
    );
    // Feed the model the projected human summaries — never the raw JSONB diffs.
    const text = entries.length
      ? `${entries.length} audit entr${entries.length === 1 ? 'y' : 'ies'}${hasMore ? ' (more available)' : ''}:\n${entries
          .map((e) => `${e.summary} — ${e.createdAt}`)
          .join('\n')}`
      : 'No audit entries found.';
    return { text, card: { type: 'audit_log', entries, hasMore } };
  },
});
