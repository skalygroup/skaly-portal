/**
 * Grid-domain MUTATION tools: content pipeline, shoot schedule, content calendar.
 *
 * These are the two versioned targets in the portal, so this is where ADR-014 §2
 * earns its place: `readCurrent` returns the `version` seen when the summary was
 * built, it is stored in the pending record, and turn 2 sends it. Without that the
 * bot would read-then-write and become last-write-wins, silently undoing C-02 for
 * every bot-mediated edit — a human editing the same row between the summary and
 * the "yes" must produce an honest 409, not a lost update.
 *
 * `shoot_schedules` is UNVERSIONED (ADR-008) and captures nothing; its forward-only
 * transition validation passes through from the service.
 */
import { z } from 'zod';

import { defineMutationTool } from './types.js';
import { ContentCalendarService } from '../../../services/ContentCalendarService.js';
import { ContentDropperService } from '../../../services/ContentDropperService.js';
import { ShootPlannerService } from '../../../services/ShootPlannerService.js';
import { TaskService } from '../../../services/TaskService.js';
import { formatCalendarDate } from '../confirmation.js';

import type { CalendarStatus } from '@skaly/shared';

const dropper = new ContentDropperService();
const planner = new ShootPlannerService();
const calendar = new ContentCalendarService();
/** Only for resolveActiveStaff — the freelancer-id → name lookup, which is the
 *  same active-staff check the write performs. */
const staffTasks = new TaskService();

const uuid = z.string().uuid();
const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

const STAGES = ['raw', 'finals', 'posted'] as const;
const STAGE_LABEL: Record<(typeof STAGES)[number], string> = {
  raw: 'RAW received',
  finals: 'Finals ready',
  posted: 'Posted',
};
const SLOT_STATUSES = ['Unset', 'Scheduled', 'Confirmed', 'Completed'] as const;
const CALENDAR_STATUS_VALUES = [
  'No Activity',
  'Shoot Day',
  'Editing',
  'Ready to Post',
  'Posted',
  'Cancelled',
] as const;

export const updatePipelineStageTool = defineMutationTool({
  name: 'update_pipeline_stage',
  capability: 'updating content pipeline stages',
  description:
    "Mark a content pipeline stage complete for a client's month. Stages must be completed in order (raw → finals → posted). Look the pipeline row up with get_content_pipeline first to get its id.",
  inputSchema: z.object({ pipelineId: uuid, stage: z.enum(STAGES) }),
  jsonSchema: {
    type: 'object',
    properties: {
      pipelineId: { type: 'string', description: 'The pipeline row id, from get_content_pipeline.' },
      stage: { type: 'string', enum: [...STAGES] },
    },
    required: ['pipelineId', 'stage'],
  },
  // VERSIONED: the version captured here is what turn 2 sends.
  async readCurrent(input, _currentUser, db) {
    const row = await dropper.getRow(input.pipelineId, db);
    return {
      state: {
        clientName: row.clientName,
        period: row.period,
        status: row.status,
        stagesComplete: row.stagesComplete,
      },
      version: row.version,
    };
  },
  summary: {
    entity: 'Content pipeline',
    action: (input) => `Mark ${STAGE_LABEL[input.stage]}`,
    target: (state) => state.clientName,
    period: (_input, state) => state.period,
    changes: [{ field: 'Stage', from: (s) => `${s.status} (${s.stagesComplete} of 3)`, to: (i) => STAGE_LABEL[i.stage] }],
  },
  async handler(input, currentUser, db, expectedVersion) {
    // expectedVersion is non-optional at the service; the interceptor always
    // supplies it for a versioned tool, and `?? 0` would silently force a 409.
    if (expectedVersion === undefined) {
      throw new Error('update_pipeline_stage requires the version captured at turn 1');
    }
    const result = await dropper.updateStage(input.pipelineId, input.stage, currentUser, expectedVersion, db);
    return { text: `${result.clientName} is now at ${result.status}.`, card: { type: 'mutation_result' }, link: `/content-dropper?period=${result.period}` };
  },
});

