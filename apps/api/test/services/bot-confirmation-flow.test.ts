import { Redis } from 'ioredis';
import { Kysely, PostgresDialect, sql } from 'kysely';
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
const MANAGER = 'e2000000-0000-4000-8000-00000000cf03';
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

/** Records every request so a test can prove turn 2 made none. `tools` is what
 *  the permission filter let through — the manager cases assert on it. */
interface AnthropicSpy {
  client: Anthropic;
  calls: Array<{ messages: Anthropic.MessageParam[]; tools?: Anthropic.Tool[] }>;
}

/** Phase 1 asks for `toolName`; phase 2 asks the confirmation question. */
function mockAnthropic(
  toolInput: Record<string, unknown>,
  toolName = 'update_task_status',
): AnthropicSpy {
  const calls: Array<{ messages: Anthropic.MessageParam[]; tools?: Anthropic.Tool[] }> = [];
  const client = {
    messages: {
      stream: (req: { messages: Anthropic.MessageParam[]; tools?: Anthropic.Tool[] }) => {
        calls.push({ messages: req.messages, tools: req.tools });
        if (calls.length === 1) {
          return fakeStream(
            ['Let me check that task. '],
            asMessage([{ type: 'tool_use', id: 'toolu_1', name: toolName, input: toolInput }], 'tool_use'),
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

/** A model that just answers, with no tool call — an ordinary question. */
function mockPlainAnthropic(): AnthropicSpy {
  const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
  const client = {
    messages: {
      stream: (req: { messages: Anthropic.MessageParam[] }) => {
        calls.push({ messages: req.messages });
        return fakeStream(['You have 3 overdue tasks.'], asMessage([{ type: 'text', text: 'You have 3 overdue tasks.' }], 'end_turn'));
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

/**
 * A real user turn for the bot's reply to hang off (ADR-021). parent_id is a genuine
 * FK to messages(id), so these tests can no longer hand handleMessage an invented id
 * — which is the point: the link is enforced by the database, not by convention.
 */
async function seedUserTurn(staffId: string): Promise<string> {
  const row = await db
    .insertInto('messages')
    .values({ channel: 'bot', sender_id: staffId, sender_type: 'user', content: 'seed turn', content_type: 'text' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function cleanup(): Promise<void> {
  const staff = [ADMIN, MEMBER, MANAGER];
  await redis.del(
    ...staff.flatMap((id) => [`bot:session:${id}`, `bot:pending:${id}`, `perms:${id}`]),
  );
  // The conversation, not "rows carrying my id" — see ADR-021 and the same note in
  // BotService.test.ts. Bot replies hang off parent_id with a NULL sender_id.
  await sql`
    DELETE FROM messages
    WHERE sender_id = ANY(${staff})
       OR parent_id IN (SELECT id FROM messages WHERE sender_id = ANY(${staff}))
  `.execute(db);
  await db.deleteFrom('bot_sessions').where('staff_id', 'in', staff).execute();
  await db.deleteFrom('audit_log').where('record_id', '=', TASK).execute();
  // The add_holiday / remove_holiday bot tools now notify every active staff member
  // (ADR-020 closed that gap in Sprint 10), so these fixtures accumulate notification
  // rows that FK staff — and staff cannot be deleted while they exist.
  await db.deleteFrom('notifications').where('staff_id', 'in', staff).execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      { id: ADMIN, name: 'Conf Admin', email: `admin${ADMIN}@conf.itest`, role: 'admin', active: true },
      { id: MEMBER, name: 'Conf Member', email: `member${MEMBER}@conf.itest`, role: 'team_member', active: true },
      { id: MANAGER, name: 'Conf Manager', email: `manager${MANAGER}@conf.itest`, role: 'manager', active: true },
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
  await db.deleteFrom('staff').where('id', 'in', [ADMIN, MEMBER, MANAGER]).execute();
  await redis.quit();
  await db.destroy();
});

/** Turn 1: the model asks for the mutation; the gate turns it into a summary. */
async function turn1(sink: Emitted[] = []): Promise<{ confirmationId: string; sink: Emitted[] }> {
  const spy = mockAnthropic({ taskId: TASK, status: 'Done' });
  const s = svc(spy, sink);
  const session = await s.loadSession(ADMIN, db);
  await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'mark the naaz reel done', db, userMessageId: await seedUserTurn(ADMIN) });

  const terminal = sink.filter((e) => e.event === 'bot:message').at(-1)!.payload;
  const card = terminal.card as { type: string; confirmationId: string };
  return { confirmationId: card.confirmationId, sink };
}

describe('the tool loop is bounded, not two-phase', () => {
  /** Every tool_use block in the transcript must have a tool_result in the NEXT
   *  message. The API rejects a dangling one, and Sprint 8 persisted them. */
  function assertNoDanglingToolUse(messages: Anthropic.MessageParam[]): void {
    for (const [i, m] of messages.entries()) {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
      const ids = m.content
        .filter((b) => (b as { type: string }).type === 'tool_use')
        .map((b) => (b as { id: string }).id);
      if (ids.length === 0) continue;

      const next = messages[i + 1];
      const answered = new Set(
        next && Array.isArray(next.content)
          ? next.content
              .filter((b) => (b as { type: string }).type === 'tool_result')
              .map((b) => (b as { tool_use_id: string }).tool_use_id)
          : [],
      );
      for (const id of ids) {
        expect(answered.has(id), `tool_use ${id} at index ${i} has no tool_result`).toBe(true);
      }
    }
  }

  /** A model that asks for a tool on the first TWO rounds, then answers. This is
   *  the shape that poisoned a session under the fixed two-phase loop. */
  function twoRoundAnthropic(): AnthropicSpy {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    const client = {
      messages: {
        stream: (req: { messages: Anthropic.MessageParam[] }) => {
          calls.push({ messages: req.messages });
          if (calls.length === 1) {
            return fakeStream(
              ['Looking that up. '],
              asMessage([{ type: 'tool_use', id: 'toolu_a', name: 'list_tasks', input: {} }], 'tool_use'),
            );
          }
          if (calls.length === 2) {
            // Round 2 also wants a tool — Sprint 8 stored this unanswered.
            return fakeStream(
              ['Now the client list. '],
              asMessage([{ type: 'tool_use', id: 'toolu_b', name: 'get_client_summary', input: {} }], 'tool_use'),
            );
          }
          return fakeStream(['Here you go.'], asMessage([{ type: 'text', text: 'Here you go.' }], 'end_turn'));
        },
      },
    } as unknown as Anthropic;
    return { client, calls };
  }

  test('a second round of tool_use is answered, not persisted dangling', async () => {
    const spy = twoRoundAnthropic();
    const s = svc(spy, []);
    const session = await s.loadSession(ADMIN, db);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'what is going on', db, userMessageId: await seedUserTurn(ADMIN) });

    // Three streams ran, so the loop went past Sprint 8's hard stop at two.
    expect(spy.calls.length).toBe(3);

    const raw = await redis.get(`bot:session:${ADMIN}`);
    const stored = JSON.parse(raw!) as { messages: Anthropic.MessageParam[] };
    // THE REGRESSION: a dangling tool_use here makes every later message in this
    // session 400, which the user sees as "I'm having trouble connecting" forever.
    assertNoDanglingToolUse(stored.messages);
  });

  test('a completed chain ends with the assistant answer', async () => {
    const spy = twoRoundAnthropic();
    const s = svc(spy, []);
    const session = await s.loadSession(ADMIN, db);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'what is going on', db, userMessageId: await seedUserTurn(ADMIN) });

    const stored = JSON.parse((await redis.get(`bot:session:${ADMIN}`))!) as {
      messages: Anthropic.MessageParam[];
    };
    expect(stored.messages.at(-1)!.role).toBe('assistant');
    // Consecutive user messages ARE accepted by the API (verified against it), so
    // the only hard invariant is the dangling tool_use — this is just the shape a
    // normal completed turn has.
  });

  test('a model that never stops asking for tools is cut off and finalised gracefully', async () => {
    // The cap is what keeps this a loop and not an agent.
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    const client = {
      messages: {
        stream: (req: { messages: Anthropic.MessageParam[] }) => {
          calls.push({ messages: req.messages });
          // Never returns end_turn while tools are offered.
          return fakeStream(
            ['again '],
            calls.length > 8
              ? asMessage([{ type: 'text', text: 'fine' }], 'end_turn')
              : asMessage(
                  [{ type: 'tool_use', id: `toolu_${calls.length}`, name: 'list_tasks', input: {} }],
                  'tool_use',
                ),
          );
        },
      },
    } as unknown as Anthropic;

    const sink: Emitted[] = [];
    const s = svc({ client, calls }, sink);
    const session = await s.loadSession(ADMIN, db);
    // Never throws — a hard error at the cap reads to the user as the very
    // "trouble connecting" bug this loop was rewritten to fix (ADR-018 §2).
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'loop forever', db, userMessageId: await seedUserTurn(ADMIN) });

    expect(calls.length).toBe(4); // MAX_TOOL_ROUNDS, and no extra closing stream

    // The partial text the model DID stream, plus the friendly copy.
    const terminal = sink.filter((e) => e.event === 'bot:message').at(-1)!.payload;
    expect(terminal.content).toContain('again');
    expect(terminal.content).toContain('Something went wrong');

    const stored = JSON.parse((await redis.get(`bot:session:${ADMIN}`))!) as {
      messages: Anthropic.MessageParam[];
    };
    // The invariant that matters, even for a model behaving badly.
    assertNoDanglingToolUse(stored.messages);
  });

  test('a session already poisoned with unpaired blocks heals on the next message', async () => {
    // THE test that would have caught the original bug. A session stored by the
    // pre-fix build stays broken for its whole 12h TTL unless the replayed history
    // is sanitised on the READ path too (ADR-018 §3) — every message 400s.
    await redis.set(
      `bot:session:${ADMIN}`,
      JSON.stringify({
        sessionId: 'poisoned-session',
        turnCount: 1,
        lastActivityAt: new Date().toISOString(),
        messages: [
          { role: 'user', content: 'what is going on' },
          // A tool_use nothing ever answered — what Sprint 8's second stream stored.
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_dead', name: 'list_tasks', input: {} }],
          },
          // And the mirror image the API rejects just as hard: a tool_result with
          // no tool_use to match.
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_ghost', content: 'orphan' }],
          },
        ],
      }),
      'EX',
      3600,
    );

    const spy = mockPlainAnthropic();
    const s = svc(spy, []);
    const session = await s.loadSession(ADMIN, db);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'try again', db, userMessageId: await seedUserTurn(ADMIN) });

    // What went to the API is what the API validates.
    const sent = JSON.stringify(spy.calls[0]!.messages);
    expect(sent).not.toContain('toolu_dead');
    expect(sent).not.toContain('toolu_ghost');
    assertNoDanglingToolUse(spy.calls[0]!.messages);
  });

  test('a mutation is reachable in ONE user turn: look up, then stage', async () => {
    // The other half of the bug — the prompt tells the model to look an id up
    // first, which spent the only round Sprint 8 had.
    const calls: number[] = [];
    const client = {
      messages: {
        stream: () => {
          calls.push(1);
          if (calls.length === 1) {
            return fakeStream(
              ['Finding it. '],
              asMessage([{ type: 'tool_use', id: 'toolu_look', name: 'list_tasks', input: {} }], 'tool_use'),
            );
          }
          if (calls.length === 2) {
            return fakeStream(
              ['Got it. '],
              asMessage(
                [
                  {
                    type: 'tool_use',
                    id: 'toolu_act',
                    name: 'update_task_status',
                    input: { taskId: TASK, status: 'Done' },
                  },
                ],
                'tool_use',
              ),
            );
          }
          return fakeStream(['Confirm?'], asMessage([{ type: 'text', text: 'Confirm?' }], 'end_turn'));
        },
      },
    } as unknown as Anthropic;

    const sink: Emitted[] = [];
    const s = new BotService(client, redis, mockIo(sink));
    const session = await s.loadSession(ADMIN, db);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'mark the naaz reel done', db, userMessageId: await seedUserTurn(ADMIN) });

    // Staged, not executed.
    expect(await taskStatus()).toBe('In Progress');
    const card = sink.filter((e) => e.event === 'bot:message').at(-1)!.payload.card as { type: string };
    expect(card.type).toBe('confirmation');
    expect(await s.peekPending(ADMIN)).not.toBeNull();
  });
});

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
    const session = await s.loadSession(ADMIN, db);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'mark it done', db, userMessageId: await seedUserTurn(ADMIN) });

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
    const session = await s.loadSession(ADMIN, db);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'mark the ghost done', db, userMessageId: await seedUserTurn(ADMIN) });

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

