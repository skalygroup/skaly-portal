import { Redis } from 'ioredis';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterEach, afterAll } from 'vitest';

import { BotService } from '../../src/services/BotService.js';

import type Anthropic from '@anthropic-ai/sdk';
import type { DB } from '@skaly/shared';
import type { Server } from 'socket.io';

/**
 * The two-turn flow end to end through BotService (Sprint 9 STEP 5), with a mocked
 * Anthropic and a real Postgres + Redis.
 *
 * The load-bearing assertion in this file is the FIRST one: turn 1 of a mutation
 * must not write. Everything else is the shape of the conversation around it.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const ADMIN = 'e2000000-0000-4000-8000-00000000cf01';
const MEMBER = 'e2000000-0000-4000-8000-00000000cf02';
const PERIOD = '2097-05';
const TASK = 'e2000000-0000-4000-8000-00000000cfa1';

interface Emitted {
  event: string;
  payload: Record<string, unknown>;
}
function mockIo(sink: Emitted[]): Server {
  return {
    of: () => ({ to: () => ({ emit: (event: string, payload: Record<string, unknown>) => sink.push({ event, payload }) }) }),
  } as unknown as Server;
}

function fakeStream(textChunks: string[], final: Anthropic.Message) {
  let cb: ((t: string) => void) | undefined;
  return {
    on(event: string, handler: (t: string) => void) {
      if (event === 'text') cb = handler;
      return this;
    },
    async finalMessage() {
      for (const c of textChunks) cb?.(c);
      return final;
    },
  };
}

const asMessage = (content: unknown[], stopReason: string): Anthropic.Message =>
  ({
    id: 'msg_x',
    type: 'message',
    role: 'assistant',
    model: 'test',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) as unknown as Anthropic.Message;

/** Records every request so a test can prove turn 2 made none. */
interface AnthropicSpy {
  client: Anthropic;
  calls: Array<{ messages: Anthropic.MessageParam[] }>;
}

/** Phase 1 asks for update_task_status; phase 2 asks the confirmation question. */
function mockAnthropic(toolInput: Record<string, unknown>): AnthropicSpy {
  const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
  const client = {
    messages: {
      stream: (req: { messages: Anthropic.MessageParam[] }) => {
        calls.push({ messages: req.messages });
        if (calls.length === 1) {
          return fakeStream(
            ['Let me check that task. '],
            asMessage([{ type: 'tool_use', id: 'toolu_1', name: 'update_task_status', input: toolInput }], 'tool_use'),
          );
        }
        return fakeStream(
          ['Ready to mark it Done — confirm?'],
          asMessage([{ type: 'text', text: 'Ready to mark it Done — confirm?' }], 'end_turn'),
        );
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const svc = (spy?: AnthropicSpy, sink: Emitted[] = []): BotService =>
  new BotService(spy?.client ?? ({} as Anthropic), redis, mockIo(sink));

async function taskStatus(): Promise<string> {
  const row = await db.selectFrom('tasks').select('status').where('id', '=', TASK).executeTakeFirstOrThrow();
  return row.status;
}

async function resetTask(): Promise<void> {
  await db.deleteFrom('task_assignees').where('task_id', '=', TASK).execute();
  await db.deleteFrom('tasks').where('id', '=', TASK).execute();
  await db
    .insertInto('tasks')
    .values({
      id: TASK,
      period: PERIOD,
      date: `${PERIOD}-10`,
      description: 'Edit the Naaz Furniture reel',
      status: 'In Progress',
      created_by: ADMIN,
    })
    .execute();
}

async function cleanup(): Promise<void> {
  await redis.del(`bot:session:${ADMIN}`, `bot:pending:${ADMIN}`, `bot:session:${MEMBER}`, `bot:pending:${MEMBER}`, `perms:${ADMIN}`, `perms:${MEMBER}`);
  await db.deleteFrom('messages').where('sender_id', 'in', [ADMIN, MEMBER]).execute();
  await db.deleteFrom('audit_log').where('record_id', '=', TASK).execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN, name: 'Conf Admin', email: `admin${ADMIN}@conf.itest`, role: 'admin', active: true },
      { id: MEMBER, name: 'Conf Member', email: `member${MEMBER}@conf.itest`, role: 'team_member', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doUpdateSet({ locked: false }))
    .execute();
  await cleanup();
  await resetTask();
});

afterEach(async () => {
  await cleanup();
  await resetTask();
});

afterAll(async () => {
  await cleanup();
  await db.deleteFrom('task_assignees').where('task_id', '=', TASK).execute();
  await db.deleteFrom('tasks').where('id', '=', TASK).execute();
  await db.deleteFrom('staff').where('id', 'in', [ADMIN, MEMBER]).execute();
  await redis.quit();
  await db.destroy();
});

/** Turn 1: the model asks for the mutation; the gate turns it into a summary. */
async function turn1(sink: Emitted[] = []): Promise<{ confirmationId: string; sink: Emitted[] }> {
  const spy = mockAnthropic({ taskId: TASK, status: 'Done' });
  const s = svc(spy, sink);
  const session = await s.loadSession(ADMIN);
  await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'mark the naaz reel done', db });

  const terminal = sink.filter((e) => e.event === 'bot:message').at(-1)!.payload;
  const card = terminal.card as { type: string; confirmationId: string };
  return { confirmationId: card.confirmationId, sink };
}

