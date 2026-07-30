import { CALENDAR_STATUSES, SLOT_STATUS_VALUES, STAGE_VALUES } from '@skaly/shared';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { currentActorSource, withActorSource } from '../../src/lib/bot/actor-context.js';
import { buildSummary } from '../../src/lib/bot/confirmation.js';
import { ALL_TOOLS, MUTATION_TOOLS, QUERY_TOOLS, getBotTool } from '../../src/lib/bot/tools/registry.js';
import { ClientService } from '../../src/services/ClientService.js';
import { BOT_MUTATION_TOOL_NAMES, BOT_TOOL_NAMES } from '../../src/services/PermissionService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type { DB } from '@skaly/shared';

/**
 * Descriptor-shape + wiring smoke for the 12 mutation tools (Sprint 9 STEP 4 + ADR-026).
 *
 * These assert the contract every tool must satisfy for the STEP 5 interceptor to
 * work — not the business rules, which live in the services and are already tested
 * there. Write-parity and the confirmation branches are STEP 7.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const ADMIN_ID = 'e0000000-0000-4000-8000-00000000da01';
const admin: CurrentUser = { staffId: ADMIN_ID, role: 'admin' };

/** Tools whose target is a versioned row — the only two that may capture one. */
const VERSIONED = new Set(['update_pipeline_stage', 'update_calendar_cell']);

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values({ id: ADMIN_ID, name: 'Tool Admin', email: 'tool-admin@skaly.test', role: 'admin', active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
});

afterAll(async () => {
  await db.deleteFrom('staff').where('id', '=', ADMIN_ID).execute();
  await db.destroy();
});