/**
 * MANAGER — the only role whose bot surface differs from admin, and the one the
 * E2E suite cannot reach: `.env.e2e` has admin, team_member and freelancer, so
 * nothing anywhere drove a manager through a mutation until these.
 *
 * Exactly three tools differ (ROLE_DEFAULTS): `get_audit_log`,
 * `deactivate_client` and — since ADR-026 — `reactivate_client`. Everything else
 * a manager holds, they hold identically, so the tests below are the whole
 * boundary: one mutation that must work, and the ones that must not.
 */
describe('manager — the role the E2E fixtures cannot reach', () => {
  test('completes a two-turn mutation, audited to the MANAGER', async () => {
    const spy = mockAnthropic({ taskId: TASK, status: 'Done' });
    const sink: Emitted[] = [];
    const s = svc(spy, sink);
    const session = await s.loadSession(MANAGER, db);
    await s.handleMessage({ session, staffId: MANAGER, role: 'manager', userText: 'mark the naaz reel done', db, userMessageId: await seedUserTurn(MANAGER) });

    // Turn 1 stages and writes nothing, exactly as for an admin.
    expect(await taskStatus()).toBe('In Progress');
    const card = sink.filter((e) => e.event === 'bot:message').at(-1)!.payload.card as {
      type: string;
      confirmationId: string;
    };
    expect(card.type).toBe('confirmation');

    const s2 = svc(undefined, []);
    const next = await s2.loadSession(MANAGER, db);
    await s2.handleMessage({
      session: next,
      staffId: MANAGER,
      role: 'manager',
      userText: 'yes',
      decision: 'confirm',
      confirmationId: card.confirmationId,
      db,
      userMessageId: await seedUserTurn(MANAGER),
    });

    expect(await taskStatus()).toBe('Done');
    const row = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('record_id', '=', TASK)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(row.changed_by_source).toBe('bot');
    // ADR-016: the human who asked — not the admin, not the System Actor.
    expect(row.staff_id).toBe(MANAGER);
  });

  // Admin-only (ROLE_DEFAULTS). Each is filtered out of the tool list the model
  // sees, so a model that names one is either confused or being steered — this
  // drives the defence-in-depth backstop in runTool, which no manager test
  // reached before. Both directions of the client lifecycle are gated the same
  // way, which is the point of ADR-026 §6: an undo the bot can reach without
  // consent is no safer than the destroy it undoes.
  test.each(['deactivate_client', 'reactivate_client'])(
    '%s is withheld from a manager, and refused if named anyway',
    async (toolName) => {
      const spy = mockAnthropic({ clientId: '11111111-1111-4111-8111-111111111111' }, toolName);
      const sink: Emitted[] = [];
      const s = svc(spy, sink);
      const session = await s.loadSession(MANAGER, db);
      await s.handleMessage({ session, staffId: MANAGER, role: 'manager', userText: 'change that client', db, userMessageId: await seedUserTurn(MANAGER) });

      // Withheld: the tool never reached the model in the first place.
      const offered = (spy.calls[0]!.tools ?? []).map((t) => t.name);
      expect(offered).not.toContain(toolName);
      expect(offered).toContain('add_client'); // …while the manager's own client tool did

      // Refused: no pending record, so no [Confirm] button can ever exist for it.
      expect(await s.peekPending(MANAGER)).toBeNull();
      const terminal = sink.filter((e) => e.event === 'bot:message').at(-1)!.payload;
      expect(terminal.card).toBeUndefined();

      // And the model was handed our refusal copy, not a stack or a code.
      const fedBack = JSON.stringify(spy.calls[1]!.messages);
      expect(fedBack).toContain("I don't have permission to do that on your behalf");
      expect(fedBack).not.toMatch(/PERMISSION_DENIED|\b4\d\d\b/);
    },
  );
});

