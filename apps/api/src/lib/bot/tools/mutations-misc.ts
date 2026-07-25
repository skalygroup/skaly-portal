/**
 * Remaining MUTATION tools: holidays and clients.
 *
 * `remove_holiday` goes through `HolidayService.remove` and nothing else. That
 * method reverts the date's holiday attendance rows back to working in the SAME
 * transaction — audit H-01, and the entire point of the finding. A "simpler" tool
 * that just deactivated the holiday row would leave a phantom gold, non-interactive
 * day in the attendance grid, which is the bug H-01 describes.
 *
 * `add_client` / `deactivate_client` sit on ClientService.create / deactivate
 * (Sprint 9 STEP 2). create is refused with 423 when the current month is locked
 * (ADR-017) — that inherits here for free.
 */
import { z } from 'zod';

import { defineMutationTool } from './types.js';
import { AppError } from '../../../lib/errors.js';
import { getCurrentPeriod } from '../../../services/BaseService.js';
import { ClientService } from '../../../services/ClientService.js';
import { HolidayService } from '../../../services/HolidayService.js';
import { formatCalendarDateWithWeekday } from '../confirmation.js';

import type { ClientListItem } from '../../../services/ClientService.js';

const holidays = new HolidayService();
const clients = new ClientService();

const uuid = z.string().uuid();
const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

export const addHolidayTool = defineMutationTool({
  name: 'add_holiday',
  capability: 'adding holidays',
  description:
    "Add a holiday on a date. Everyone's attendance for that date flips from working to holiday.",
  inputSchema: z.object({ date: dateField, name: z.string().min(1).max(100) }),
  jsonSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'The holiday date as YYYY-MM-DD.' },
      name: { type: 'string', description: 'What the holiday is called, e.g. "Diwali".' },
    },
    required: ['date', 'name'],
  },
  // Nothing to load — the holiday does not exist yet. The period comes from the
  // date so the summary can state which month is affected.
  readCurrent: (input) => Promise.resolve({ state: { period: input.date.slice(0, 7) } }),
  summary: {
    entity: 'Holiday',
    action: (input) => `Add the holiday "${input.name}"`,
    target: (state) => `Everyone's attendance in ${state.period}`,
    period: (_input, state) => state.period,
    changes: [
      // With the weekday: a holiday on a Sunday flips nothing, and the user should
      // be able to see that before approving it.
      { field: 'Date', from: () => null, to: (i) => formatCalendarDateWithWeekday(i.date) },
      { field: 'Holiday', from: () => null, to: (i) => i.name },
    ],
  },
  async handler(input, currentUser, db) {
    const period = input.date.slice(0, 7);
    await db
      .transaction()
      .execute((trx) => holidays.create({ period, date: input.date, name: input.name, currentUser, trx }));
    return { text: `Added ${input.name} on ${input.date}.`, card: { type: 'mutation_result' }, link: `/attendance?period=${period}` };
  },
});

export const removeHolidayTool = defineMutationTool({
  name: 'remove_holiday',
  capability: 'removing holidays',
  description:
    'Remove a holiday. That date goes back to being a working day for everyone. Look it up with get_holiday_list first to get its id.',
  inputSchema: z.object({ holidayId: uuid }),
  jsonSchema: {
    type: 'object',
    properties: { holidayId: { type: 'string', description: 'The holiday id, from get_holiday_list.' } },
    required: ['holidayId'],
  },
  async readCurrent(input, _currentUser, db) {
    // list() is per-period, so resolve the period from the row first. A removed or
    // unknown id 404s here, at turn 1, before any pending state exists.
    const { period } = await getCurrentPeriod(db);
    const found = (await holidays.list(period, db)).find((h) => h.id === input.holidayId);
    if (!found) {
      throw new AppError('RESOURCE_NOT_FOUND', `Active holiday ${input.holidayId} does not exist.`);
    }
    return { state: { period: found.period, date: found.date, name: found.name } };
  },
  summary: {
    entity: 'Holiday',
    action: (_input) => 'Remove a holiday',
    target: (state) => `${state.name} on ${formatCalendarDateWithWeekday(state.date)}`,
    period: (_input, state) => state.period,
    changes: [{ field: 'Day type', from: () => 'Holiday', to: () => 'Working' }],
  },
  async handler(input, currentUser, db) {
    // Straight through remove — the attendance revert rides its transaction (H-01).
    await db.transaction().execute((trx) => holidays.remove(input.holidayId, currentUser, trx));
    return { text: 'Holiday removed and the day is back to working.', card: { type: 'mutation_result' }, link: '/attendance' };
  },
});