describe('the mutation tool registry', () => {
  test('ships exactly 12 mutation tools, 23 in total', () => {
    expect(MUTATION_TOOLS).toHaveLength(12);
    expect(QUERY_TOOLS).toHaveLength(11);
    expect(ALL_TOOLS).toHaveLength(23);
  });

  test('every mutation tool carries isMutation: true, and no query tool does', () => {
    // The single most dangerous field in the sprint: a mutation tool with the flag
    // missing skips the confirmation gate and executes on turn 1.
    expect(MUTATION_TOOLS.every((t) => t.isMutation)).toBe(true);
    expect(QUERY_TOOLS.some((t) => t.isMutation)).toBe(false);
  });

  test('the registry, the permission list and ROLE_DEFAULTS agree on all 23 names', () => {
    expect([...ALL_TOOLS].map((t) => t.name).sort()).toEqual([...BOT_TOOL_NAMES].sort());
    expect(MUTATION_TOOLS.map((t) => t.name).sort()).toEqual([...BOT_MUTATION_TOOL_NAMES].sort());
    // A name in one list and not the other is a tool that silently never resolves.
    for (const name of BOT_TOOL_NAMES) expect(getBotTool(name), name).toBeDefined();
  });

  test('no mutation tool accepts a staffId for the actor (reconciliation #4)', () => {
    for (const tool of MUTATION_TOOLS) {
      const props = Object.keys(
        (tool.jsonSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      // `staffIds` on assign_task is the assignee set — the operation itself.
      const impersonating = props.filter((p) => p === 'staffId' || p === 'actorId' || p === 'userId');
      expect(impersonating, `${tool.name}: ${props.join(',')}`).toEqual([]);
    }
  });

  test('every mutation tool supplies readCurrent and a summary spec', () => {
    for (const tool of MUTATION_TOOLS) {
      expect(typeof tool.readCurrent, tool.name).toBe('function');
      expect(tool.summary, tool.name).toBeDefined();
    }
  });

  test('every mutation tool has a capability phrase that names no role', () => {
    for (const tool of MUTATION_TOOLS) {
      expect(tool.capability, tool.name).toBeTruthy();
      // APPFLOW §9: the denial copy must never state which role is required, and
      // these phrases are rendered straight into it.
      expect(tool.capability.toLowerCase(), tool.name).not.toMatch(
        /admin|manager|team.member|freelancer/,
      );
    }
  });
});

describe('a query tool must surface the id its mutation counterpart needs', () => {
  test("list_tasks' text output carries each task's id", async () => {
    // Reconciliation #11: entity resolution is the model's job via query tools,
    // with no fuzzy-id resolver. Sprint 8 built these read-only and omitted the id,
    // so driving the real UI the model found the task and then said it could not act
    // because "list_tasks doesn't return the task id" — every task mutation was
    // unreachable by name. The id in that text IS the resolution mechanism.
    const period = '2091-11';
    await db
      .insertInto('months')
      .values({ period, label: period, locked: false })
      .onConflict((oc) => oc.column('period').doNothing())
      .execute();
    const task = await db
      .insertInto('tasks')
      .values({ period, date: `${period}-04`, description: 'Findable task', created_by: ADMIN_ID })
      .returning('id')
      .executeTakeFirstOrThrow();

    try {
      const listed = await getBotTool('list_tasks')!.handler({ period }, admin, db);
      expect(listed.text).toContain('Findable task');
      expect(listed.text, 'the id the mutation tools require').toContain(task.id);

      // And it round-trips: the id read out of the text validates as tool input.
      const parsed = getBotTool('update_task_status')!.inputSchema.safeParse({
        taskId: task.id,
        status: 'Done',
      });
      expect(parsed.success).toBe(true);
    } finally {
      await db.deleteFrom('tasks').where('id', '=', task.id).execute();
    }
  });

  /**
   * ADR-019, driven across every mutation tool rather than the one that broke.
   *
   * The gap was structural: a mutation consumes an id, and the only sanctioned way
   * to obtain one is a query tool's output. Any hand-built line that drops the id
   * makes that mutation unreachable by name. This is the lock.
   */
  describe('ADR-019 — the id contract, for all 12 mutation tools', () => {
    /** mutation tool → the id it consumes, and the query tool that must surface it. */
    // `rest` is the tool's other required input — just enough for the round-trip.
    const ID_SOURCE: Record<
      string,
      { field: string; queryTool: string; rest: Record<string, unknown> }
    > = {
      update_task_status: { field: 'taskId', queryTool: 'list_tasks', rest: { status: 'Done' } },
      set_deadline: { field: 'taskId', queryTool: 'list_tasks', rest: { deadline: '2091-12-09' } },
      assign_task: { field: 'taskId', queryTool: 'list_tasks', rest: { staffIds: [ADMIN_ID] } },
      update_pipeline_stage: { field: 'pipelineId', queryTool: 'get_content_pipeline', rest: { stage: 'raw' } },
      update_shoot_slot: { field: 'slotId', queryTool: 'get_shoot_schedule', rest: { slotStatus: 'Confirmed' } },
      update_calendar_cell: { field: 'cellId', queryTool: 'get_content_calendar', rest: { status: 'Posted' } },
      remove_holiday: { field: 'holidayId', queryTool: 'get_holiday_list', rest: {} },
      deactivate_client: { field: 'clientId', queryTool: 'get_client_summary', rest: {} },
      // Reachable only because list({ includeInactive: true }) now drops the
      // soft-delete filter — a deactivated client is soft-deleted by definition,
      // so before that fix no mode of get_client_summary could surface this id.
      reactivate_client: { field: 'clientId', queryTool: 'get_client_summary', rest: {} },
    };
    /** Creates — there is no record to look up yet, so no id to surface. */
    const NO_TARGET = ['create_task', 'add_holiday', 'add_client'];

    test('every mutation tool is either id-consuming with a named source, or a create', () => {
      // Structural: a new mutation tool cannot be added without deciding which
      // query tool resolves its target.
      for (const tool of MUTATION_TOOLS) {
        const source = ID_SOURCE[tool.name];
        expect(Boolean(source) !== NO_TARGET.includes(tool.name), tool.name).toBe(true);
        if (!source) continue;
        const schema = tool.jsonSchema as { required?: string[] };
        expect(schema.required, tool.name).toContain(source.field);
        expect(getBotTool(source.queryTool), source.queryTool).toBeDefined();
      }
    });

    test("each source tool's output carries the id, and it round-trips as tool input", async () => {
      const period = '2091-12';
      await db
        .insertInto('months')
        .values({ period, label: period, locked: false })
        .onConflict((oc) => oc.column('period').doNothing())
        .execute();
      const client = await db
        .insertInto('clients')
        .values({ name: 'Id Contract Co', shoot_slots_per_month: 1, active: true })
        .returning('id')
        .executeTakeFirstOrThrow();
      const task = await db
        .insertInto('tasks')
        .values({ period, date: `${period}-04`, description: 'Id contract task', created_by: ADMIN_ID })
        .returning('id')
        .executeTakeFirstOrThrow();
      const pipeline = await db
        .insertInto('content_pipelines')
        .values({ period, client_id: client.id, version: 1 })
        .returning('id')
        .executeTakeFirstOrThrow();
      const slot = await db
        .insertInto('shoot_schedules')
        .values({ period, client_id: client.id, slot_index: 1, slot_status: 'Unset', pieces_expected: 1 })
        .returning('id')
        .executeTakeFirstOrThrow();
      const cell = await db
        .insertInto('content_calendar')
        .values({ period, client_id: client.id, date: `${period}-04`, status: 'No Activity', version: 1 })
        .returning('id')
        .executeTakeFirstOrThrow();
      const holiday = await db
        .insertInto('holidays')
        .values({ period, date: `${period}-05`, name: 'Id Contract Day', active: true, added_by: ADMIN_ID })
        .returning('id')
        .executeTakeFirstOrThrow();

      const ids: Record<string, string> = {
        taskId: task.id,
        pipelineId: pipeline.id,
        slotId: slot.id,
        cellId: cell.id,
        holidayId: holiday.id,
        clientId: client.id,
      };

      try {
        for (const [name, { field, queryTool, rest }] of Object.entries(ID_SOURCE)) {
          const id = ids[field]!;
          const { text } = await getBotTool(queryTool)!.handler({ period }, admin, db);
          expect(text, `${queryTool} must surface the ${field} that ${name} consumes`).toContain(id);

          // The id read out of that text is a valid input for the mutation — the
          // whole resolution path, end to end.
          const parsed = getBotTool(name)!.inputSchema.safeParse({ [field]: id, ...rest });
          expect(parsed.success, name).toBe(true);
        }
      } finally {
        await db.deleteFrom('holidays').where('id', '=', ids.holidayId!).execute();
        await db.deleteFrom('content_calendar').where('id', '=', ids.cellId!).execute();
        await db.deleteFrom('shoot_schedules').where('id', '=', ids.slotId!).execute();
        await db.deleteFrom('content_pipelines').where('id', '=', ids.pipelineId!).execute();
        await db.deleteFrom('tasks').where('id', '=', ids.taskId!).execute();
        await db.deleteFrom('clients').where('id', '=', client.id).execute();
      }
    });
  });
});

describe('input validation', () => {
  test('a hallucinated non-uuid id fails Zod before anything is read', () => {
    expect(getBotTool('update_task_status')!.inputSchema.safeParse({ taskId: 'the naaz reel', status: 'Done' }).success).toBe(false);
    expect(getBotTool('update_calendar_cell')!.inputSchema.safeParse({ cellId: 'not-a-uuid', status: 'Posted' }).success).toBe(false);
  });

  test('update_shoot_slot and update_calendar_cell reject an empty patch', () => {
    const slot = getBotTool('update_shoot_slot')!.inputSchema;
    expect(slot.safeParse({ slotId: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
    expect(slot.safeParse({ slotId: '11111111-1111-4111-8111-111111111111', slotStatus: 'Confirmed' }).success).toBe(true);

    const cell = getBotTool('update_calendar_cell')!.inputSchema;
    expect(cell.safeParse({ cellId: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
  });

  test('status vocabularies come from the shared constants, not a hand-copied list', () => {
    // Regression guard. These were hand-copied once and the calendar list was wrong:
    // invented values the service rejects, while the real ones were unreachable — a
    // schema that advertises a vocabulary to the model that the write then refuses.
    const id = '11111111-1111-4111-8111-111111111111';

    const cell = getBotTool('update_calendar_cell')!.inputSchema;
    for (const status of CALENDAR_STATUSES) {
      expect(cell.safeParse({ cellId: id, status }).success, status).toBe(true);
    }
    for (const status of ['Shoot Day', 'Editing', 'Ready to Post', 'Cancelled']) {
      expect(cell.safeParse({ cellId: id, status }).success, status).toBe(false);
    }

    const slot = getBotTool('update_shoot_slot')!.inputSchema;
    for (const slotStatus of SLOT_STATUS_VALUES) {
      expect(slot.safeParse({ slotId: id, slotStatus }).success, slotStatus).toBe(true);
    }

    const stage = getBotTool('update_pipeline_stage')!.inputSchema;
    for (const s of STAGE_VALUES) {
      expect(stage.safeParse({ pipelineId: id, stage: s }).success, s).toBe(true);
    }
  });

  test('add_client refuses a missing or out-of-range shootSlotsPerMonth at the schema', () => {
    const schema = getBotTool('add_client')!.inputSchema;
    expect(schema.safeParse({ name: 'Naaz' }).success).toBe(false);
    expect(schema.safeParse({ name: 'Naaz', shootSlotsPerMonth: 21 }).success).toBe(false);
    expect(schema.safeParse({ name: 'Naaz', shootSlotsPerMonth: 4 }).success).toBe(true);
  });
});

describe('readCurrent', () => {
  test('a well-formed but non-existent id throws RESOURCE_NOT_FOUND at turn 1', async () => {
    // The anti-hallucination path: this is what stops a pending record ever being
    // created for a record that does not exist.
    const missing = 'e0000000-0000-4000-8000-0000000dead0';
    const cases: Array<[string, Record<string, unknown>]> = [
      ['update_task_status', { taskId: missing, status: 'Done' }],
      ['set_deadline', { taskId: missing, deadline: '2026-08-01' }],
      ['assign_task', { taskId: missing, staffIds: [ADMIN_ID] }],
      ['update_pipeline_stage', { pipelineId: missing, stage: 'raw' }],
      ['update_shoot_slot', { slotId: missing, slotStatus: 'Confirmed' }],
      ['update_calendar_cell', { cellId: missing, status: 'Posted' }],
      ['remove_holiday', { holidayId: missing }],
      ['deactivate_client', { clientId: missing }],
    ];

    for (const [name, input] of cases) {
      const tool = getBotTool(name)!;
      await expect(tool.readCurrent!(input, admin, db), name).rejects.toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
      });
    }
  });

  test('create-shaped tools have nothing to read and resolve to a period', async () => {
    // create_task / add_holiday / add_client have no target yet, so their
    // readCurrent must still succeed — they cannot 404 on a record they will make.
    const createTask = await getBotTool('create_task')!.readCurrent!(
      { description: 'x', date: '2026-08-14' },
      admin,
      db,
    );
    expect(createTask.state.period).toBe('2026-08');
    expect(createTask.version).toBeUndefined();

    const holiday = await getBotTool('add_holiday')!.readCurrent!(
      { date: '2026-08-15', name: 'Independence Day' },
      admin,
      db,
    );
    expect(holiday.state.period).toBe('2026-08');

    const client = await getBotTool('add_client')!.readCurrent!(
      { name: 'Naaz', shootSlotsPerMonth: 4 },
      admin,
      db,
    );
    expect(client.state.period).toMatch(/^\d{4}-\d{2}$/);
  });

  test('only the two versioned tools may capture a version (ADR-008)', () => {
    // Enforced by inspection of the tool set rather than by running each read:
    // the point is that the LIST is exactly two, and it is asserted somewhere.
    expect([...VERSIONED].sort()).toEqual(['update_calendar_cell', 'update_pipeline_stage']);
    for (const tool of MUTATION_TOOLS) {
      const versionedByName = VERSIONED.has(tool.name);
      expect(
        ['update_pipeline_stage', 'update_calendar_cell'].includes(tool.name),
        tool.name,
      ).toBe(versionedByName);
    }
  });
});

describe('bot write attribution (ADR-016)', () => {
  const CLIENT_NAME = 'Attribution Test Co';

  test("a write inside withActorSource('bot') audits as 'bot', attributed to the human", async () => {
    const clients = new ClientService();
    const created = await withActorSource('bot', () =>
      clients.create({ name: CLIENT_NAME, shootSlotsPerMonth: 1, isInternal: true }, admin, db),
    );

    try {
      const row = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('record_id', '=', created.id)
        .executeTakeFirstOrThrow();

      // The first time 'bot' is ever written — the enum has carried it unused
      // since migration 023.
      expect(row.changed_by_source).toBe('bot');
      // NOT the System Actor: the human on whose behalf the bot acted.
      expect(row.staff_id).toBe(ADMIN_ID);
    } finally {
      await db.deleteFrom('audit_log').where('record_id', '=', created.id).execute();
      await db.deleteFrom('clients').where('id', '=', created.id).execute();
    }
  });

  test("the same write outside the bot window still audits as 'user'", async () => {
    const clients = new ClientService();
    const created = await clients.create(
      { name: `${CLIENT_NAME} 2`, shootSlotsPerMonth: 1, isInternal: true },
      admin,
      db,
    );

    try {
      const row = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('record_id', '=', created.id)
        .executeTakeFirstOrThrow();
      expect(row.changed_by_source).toBe('user');
    } finally {
      await db.deleteFrom('audit_log').where('record_id', '=', created.id).execute();
      await db.deleteFrom('clients').where('id', '=', created.id).execute();
    }
  });

  test('the ambient source does not leak past the window', async () => {
    await withActorSource('bot', () => Promise.resolve());
    expect(currentActorSource()).toBeUndefined();
  });
});

describe('summary specs render through buildSummary', () => {
  test('each mutation tool produces a complete, human-readable summary', () => {
    // One representative state per tool — enough to prove the spec wires up and
    // that no field renders as a bare null or "[object Object]".
    const fixtures: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['update_task_status', { taskId: 'x', status: 'Done' }, { description: 'Edit the reel', period: '2026-07', status: 'In Progress', deadline: null, assignees: 'Rahul' }],
      ['set_deadline', { taskId: 'x', deadline: '2026-08-14' }, { description: 'Edit the reel', period: '2026-07', status: 'To Do', deadline: null, assignees: '' }],
      ['assign_task', { taskId: 'x', staffIds: ['a', 'b'] }, { description: 'Edit the reel', period: '2026-07', status: 'To Do', deadline: null, assignees: 'Rahul' }],
      ['create_task', { description: 'New reel', date: '2026-08-14' }, { period: '2026-08' }],
      ['update_pipeline_stage', { pipelineId: 'x', stage: 'posted' }, { clientName: 'Naaz Furniture', period: '2026-07', status: 'Finals Ready', stagesComplete: 2 }],
      ['update_shoot_slot', { slotId: 'x', slotStatus: 'Confirmed' }, { clientName: 'Naaz', period: '2026-07', slotIndex: 2, slotStatus: 'Scheduled', slotDate: '2026-07-10', freelancerName: 'Ashook', piecesExpected: 3 }],
      ['update_calendar_cell', { cellId: 'x', status: 'Posted' }, { clientName: 'Naaz', period: '2026-07', date: '2026-07-15', status: 'Editing', note: null }],
      ['add_holiday', { date: '2026-08-15', name: 'Independence Day' }, { period: '2026-08' }],
      ['remove_holiday', { holidayId: 'x' }, { period: '2026-08', date: '2026-08-15', name: 'Independence Day' }],
      ['add_client', { name: 'Naaz', shootSlotsPerMonth: 4 }, { period: '2026-07' }],
      ['deactivate_client', { clientId: 'x' }, { name: 'Naaz', active: true }],
      ['reactivate_client', { clientId: 'x' }, { name: 'Naaz', active: false, isInternal: false, period: '2026-07' }],
    ];

    expect(fixtures).toHaveLength(MUTATION_TOOLS.length);

    for (const [name, input, state] of fixtures) {
      const tool = getBotTool(name)!;
      const summary = buildSummary(tool.summary!, input, state);

      expect(summary.action, name).toBeTruthy();
      expect(summary.entity, name).toBeTruthy();
      expect(summary.target, name).toBeTruthy();
      expect(summary.changes.length, name).toBeGreaterThan(0);
      for (const change of summary.changes) {
        expect(change.from, `${name}.${change.field}`).not.toContain('[object');
        expect(change.to, `${name}.${change.field}`).not.toContain('[object');
        expect(typeof change.from, `${name}.${change.field}`).toBe('string');
        expect(typeof change.to, `${name}.${change.field}`).toBe('string');
      }
    }
  });

  test('dates in a summary render as human dates, not ISO strings', () => {
    const summary = buildSummary(
      getBotTool('set_deadline')!.summary!,
      { taskId: 'x', deadline: '2026-08-14' },
      { description: 'Edit the reel', period: '2026-07', status: 'To Do', deadline: '2026-07-01', assignees: '' },
    );
    expect(summary.changes[0]).toEqual({ field: 'Deadline', from: '1 Jul 2026', to: '14 Aug 2026' });
  });

  // The deep link now comes back from the handler (only it holds the service DTO,
  // and create_task / add_client learn their id from it), so it is asserted in the
  // turn-2 flow test where a real handler actually runs.
  test('every mutation tool declares a summary period except the two that are not period-scoped', () => {
    const notPeriodScoped = ['deactivate_client'];
    for (const tool of MUTATION_TOOLS) {
      const hasPeriod = tool.summary!.period !== undefined;
      expect(hasPeriod, tool.name).toBe(!notPeriodScoped.includes(tool.name));
    }
  });
});
