/**
 * The 11 query-tool registry. BotService filters this by getPermittedBotTools
 * (STEP 2) before handing the definitions to Anthropic, and dispatches each
 * tool_use block back through getBotTool by name.
 */
import {
  getAttendanceTool,
  getContentCalendarTool,
  getContentPipelineTool,
  getShootScheduleTool,
} from './grids.js';
import { getAuditLogTool, getClientSummaryTool, getHolidayListTool } from './misc.js';
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

const byName = new Map(QUERY_TOOLS.map((t) => [t.name, t]));

export function getBotTool(name: string): BotTool | undefined {
  return byName.get(name);
}

/** Anthropic tool definitions for the permitted subset (by tool name). */
export function anthropicToolDefs(permittedNames: readonly string[]): Anthropic.Tool[] {
  const permitted = new Set(permittedNames);
  return QUERY_TOOLS.filter((t) => permitted.has(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.jsonSchema,
  }));
}