describe('turn 2 — execution', () => {
  test('a structured confirm executes the stored call and makes ZERO model calls', async () => {
    const { confirmationId } = await turn1();

    const sink: Emitted[] = [];
    // No Anthropic client at all: if turn 2 tried to stream, this would throw.
    const s = svc(undefined, sink);
    const session = await s.loadSession(ADMIN, db);
    await s.handleMessage({
      session,
      staffId: ADMIN,
      role: 'admin',
      userText: 'Yes, go ahead',
      decision: 'confirm',
      confirmationId,
      db,
      userMessageId: await seedUserTurn(ADMIN),
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
    const session = await s.loadSession(ADMIN, db);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'yes', decision: 'confirm', confirmationId, db, userMessageId: await seedUserTurn(ADMIN) });

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

    const first = await s.loadSession(ADMIN, db);
    await s.handleMessage({ session: first, staffId: ADMIN, role: 'admin', userText: 'yes', decision: 'confirm', confirmationId, db, userMessageId: await seedUserTurn(ADMIN) });
    expect(await taskStatus()).toBe('Done');

    // Replay the exact same click.
    const sink: Emitted[] = [];
    const s2 = svc(undefined, sink);
    const second = await s2.loadSession(ADMIN, db);
    await s2.handleMessage({ session: second, staffId: ADMIN, role: 'admin', userText: 'yes', decision: 'confirm', confirmationId, db, userMessageId: await seedUserTurn(ADMIN) });

    const terminal = sink.filter((e) => e.event === 'bot:message').at(-1)!.payload;
    expect(terminal.content).toBe("I've already handled that one. What would you like to do?");
    expect(terminal.card).toBeUndefined();
  });

  test('a typed exact affirmative executes too', async () => {
    const { confirmationId } = await turn1();
    expect(confirmationId).toBeTruthy();

    const s = svc(undefined, []);
    const session = await s.loadSession(ADMIN, db);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'do it', db, userMessageId: await seedUserTurn(ADMIN) });
    expect(await taskStatus()).toBe('Done');
  });

  test('cancel clears the pending record and writes nothing', async () => {
    const { confirmationId } = await turn1();

    const sink: Emitted[] = [];
    const s = svc(undefined, sink);
    const session = await s.loadSession(ADMIN, db);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'Cancel', decision: 'cancel', confirmationId, db, userMessageId: await seedUserTurn(ADMIN) });

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
    const session = await s2.loadSession(ADMIN, db);
    await s2.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'yes', decision: 'confirm', confirmationId, db, userMessageId: await seedUserTurn(ADMIN) });

    expect(await taskStatus()).toBe('In Progress');
    const terminal = sink.filter((e) => e.event === 'bot:message').at(-1)!.payload;
    expect(terminal.content).toBe('That confirmation timed out — want me to set it up again?');
  });

  test('a mismatched confirmationId never executes whatever is pending now', async () => {
    await turn1();
    const sink: Emitted[] = [];
    const s = svc(undefined, sink);
    const session = await s.loadSession(ADMIN, db);
    await s.handleMessage({
      session,
      staffId: ADMIN,
      role: 'admin',
      userText: 'yes',
      decision: 'confirm',
      confirmationId: 'e2000000-0000-4000-8000-0000000000ff',
      db,
      userMessageId: await seedUserTurn(ADMIN),
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
      const session = await s.loadSession(ADMIN, db);
      await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'yes', decision: 'confirm', confirmationId, db, userMessageId: await seedUserTurn(ADMIN) });

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
    const session = await s.loadSession(ADMIN, db);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'do the thing', db, userMessageId: await seedUserTurn(ADMIN) });
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

  test('⭐ reactivate_client confirms, then reaches ClientService.reactivate (ADR-026 §6)', async () => {
    const client = await db
      .insertInto('clients')
      .values({ name: 'Undo Co', shoot_slots_per_month: 1, is_internal: true, active: false, deleted_at: sql`now()` })
      .returning('id')
      .executeTakeFirstOrThrow();

    try {
      // Turn 1: a card, and nothing written. The card must name the client, not
      // its uuid, and say what reactivating actually does.
      const spy = mockAnthropic({ clientId: client.id }, 'reactivate_client');
      const sink: Emitted[] = [];
      const s = svc(spy, sink);
      const session = await s.loadSession(ADMIN, db);
      await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'bring undo co back', db, userMessageId: await seedUserTurn(ADMIN) });

      const card = sink.filter((e) => e.event === 'bot:message').at(-1)!.payload.card as {
        type: string;
        confirmationId: string;
        summary: { target: string; changes: Array<{ field: string; from: string; to: string }> };
      };
      expect(card.type).toBe('confirmation');
      expect(card.summary.target).toBe('Undo Co');
      expect(card.summary.changes.find((c) => c.field === 'Active')!.to).toBe('Yes');
      expect(card.summary.changes.find((c) => c.field === 'This month’s rows')!.to).toContain(
        'internal',
      );

      const stillDead = await db
        .selectFrom('clients')
        .select('deleted_at')
        .where('id', '=', client.id)
        .executeTakeFirstOrThrow();
      expect(stillDead.deleted_at, 'turn 1 stages, it never writes').not.toBeNull();

      // Turn 2: the same service the REST route calls.
      const s2 = svc(undefined, []);
      const next = await s2.loadSession(ADMIN, db);
      await s2.handleMessage({
        session: next,
        staffId: ADMIN,
        role: 'admin',
        userText: 'yes',
        decision: 'confirm',
        confirmationId: card.confirmationId,
        db,
        userMessageId: await seedUserTurn(ADMIN),
      });

      const revived = await db
        .selectFrom('clients')
        .select(['active', 'deleted_at'])
        .where('id', '=', client.id)
        .executeTakeFirstOrThrow();
      expect(revived.active).toBe(true);
      expect(revived.deleted_at).toBeNull();
    } finally {
      await db.deleteFrom('audit_log').where('record_id', '=', client.id).execute();
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

describe('turn 2 — re-validation between the summary and the yes', () => {
  test('a period locked between turn 1 and turn 2 refuses with the lock copy', async () => {
    const { confirmationId } = await turn1();

    // An admin locks the month while the user is reading the card. The service
    // asserts the lock inside its own transaction, so the refusal is atomic with
    // the write attempt rather than a pre-check that could race it.
    await db.updateTable('months').set({ locked: true }).where('period', '=', PERIOD).execute();
    try {
      const sink: Emitted[] = [];
      const s = svc(undefined, sink);
      const session = await s.loadSession(ADMIN, db);
      await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'yes', decision: 'confirm', confirmationId, db, userMessageId: await seedUserTurn(ADMIN) });

      expect(await taskStatus()).toBe('In Progress');
      const content = sink.filter((e) => e.event === 'bot:message').at(-1)!.payload.content as string;
      expect(content).toMatch(/locked/i);
      expect(content).toMatch(/unlock/i);
      // Never a code or a status.
      expect(content).not.toMatch(/423|PERIOD_LOCKED/);
    } finally {
      await db.updateTable('months').set({ locked: false }).where('period', '=', PERIOD).execute();
    }
  });

  test('the pending record is consumed even when the write then fails', async () => {
    // Consume-once is unconditional: a failed attempt must not leave a record that
    // a second click could fire against a since-unlocked month.
    const { confirmationId } = await turn1();
    await db.updateTable('months').set({ locked: true }).where('period', '=', PERIOD).execute();
    try {
      const s = svc(undefined, []);
      const session = await s.loadSession(ADMIN, db);
      await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'yes', decision: 'confirm', confirmationId, db, userMessageId: await seedUserTurn(ADMIN) });
      expect(await s.peekPending(ADMIN)).toBeNull();
    } finally {
      await db.updateTable('months').set({ locked: false }).where('period', '=', PERIOD).execute();
    }
  });
});