describe('turn 1 — the gate', () => {
  test('DOES NOT WRITE, and returns a confirmation card instead', async () => {
    expect(await taskStatus()).toBe('In Progress');

    const sink: Emitted[] = [];
    const { confirmationId } = await turn1(sink);

    // THE assertion of this sprint: the model asked for a status change and the
    // status did not change.
    expect(await taskStatus()).toBe('In Progress');

    const terminal = sink.filter((e) => e.event === 'bot:message').at(-1)!.payload;
    const card = terminal.card as { type: string; toolName: string; summary: Record<string, unknown> };
    expect(card.type).toBe('confirmation');
    expect(card.toolName).toBe('update_task_status');
    expect(confirmationId).toMatch(/^[0-9a-f-]{36}$/);

    // The summary is server-rendered from the real row, not the model's prose.
    expect(card.summary).toMatchObject({
      action: 'Mark task as Done',
      entity: 'Task',
      target: 'Edit the Naaz Furniture reel',
      period: PERIOD,
      changes: [{ field: 'Status', from: 'In Progress', to: 'Done' }],
    });

    // Nothing was executed, so nothing is reported as used.
    expect(terminal.toolsUsed).toEqual([]);
  });

  test('feeds the model a synthetic tool_result, so the next request is valid', async () => {
    const spy = mockAnthropic({ taskId: TASK, status: 'Done' });
    const s = svc(spy, []);
    const session = await s.loadSession(ADMIN);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'mark it done', db });

    // Phase 2's request must contain a tool_result for toolu_1 — the Anthropic API
    // 400s on a tool_use with no matching result, and that 400 would land on the
    // user's NEXT message looking like an unrelated bug.
    const second = spy.calls[1]!.messages;
    const results = second.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((b) => (b as { type: string }).type === 'tool_result')
        : [],
    ) as Array<{ tool_use_id: string; content: string }>;
    expect(results).toHaveLength(1);
    expect(results[0]!.tool_use_id).toBe('toolu_1');
    expect(results[0]!.content).toContain('AWAITING_USER_CONFIRMATION');
  });

  test('a hallucinated id creates NO pending state', async () => {
    const spy = mockAnthropic({ taskId: 'e2000000-0000-4000-8000-00000000dead', status: 'Done' });
    const s = svc(spy, []);
    const session = await s.loadSession(ADMIN);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'mark the ghost done', db });

    expect(await s.peekPending(ADMIN)).toBeNull();
  });

  test('a second mutation intent replaces the first (one pending record)', async () => {
    const { confirmationId: first } = await turn1();
    const { confirmationId: second } = await turn1();
    expect(second).not.toBe(first);

    const pending = await svc().peekPending(ADMIN);
    expect(pending?.confirmationId).toBe(second);
  });
});

