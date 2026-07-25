/**
 * The 22-tool registry — 11 read (Sprint 8) + 11 mutation (Sprint 9). BotService
 * filters this by getPermittedBotTools before handing the definitions to
 * Anthropic, and dispatches each tool_use block back through getBotTool by name.
 *
 * Mutation tools are grouped by domain in `mutations-*.ts`, mirroring how the
 * query tools are grouped rather than one file per tool.
 */
import {
  getAttendanceTool,
  getContentCalendarTool,
  getContentPipelineTool,
  getShootScheduleTool,
} from './grids.js';
import { getAuditLogTool, getClientSummaryTool, getHolidayListTool } from './misc.js';
import {
  updateCalendarCellTool,
  updatePipelineStageTool,
  updateShootSlotTool,
} from './mutations-grids.js';
import {
  addClientTool,
  addHolidayTool,
  deactivateClientTool,
  removeHolidayTool,
} from './mutations-misc.js';
import {
  assignTaskTool,
  createTaskTool,
  setDeadlineTool,
  updateTaskStatusTool,
} from './mutations-tasks.js';
import {
  getProjectStatusTool,
  getUserWorkloadTool,
  listOverdueTasksTool,
  listTasksTool,
} from './tasks.js';

import type { BotTool } from './types.js';
import type Anthropic from '@anthropic-ai/sdk';

export const QUERY_TOOLS: BotTool[] = [
  getProjectStatusTool,
  listTasksTool,
  listOverdueTasksTool,
  getUserWorkloadTool,
  getAttendanceTool,
  getShootScheduleTool,
  getContentPipelineTool,
  getContentCalendarTool,
  getAuditLogTool,
  getHolidayListTool,
  getClientSummaryTool,
];

/** TRD §9.3. Every one carries isMutation: true (set by defineMutationTool), so
 *  Sprint 9's turn-1 interceptor catches them all without a second list. */
export const MUTATION_TOOLS: BotTool[] = [
  updateTaskStatusTool,
  createTaskTool,
  assignTaskTool,
  setDeadlineTool,
  updatePipelineStageTool,
  updateShootSlotTool,
  updateCalendarCellTool,
  addHolidayTool,
  removeHolidayTool,
  addClientTool,
  deactivateClientTool,
];

export const ALL_TOOLS: BotTool[] = [...QUERY_TOOLS, ...MUTATION_TOOLS];

const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function getBotTool(name: string): BotTool | undefined {
  return byName.get(name);
}

/**
 * Human-readable capability phrases for a set of tool names — what the system
 * prompt names as DENIED (Sprint 8.1). Unknown names are dropped rather than
 * echoed: a raw tool name in the prompt would leak the internal tool surface.
 */
export function capabilityPhrases(names: readonly string[]): string[] {
  return names.map((n) => byName.get(n)?.capability).filter((c): c is string => Boolean(c));
}

/** Anthropic tool definitions for the permitted subset (by tool name). */
export function anthropicToolDefs(permittedNames: readonly string[]): Anthropic.Tool[] {
  const permitted = new Set(permittedNames);
  return ALL_TOOLS.filter((t) => permitted.has(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.jsonSchema,
  }));
}