describe('turn 2 — a qualified yes is not consent', () => {
  test('"yes, but make it Friday" clears the pending record and re-plans', async () => {
    await turn1();

    // A fresh model mock: the message falls through to the normal Sprint 8 flow.
    const spy = mockAnthropic({ taskId: TASK, status: 'Done' });
    const s = svc(spy, []);
    const session = await s.loadSession(ADMIN, db);
    await s.handleMessage({
      session,
      staffId: ADMIN,
      role: 'admin',
      userText: 'yes, but make it Friday',
      db,
      userMessageId: await seedUserTurn(ADMIN),
    });

    // It did NOT execute the summarised change...
    expect(await taskStatus()).toBe('In Progress');
    // ...and it DID reach the model (fell through as a fresh turn).
    expect(spy.calls.length).toBeGreaterThan(0);
  });

  test('an unrelated message clears the pending record rather than leaving it armed', async () => {
    await turn1();
    expect(await svc().peekPending(ADMIN)).not.toBeNull();

    // The model answers the new question plainly — no fresh mutation intent.
    const s = svc(mockPlainAnthropic(), []);
    const session = await s.loadSession(ADMIN, db);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'what are my overdue tasks?', db, userMessageId: await seedUserTurn(ADMIN) });

    // A stale confirmation must not survive to be answered by a later bare "yes".
    expect(await s.peekPending(ADMIN)).toBeNull();
    expect(await taskStatus()).toBe('In Progress');
  });

  test('after an unrelated message, a bare "yes" executes nothing', async () => {
    await turn1();

    const first = await svc(mockPlainAnthropic(), []).loadSession(ADMIN, db);
    const s = svc(mockPlainAnthropic(), []);
    await s.handleMessage({ session: first, staffId: ADMIN, role: 'admin', userText: 'never mind, what is the weather', db, userMessageId: await seedUserTurn(ADMIN) });

    const s2 = svc(mockPlainAnthropic(), []);
    const second = await s2.loadSession(ADMIN, db);
    await s2.handleMessage({ session: second, staffId: ADMIN, role: 'admin', userText: 'yes', db, userMessageId: await seedUserTurn(ADMIN) });

    // The "yes" is now just a message — there is nothing pending for it to confirm.
    expect(await taskStatus()).toBe('In Progress');
  });
});