describe('turn 2 — execution', () => {
  test('a structured confirm executes the stored call and makes ZERO model calls', async () => {
    const { confirmationId } = await turn1();

    const sink: Emitted[] = [];
    // No Anthropic client at all: if turn 2 tried to stream, this would throw.
    const s = svc(undefined, sink);
    const session = await s.loadSession(ADMIN);
    await s.handleMessage({
      session,
      staffId: ADMIN,
      role: 'admin',
      userText: 'Yes, go ahead',
      decision: 'confirm',
      confirmationId,
      db,
    });

    expect(await taskStatus()).toBe('Done');

    const terminal = sink.filter((e) => e.event === 'bot:message').at(-1)!.payload;
    expect(terminal.content).toBe('Done — Mark task as Done: Edit the Naaz Furniture reel.');
    expect((terminal.card as { type: string; link: string }).type).toBe('mutation_result');
    expect((terminal.card as { link: string }).link).toBe(`/tasks?period=${PERIOD}&highlight=${TASK}`);
    expect(terminal.toolsUsed).toEqual(['update_task_status']);

    // No bot:token — turn 2 streams nothing because it calls nothing.
    expect(sink.filter((e) => e.event === 'bot:token')).toHaveLength(0);
  });

  test("the write is audited as 'bot', attributed to the human (ADR-016)", async () => {
    const { confirmationId } = await turn1();
    const s = svc(undefined, []);
    const session = await s.loadSession(ADMIN);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'yes', decision: 'confirm', confirmationId, db });

    const row = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('record_id', '=', TASK)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(row.changed_by_source).toBe('bot');
    expect(row.staff_id).toBe(ADMIN);
  });

  test('the pending record is consumed, so a replayed confirm does not double-fire', async () => {
    const { confirmationId } = await turn1();
    const s = svc(undefined, []);

    const first = await s.loadSession(ADMIN);
    await s.handleMessage({ session: first, staffId: ADMIN, role: 'admin', userText: 'yes', decision: 'confirm', confirmationId, db });
    expect(await taskStatus()).toBe('Done');

    // Replay the exact same click.
    const sink: Emitted[] = [];
    const s2 = svc(undefined, sink);
    const second = await s2.loadSession(ADMIN);
    await s2.handleMessage({ session: second, staffId: ADMIN, role: 'admin', userText: 'yes', decision: 'confirm', confirmationId, db });

    const terminal = sink.filter((e) => e.event === 'bot:message').at(-1)!.payload;
    expect(terminal.content).toBe("I've already handled that one. What would you like to do?");
    expect(terminal.card).toBeUndefined();
  });

  test('a typed exact affirmative executes too', async () => {
    const { confirmationId } = await turn1();
    expect(confirmationId).toBeTruthy();

    const s = svc(undefined, []);
    const session = await s.loadSession(ADMIN);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'do it', db });
    expect(await taskStatus()).toBe('Done');
  });

  test('cancel clears the pending record and writes nothing', async () => {
    const { confirmationId } = await turn1();

    const sink: Emitted[] = [];
    const s = svc(undefined, sink);
    const session = await s.loadSession(ADMIN);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'Cancel', decision: 'cancel', confirmationId, db });

    expect(await taskStatus()).toBe('In Progress');
    expect(await s.peekPending(ADMIN)).toBeNull();
    const terminal = sink.filter((e) => e.event === 'bot:message').at(-1)!.payload;
    expect(terminal.content).toBe('Okay, no changes made.');
  });

  test('an expired pending record reports the timeout and writes nothing', async () => {
    const { confirmationId } = await turn1();

    // Rewind expiresAt past the 5-minute window.
    const s = svc(undefined, []);
    const pending = (await s.peekPending(ADMIN))!;
    await s.setPending(ADMIN, { ...pending, expiresAt: new Date(Date.now() - 1000).toISOString() });

    const sink: Emitted[] = [];
    const s2 = svc(undefined, sink);
    const session = await s2.loadSession(ADMIN);
    await s2.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'yes', decision: 'confirm', confirmationId, db });

    expect(await taskStatus()).toBe('In Progress');
    const terminal = sink.filter((e) => e.event === 'bot:message').at(-1)!.payload;
    expect(terminal.content).toBe('That confirmation timed out — want me to set it up again?');
  });

  test('a mismatched confirmationId never executes whatever is pending now', async () => {
    await turn1();
    const sink: Emitted[] = [];
    const s = svc(undefined, sink);
    const session = await s.loadSession(ADMIN);
    await s.handleMessage({
      session,
      staffId: ADMIN,
      role: 'admin',
      userText: 'yes',
      decision: 'confirm',
      confirmationId: 'e2000000-0000-4000-8000-0000000000ff',
      db,
    });

    expect(await taskStatus()).toBe('In Progress');
    expect(sink.filter((e) => e.event === 'bot:message').at(-1)!.payload.content).toBe(
      "I've already handled that one. What would you like to do?",
    );
  });

  test('a permission revoked between the summary and the yes refuses the write', async () => {
    const { confirmationId } = await turn1();

    // An admin revokes the tool while the user is reading the card.
    await db
      .insertInto('user_permissions')
      .values({ staff_id: ADMIN, permission_key: 'bot.tool.update_task_status', value: false, set_by: ADMIN })
      .execute();
    await redis.del(`perms:${ADMIN}`);

    try {
      const sink: Emitted[] = [];
      const s = svc(undefined, sink);
      const session = await s.loadSession(ADMIN);
      await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'yes', decision: 'confirm', confirmationId, db });

      expect(await taskStatus()).toBe('In Progress');
      const content = sink.filter((e) => e.event === 'bot:message').at(-1)!.payload.content as string;
      expect(content).toContain("don't have permission");
      // Reads grammatically — the summary's action, not the gerund capability
      // phrase, which would give "permission to changing a task status".
      expect(content).toBe(
        "I don't have permission to mark task as done on your behalf. Ask an admin to update your bot access settings.",
      );
      // Never names the CALLER's role or the permission key (APPFLOW §9). "Ask an
      // admin" is the remedy, which Error-Handling §6 mandates — not a statement of
      // what role is required.
      expect(content).not.toMatch(/manager|team.member|freelancer|bot\.tool|403/i);
    } finally {
      await db.deleteFrom('user_permissions').where('staff_id', '=', ADMIN).execute();
      await redis.del(`perms:${ADMIN}`);
    }
  });
});

