/**
 * Grid-domain query tools. Each is a thin wrapper over an existing getGrid method
 * called with the JWT `currentUser`, so the isolation already built into those
 * services comes for free — in particular ADR-011: ShootPlannerService.getGrid
 * returns own-slots-only for a freelancer. The structured grid is fed back to the
 * model as the tool_result and carried to the frontend as the card.
 */
import { z } from 'zod';

import { defineTool } from './types.js';
import { AttendanceService } from '../../../services/AttendanceService.js';
import { currentIstPeriod } from '../../../services/BaseService.js';
import { ContentCalendarService } from '../../../services/ContentCalendarService.js';
import { ContentDropperService } from '../../../services/ContentDropperService.js';
import { ShootPlannerService } from '../../../services/ShootPlannerService.js';


const attendance = new AttendanceService();
const shoots = new ShootPlannerService();
const dropper = new ContentDropperService();
const calendar = new ContentCalendarService();

const periodField = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM')
  .optional();
const periodProp = { type: 'string', description: 'Month as YYYY-MM. Defaults to the current IST month.' } as const;
const periodSchema = { type: 'object', properties: { period: periodProp }, required: [] } as const;

/** Feed the model the structured grid, capped so a large month can't blow the
 *  1024-token budget. The full grid still goes to the frontend via the card. */
function asText(header: string, data: unknown): string {
  const json = JSON.stringify(data);
  const body = json.length > 6000 ? `${json.slice(0, 6000)}… (truncated; full data in the card)` : json;
  return `${header}\n${body}`;
}

export const getAttendanceTool = defineTool({
  name: 'get_attendance',
  capability: 'viewing attendance records',
  description: 'Get the attendance grid for a month. A team member sees only their own column.',
  inputSchema: z.object({ period: periodField }),
  jsonSchema: periodSchema,
  isMutation: false,
  async handler(input, currentUser, db) {
    const period = input.period ?? currentIstPeriod();
    const grid = await attendance.getGrid(period, currentUser, db);
    return { text: asText(`Attendance for ${period}:`, grid), card: { type: 'attendance_summary', period, data: grid } };
  },
});

export const getShootScheduleTool = defineTool({
  name: 'get_shoot_schedule',
  capability: 'viewing the shoot schedule',
  description: 'Get the shoot schedule for a month. A freelancer sees only their own slots (ADR-011).',
  inputSchema: z.object({ period: periodField }),
  jsonSchema: periodSchema,
  isMutation: false,
  async handler(input, currentUser, db) {
    const period = input.period ?? currentIstPeriod();
    const grid = await shoots.getGrid(period, currentUser, db);
    return { text: asText(`Shoot schedule for ${period}:`, grid), card: { type: 'shoot_schedule', period, data: grid } };
  },
});

export const getContentPipelineTool = defineTool({
  name: 'get_content_pipeline',
  capability: 'viewing the content pipeline',
  description: 'Get the content pipeline (per-client production stages) for a month.',
  inputSchema: z.object({ period: periodField }),
  jsonSchema: periodSchema,
  isMutation: false,
  async handler(input, currentUser, db) {
    const period = input.period ?? currentIstPeriod();
    const rows = await dropper.getGrid(period, currentUser, db);
    return { text: asText(`Content pipeline for ${period}:`, rows), card: { type: 'pipeline', period, rows } };
  },
});

export const getContentCalendarTool = defineTool({
  name: 'get_content_calendar',
  capability: 'viewing the content calendar',
  description: 'Get the content calendar for a month.',
  inputSchema: z.object({ period: periodField }),
  jsonSchema: periodSchema,
  isMutation: false,
  async handler(input, currentUser, db) {
    const period = input.period ?? currentIstPeriod();
    const grid = await calendar.getGrid(period, currentUser, db);
    return { text: asText(`Content calendar for ${period}:`, grid), card: { type: 'calendar', period, data: grid } };
  },
});