describe('persist-then-emit', () => {
  test('the terminal turn is in the session before the socket emit, so a disconnected client recovers it', async () => {
    const { confirmationId } = await turn1();

    let sessionAtEmitTime: string | null = null;
    // The handler is async and BotService fires it without awaiting (emit is
    // fire-and-forget by design), so the test must wait for the read itself. It used
    // to pass by luck: the DB archive ran after the emit and its await gave this
    // handler time to finish. ADR-021 moved both durable writes ahead of the emit —
    // correctly — leaving nothing behind it to await.
    let observed!: () => void;
    const emitObserved = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const io = {
      of: () => ({
        to: () => ({
          emit: async (event: string) => {
            // Read the session AT the moment of the emit: it must already be there.
            if (event === 'bot:message' && sessionAtEmitTime === null) {
              sessionAtEmitTime = await redis.get(`bot:session:${ADMIN}`);
              observed();
            }
          },
        }),
      }),
    } as unknown as Server;

    const s = new BotService({} as Anthropic, redis, io);
    const session = await s.loadSession(ADMIN, db);
    await s.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'yes', decision: 'confirm', confirmationId, db, userMessageId: await seedUserTurn(ADMIN) });

    await emitObserved;
    expect(sessionAtEmitTime).not.toBeNull();
    expect(sessionAtEmitTime!).toContain('Done — Mark task as Done');

    // And the recovery path sees it.
    const view = await s.sessionView(ADMIN, db);
    expect(view.messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(view.messages.at(-1)!.content).toContain('Done — Mark task as Done');
  });
});