describe('the card shows values a human can consent to (ADR-014 §4)', () => {
  const RAHUL = 'e2000000-0000-4000-8000-00000000cf11';
  const PRIYA = 'e2000000-0000-4000-8000-00000000cf12';

  beforeAll(async () => {
    await db
      .insertInto('staff')
      .values([
        { id: RAHUL, name: 'Rahul', email: `rahul${RAHUL}@conf.itest`, role: 'team_member', active: true },
        { id: PRIYA, name: 'Priya', email: `priya${PRIYA}@conf.itest`, role: 'team_member', active: true },
      ])
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  });

  /** Drive one turn-1 for an arbitrary tool call and return its confirmation card. */
  async function cardFor(name: string, input: Record<string, unknown>) {
    const calls: number[] = [];
    const client = {
      messages: {
        stream: () => {
          calls.push(1);
          return calls.length === 1
            ? fakeStream([], asMessage([{ type: 'tool_use', id: 'toolu_1', name, input }], 'tool_use'))
            : fakeStream(['ok?'], asMessage([{ type: 'text', text: 'ok?' }], 'end_turn'));
        },
      },
    } as unknown as Anthropic;

    const sink: Emitted[] = [];
    const s = new BotService(client, redis, mockIo(sink));
    const session = await s.loadSession(ADMIN);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'do the thing', db });
    return {
      card: sink.filter((e) => e.event === 'bot:message').at(-1)!.payload.card as
        | { summary: { changes: Array<{ field: string; from: string; to: string }>; target: string } }
        | undefined,
      content: sink.filter((e) => e.event === 'bot:message').at(-1)!.payload.content as string,
    };
  }

  test('assign_task names the people, and shows only the DELTA', async () => {
    // Rahul is already on the task; the call adds Priya as well.
    await db.insertInto('task_assignees').values({ task_id: TASK, staff_id: RAHUL }).execute();

    const { card } = await cardFor('assign_task', { taskId: TASK, staffIds: [RAHUL, PRIYA] });
    const change = card!.summary.changes.find((c) => c.field === 'Assignees')!;

    // Names, not a count — "2 added" reads identically whether these are the right
    // two people or two ids the model resolved wrongly.
    expect(change.to).toBe('+ Priya');
    // Only the delta: re-confirming must not look like it reassigns everyone.
    expect(change.to).not.toContain('Rahul');
    expect(change.from).toBe('Rahul');
  });

  test('assign_task short-circuits when the delta is empty — no pending record', async () => {
    await db.insertInto('task_assignees').values({ task_id: TASK, staff_id: RAHUL }).execute();

    const { card } = await cardFor('assign_task', { taskId: TASK, staffIds: [RAHUL] });
    // No card to confirm, because there is nothing to change.
    expect(card).toBeUndefined();
    expect(await svc().peekPending(ADMIN)).toBeNull();
  });

  test('assign_task rejects an inactive assignee at turn 1, before consent', async () => {
    await db.updateTable('staff').set({ active: false }).where('id', '=', PRIYA).execute();
    try {
      await cardFor('assign_task', { taskId: TASK, staffIds: [PRIYA] });
      expect(await svc().peekPending(ADMIN)).toBeNull();
    } finally {
      await db.updateTable('staff').set({ active: true }).where('id', '=', PRIYA).execute();
    }
  });

  test('create_task shows the client and assignee NAMES, never their ids', async () => {
    const client = await db
      .insertInto('clients')
      .values({ name: 'Naaz Furniture', shoot_slots_per_month: 2, is_internal: true, active: true })
      .returning('id')
      .executeTakeFirstOrThrow();

    try {
      const { card } = await cardFor('create_task', {
        description: 'Edit the new reel',
        date: `${PERIOD}-12`,
        clientId: client.id,
        assigneeIds: [RAHUL],
      });
      const changes = card!.summary.changes;
      expect(changes.find((c) => c.field === 'Client')!.to).toBe('Naaz Furniture');
      expect(changes.find((c) => c.field === 'Assignees')!.to).toBe('Rahul');
      // Not a single raw uuid anywhere on the card.
      for (const c of changes) expect(c.to).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    } finally {
      await db.deleteFrom('clients').where('id', '=', client.id).execute();
    }
  });

  test('add_holiday shows the weekday, so a Sunday holiday is visibly a no-op', async () => {
    // 2097-05-05 is a Sunday.
    const { card } = await cardFor('add_holiday', { date: '2097-05-05', name: 'Test Day' });
    const date = card!.summary.changes.find((c) => c.field === 'Date')!;
    expect(date.to).toBe('Sunday, 5 May 2097');
  });

  afterAll(async () => {
    await db.deleteFrom('task_assignees').where('staff_id', 'in', [RAHUL, PRIYA]).execute();
    await db.deleteFrom('staff').where('id', 'in', [RAHUL, PRIYA]).execute();
  });
});