export const updateShootSlotTool = defineMutationTool({
  name: 'update_shoot_slot',
  capability: 'updating the shoot schedule',
  description:
    'Update a shoot slot — its status, date, freelancer or expected pieces. Status moves forward one step at a time (Unset → Scheduled → Confirmed → Completed). Look the slot up with get_shoot_schedule first to get its id.',
  inputSchema: z
    .object({
      slotId: uuid,
      slotStatus: z.enum(SLOT_STATUSES).optional(),
      slotDate: dateField.optional(),
      freelancerId: uuid.nullable().optional(),
      piecesExpected: z.number().int().min(1).optional(),
    })
    .refine(
      (v) =>
        v.slotStatus !== undefined ||
        v.slotDate !== undefined ||
        v.freelancerId !== undefined ||
        v.piecesExpected !== undefined,
      { message: 'Provide at least one field to change.' },
    ),
  jsonSchema: {
    type: 'object',
    properties: {
      slotId: { type: 'string', description: 'The shoot slot id, from get_shoot_schedule.' },
      slotStatus: { type: 'string', enum: [...SLOT_STATUSES] },
      slotDate: { type: 'string', description: 'Shoot date as YYYY-MM-DD.' },
      freelancerId: { type: 'string', description: 'Freelancer staff id, or null to unassign.' },
      piecesExpected: { type: 'number', description: 'Pieces expected from this shoot.' },
    },
    required: ['slotId'],
  },
  // UNVERSIONED (ADR-008) — no version captured, last-write-wins as designed.
  async readCurrent(input, currentUser, db) {
    const slot = await planner.getSlot(input.slotId, currentUser, db);
    // The input carries a freelancerId; the card must show the person's name.
    // `null` is a real value here — it means "unassign" — so only a defined,
    // non-null id needs resolving.
    const assigned =
      input.freelancerId != null
        ? await staffTasks.resolveActiveStaff([input.freelancerId], db)
        : [];
    return {
      state: {
        clientName: slot.clientName,
        period: slot.period,
        slotIndex: slot.slotIndex,
        slotStatus: slot.slotStatus,
        slotDate: slot.slotDate,
        freelancerName: slot.freelancerName,
        piecesExpected: slot.piecesExpected,
        newFreelancerName: assigned[0]?.name ?? null,
      },
    };
  },
  summary: {
    entity: 'Shoot slot',
    action: (input) => (input.slotStatus ? `Set shoot slot to ${input.slotStatus}` : 'Update shoot slot'),
    target: (state) => `${state.clientName} — slot ${state.slotIndex}`,
    period: (_input, state) => state.period,
    // Every field the input can touch is listed; the ones it did not touch render
    // from → to as the same value, which reads correctly as "unchanged".
    changes: [
      { field: 'Status', from: (s) => s.slotStatus, to: (i) => i.slotStatus },
      { field: 'Date', from: (s) => s.slotDate, to: (i) => i.slotDate },
      {
        field: 'Freelancer',
        from: (s) => s.freelancerName,
        // Untouched → show the current name back. Explicit null → unassigning.
        to: (i, s) => (i.freelancerId === undefined ? s.freelancerName : s.newFreelancerName),
      },
      { field: 'Pieces expected', from: (s) => s.piecesExpected, to: (i) => i.piecesExpected },
    ],
  },
  async handler(input, currentUser, db) {
    const { slotId, ...patch } = input;
    const result = await planner.update(slotId, patch, currentUser, db);
    return { text: `Slot ${result.slotIndex} for ${result.clientName} is now ${result.slotStatus}.`, card: { type: 'mutation_result' }, link: `/shoot-planner?period=${result.period}` };
  },
});

export const updateCalendarCellTool = defineMutationTool({
  name: 'update_calendar_cell',
  capability: 'updating the content calendar',
  description:
    "Change a content calendar cell's status or note for one client on one date. Look the cell up with get_content_calendar first to get its id.",
  inputSchema: z
    .object({
      cellId: uuid,
      status: z.enum(CALENDAR_STATUS_VALUES).optional(),
      note: z.string().max(500).nullable().optional(),
    })
    .refine((v) => v.status !== undefined || v.note !== undefined, {
      message: 'Provide at least one of status or note.',
    }),
  jsonSchema: {
    type: 'object',
    properties: {
      cellId: { type: 'string', description: 'The calendar cell id, from get_content_calendar.' },
      status: { type: 'string', enum: [...CALENDAR_STATUS_VALUES] },
      note: { type: 'string', description: 'Cell note, or null to clear it.' },
    },
    required: ['cellId'],
  },
  // VERSIONED, and the reason ADR-013 case 2 matters: updateCell's same-statement
  // source='manual' auto-reset bumps the version, so a captured one is mandatory.
  async readCurrent(input, currentUser, db) {
    const cell = await calendar.getCell(input.cellId, currentUser, db);
    return {
      state: {
        clientName: cell.clientName,
        period: cell.period,
        date: cell.date,
        status: cell.status,
        note: cell.note,
      },
      version: cell.version,
    };
  },
  summary: {
    entity: 'Calendar cell',
    action: (input) => (input.status ? `Set calendar cell to ${input.status}` : 'Update calendar note'),
    // Dates in `target` are formatted here: buildSummary renders `changes` values,
    // but a target string is assembled by the spec and would otherwise show raw ISO.
    target: (state) => `${state.clientName} — ${formatCalendarDate(state.date)}`,
    period: (_input, state) => state.period,
    changes: [
      { field: 'Status', from: (s) => s.status, to: (i) => i.status },
      { field: 'Note', from: (s) => s.note, to: (i) => i.note },
    ],
  },
  async handler(input, currentUser, db, expectedVersion) {
    if (expectedVersion === undefined) {
      throw new Error('update_calendar_cell requires the version captured at turn 1');
    }
    const { cellId, ...patch } = input;
    // Straight through updateCell — never a raw write. The auto-reset to
    // source='manual' and the version bump are its job (ADR-013 case 2).
    const result = await calendar.updateCell(
      cellId,
      patch as { status?: CalendarStatus; note?: string | null },
      currentUser,
      expectedVersion,
      db,
    );
    // The cell's period is the month of its date — content_calendar has both, and
    // CalendarCellDTO exposes the date.
    return {
      text: `Calendar cell is now ${result.status}.`,
      card: { type: 'mutation_result' },
      link: `/content-calendar?period=${result.date.slice(0, 7)}`,
    };
  },
});