export const addClientTool = defineMutationTool({
  name: 'add_client',
  capability: 'adding clients',
  description:
    "Add a client. Their shoot slots, pipeline row and calendar cells for the current month are created at the same time, so the monthly shoot slot count is required.",
  inputSchema: z.object({
    name: z.string().min(1).max(120),
    shootSlotsPerMonth: z.number().int().min(1).max(20),
    piecesPerVisit: z.number().int().min(1).optional(),
    isInternal: z.boolean().optional(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The client name.' },
      shootSlotsPerMonth: { type: 'number', description: 'Shoots per month, 1 to 20. Required.' },
      piecesPerVisit: { type: 'number', description: 'Pieces expected per shoot. Defaults to 1.' },
      isInternal: { type: 'boolean', description: 'Internal clients get no shoot, pipeline or calendar rows.' },
    },
    required: ['name', 'shootSlotsPerMonth'],
  },
  async readCurrent(_input, _currentUser, db) {
    const { period } = await getCurrentPeriod(db);
    return { state: { period } };
  },
  summary: {
    entity: 'Client',
    action: (input) => `Add the client "${input.name}"`,
    target: (state) => `Onboarding into ${state.period}`,
    period: (_input, state) => state.period,
    changes: [
      { field: 'Name', from: () => null, to: (i) => i.name },
      { field: 'Shoots per month', from: () => null, to: (i) => i.shootSlotsPerMonth },
      { field: 'Pieces per shoot', from: () => null, to: (i) => i.piecesPerVisit ?? 1 },
      { field: 'Internal', from: () => null, to: (i) => i.isInternal ?? false },
    ],
  },
  async handler(input, currentUser, db) {
    const result: ClientListItem = await clients.create(input, currentUser, db);
    return { text: `Added ${result.name}.`, card: { type: 'mutation_result' }, link: '/settings/clients' };
  },
});

export const deactivateClientTool = defineMutationTool({
  name: 'deactivate_client',
  capability: 'deactivating clients',
  description:
    'Deactivate a client. They stop appearing in future months; everything already recorded for them is kept. Look them up with get_client_summary first to get their id.',
  inputSchema: z.object({ clientId: uuid }),
  jsonSchema: {
    type: 'object',
    properties: { clientId: { type: 'string', description: 'The client id, from get_client_summary.' } },
    required: ['clientId'],
  },
  async readCurrent(input, _currentUser, db) {
    const found = (await clients.list({ includeInactive: true }, db)).find((c) => c.id === input.clientId);
    if (!found) {
      throw new AppError('RESOURCE_NOT_FOUND', `clients row ${input.clientId} does not exist.`);
    }
    return { state: { name: found.name, active: found.active } };
  },
  summary: {
    entity: 'Client',
    action: () => 'Deactivate a client',
    target: (state) => state.name,
    changes: [{ field: 'Active', from: (s) => s.active, to: () => false }],
  },
  async handler(input, currentUser, db) {
    await clients.deactivate(input.clientId, currentUser, db);
    return { text: 'Client deactivated. Their history is unchanged.', card: { type: 'mutation_result' }, link: '/settings/clients' };
  },
});