describe('turn 2 — a qualified yes is not consent', () => {
  test('"yes, but make it Friday" clears the pending record and re-plans', async () => {
    await turn1();

    // A fresh model mock: the message falls through to the normal Sprint 8 flow.
    const spy = mockAnthropic({ taskId: TASK, status: 'Done' });
    const s = svc(spy, []);
    const session = await s.loadSession(ADMIN);
    await s.handleMessage({
      session,
      staffId: ADMIN,
      role: 'admin',
      userText: 'yes, but make it Friday',
      db,
    });

    // It did NOT execute the summarised change...
    expect(await taskStatus()).toBe('In Progress');
    // ...and it DID reach the model (fell through as a fresh turn).
    expect(spy.calls.length).toBeGreaterThan(0);
  });
});

describe('persist-then-emit', () => {
  test('the terminal turn is in the session before the socket emit, so a disconnected client recovers it', async () => {
    const { confirmationId } = await turn1();

    let sessionAtEmitTime: string | null = null;
    const io = {
      of: () => ({
        to: () => ({
          emit: async (event: string) => {
            // Read the session AT the moment of the emit: it must already be there.
            if (event === 'bot:message' && sessionAtEmitTime === null) {
              sessionAtEmitTime = await redis.get(`bot:session:${ADMIN}`);
            }
          },
        }),
      }),
    } as unknown as Server;

    const s = new BotService({} as Anthropic, redis, io);
    const session = await s.loadSession(ADMIN);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'yes', decision: 'confirm', confirmationId, db });

    expect(sessionAtEmitTime).not.toBeNull();
    expect(sessionAtEmitTime!).toContain('Done — Mark task as Done');

    // And the recovery path sees it.
    const view = await s.sessionView(ADMIN);
    expect(view.messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(view.messages.at(-1)!.content).toContain('Done — Mark task as Done');
  });
});
