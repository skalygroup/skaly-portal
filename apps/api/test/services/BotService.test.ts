import { Redis } from 'ioredis';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';

import { getShootScheduleTool } from '../../src/lib/bot/tools/grids.js';
import { listTasksTool } from '../../src/lib/bot/tools/tasks.js';
import { BotService, trimToTurns } from '../../src/services/BotService.js';
import { PermissionService } from '../../src/services/PermissionService.js';
import { ShootPlannerService } from '../../src/services/ShootPlannerService.js';
import { TaskService } from '../../src/services/TaskService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { DB } from '@skaly/shared';
import type { Server } from 'socket.io';

// Friendly copy — mirrors BotService's ANTHROPIC_ERROR_COPY (not exported).
const ANTHROPIC_ERROR_COPY = "I'm having trouble connecting right now. Please try again.";

// STEP 3 smoke: the two-call tool loop end-to-end with a MOCKED Anthropic stream
// (no real API). Phase 1 returns a list_tasks tool_use; phase 2 streams the final
// answer. Asserts the bot:token/bot:message shape, the card, and archival. The
// full permission-filter + parity suite is STEP 5.
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const ADMIN = 'e1000000-0000-4000-8000-00000000e101';

// Parity + permission-filter fixtures (the ADR-011 guard). Distinct period so
// this suite's rows never collide with the route/service suites.
const MEMBER = 'e1000000-0000-4000-8000-00000000e102';
const FREELANCER = 'e1000000-0000-4000-8000-00000000e103';
const FREELANCER2 = 'e1000000-0000-4000-8000-00000000e104';
const CLIENT = 'e1000000-0000-4000-8000-00000000e1c1';
const PARITY_PERIOD = '2098-03';
const DOMAIN = '@botsvc.itest';

// ── Mock io: capture every emit ─────────────────────────────────────────────
interface Emitted {
  event: string;
  payload: Record<string, unknown>;
}
function mockIo(sink: Emitted[]): Server {
  return {
    of: () => ({
      to: () => ({
        emit: (event: string, payload: Record<string, unknown>) => {
          sink.push({ event, payload });
        },
      }),
    }),
  } as unknown as Server;
}

// ── Mock Anthropic stream: fires text events during finalMessage() ──────────
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

/** Anthropic client that returns a list_tasks tool_use, then the final answer. */
function mockAnthropic(): Anthropic {
  let call = 0;
  return {
    messages: {
      stream: () => {
        call += 1;
        if (call === 1) {
          return fakeStream(
            [],
            asMessage(
              [{ type: 'tool_use', id: 'toolu_1', name: 'list_tasks', input: { period: '2099-01' } }],
              'tool_use',
            ),
          );
        }
        return fakeStream(['Here are ', 'your tasks.'], asMessage([{ type: 'text', text: 'Here are your tasks.' }], 'end_turn'));
      },
    },
  } as unknown as Anthropic;
}

async function cleanup(): Promise<void> {
  await db.deleteFrom('messages').where('sender_id', '=', ADMIN).execute();
  await redis.del(`bot:session:${ADMIN}`);
}

async function seedParity(): Promise<void> {
  await db
    .insertInto('staff')
    .values([
      { id: MEMBER, name: 'Bot Member', email: `member${DOMAIN}`, role: 'team_member', active: true },
      { id: FREELANCER, name: 'Bot Free', email: `free${DOMAIN}`, role: 'freelancer', active: true },
      { id: FREELANCER2, name: 'Bot Free2', email: `free2${DOMAIN}`, role: 'freelancer', active: true },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('months')
    .values({ period: PARITY_PERIOD, label: PARITY_PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doUpdateSet({ locked: false }))
    .execute();
  await db
    .insertInto('clients')
    .values({ id: CLIENT, name: 'Bot Parity Client', shoot_slots_per_month: 4, pieces_per_visit: 3, active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await cleanupParity();
  // Two tasks — internal roles read all of them (no per-user task scoping).
  await db
    .insertInto('tasks')
    .values([
      { period: PARITY_PERIOD, date: `${PARITY_PERIOD}-05`, description: 'Parity task A', created_by: ADMIN },
      { period: PARITY_PERIOD, date: `${PARITY_PERIOD}-06`, description: 'Parity task B', created_by: ADMIN },
    ])
    .execute();
  // Two shoot slots, one per freelancer — the ADR-011 own-only guard.
  await db
    .insertInto('shoot_schedules')
    .values([
      { period: PARITY_PERIOD, client_id: CLIENT, slot_index: 1, slot_status: 'Scheduled', slot_date: `${PARITY_PERIOD}-10`, pieces_expected: 3, freelancer_id: FREELANCER },
      { period: PARITY_PERIOD, client_id: CLIENT, slot_index: 2, slot_status: 'Scheduled', slot_date: `${PARITY_PERIOD}-11`, pieces_expected: 3, freelancer_id: FREELANCER2 },
    ])
    .execute();
}

async function cleanupParity(): Promise<void> {
  await db.deleteFrom('tasks').where('period', '=', PARITY_PERIOD).execute();
  await db.deleteFrom('shoot_schedules').where('period', '=', PARITY_PERIOD).execute();
  await db.deleteFrom('user_permissions').where('staff_id', '=', MEMBER).execute();
  await redis.del(`perms:${MEMBER}`);
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values({ id: ADMIN, name: 'Bot Admin', email: `bot-${ADMIN}@bot.itest`, role: 'admin', active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await cleanup();
  await seedParity();
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await cleanupParity();
  await redis.quit();
  await db.destroy();
});

describe('BotService.handleMessage — list_tasks smoke (mocked Anthropic)', () => {
  test('runs the two-call loop and emits bot:token then a terminal bot:message with the card', async () => {
    const emitted: Emitted[] = [];
    const svc = new BotService(mockAnthropic(), redis, mockIo(emitted));

    const session = await svc.loadSession(ADMIN);
    await svc.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'list my tasks', db });

    const tokens = emitted.filter((e) => e.event === 'bot:token');
    const terminals = emitted.filter((e) => e.event === 'bot:message');

    // Streamed deltas arrived as bot:token…
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.map((t) => t.payload.delta).join('')).toBe('Here are your tasks.');

    // …and exactly one terminal bot:message finalises with content + card.
    expect(terminals).toHaveLength(1);
    const terminal = terminals[0]!.payload;
    expect(terminal.content).toBe('Here are your tasks.');
    expect(terminal.toolsUsed).toEqual(['list_tasks']);
    expect((terminal.card as { type: string }).type).toBe('task_list');
    expect(terminal.sessionId).toBeTruthy();

    // Every event carries the same sessionId (no cross-stream contamination).
    const ids = new Set(emitted.map((e) => e.payload.sessionId));
    expect(ids.size).toBe(1);
  });

  test('archives both the user and bot message to messages (channel=bot)', async () => {
    const svc = new BotService(mockAnthropic(), redis, mockIo([]));
    // Mirror the route: user message archived synchronously (→ messageId), bot
    // reply archived by handleMessage.
    const messageId = await svc.archiveUserMessage(ADMIN, 'list my tasks', db);
    expect(messageId).toBeTruthy();
    const session = await svc.loadSession(ADMIN);
    await svc.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'list my tasks', db });

    const rows = await db
      .selectFrom('messages')
      .select(['channel', 'sender_type', 'content'])
      .where('sender_id', '=', ADMIN)
      .where('channel', '=', 'bot')
      .orderBy('created_at', 'asc')
      .execute();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ channel: 'bot', sender_type: 'user', content: 'list my tasks' });
    expect(rows[1]).toMatchObject({ channel: 'bot', sender_type: 'bot', content: 'Here are your tasks.' });
  });

  test('persists the Redis session with an incremented turnCount', async () => {
    const svc = new BotService(mockAnthropic(), redis, mockIo([]));
    const loaded = await svc.loadSession(ADMIN);
    await svc.handleMessage({ session: loaded, staffId: ADMIN, role: 'admin', userText: 'list my tasks', db });

    const raw = await redis.get(`bot:session:${ADMIN}`);
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw!) as { turnCount: number; messages: unknown[] };
    expect(persisted.turnCount).toBe(1);
    expect(persisted.messages.length).toBeGreaterThan(0);
  });
});

// ── ⭐ Bot-vs-REST parity — the ADR-011 guard ────────────────────────────────
// A tool's row-set must equal what its isolating service method returns for the
// SAME caller (which is exactly what the REST route returns — the route is a thin
// wrapper over the same method). If a tool ever issued its own unscoped query,
// these diverge.
describe('bot-vs-REST parity — tools reuse the isolating service (ADR-011 NOT bypassed)', () => {
  const taskSvc = new TaskService();
  const shootSvc = new ShootPlannerService();

  test('team_member list_tasks == TaskService.getTasks for that user (same row-set)', async () => {
    const user: CurrentUser = { staffId: MEMBER, role: 'team_member' };
    const expected = await taskSvc.getTasks({ period: PARITY_PERIOD }, user, db);

    const { card } = await listTasksTool.handler({ period: PARITY_PERIOD }, user, db);
    const toolRows = (card as unknown as { tasks: unknown[] }).tasks;

    expect(toolRows).toHaveLength(2); // both parity tasks
    expect(toolRows).toEqual(expected);
  });

  test('freelancer get_shoot_schedule returns ONLY own slots, identical to the service', async () => {
    const free: CurrentUser = { staffId: FREELANCER, role: 'freelancer' };
    const expected = await shootSvc.getGrid(PARITY_PERIOD, free, db);

    const { card } = await getShootScheduleTool.handler({ period: PARITY_PERIOD }, free, db);
    const grid = (card as unknown as { data: { slots: { freelancerId: string }[] } }).data;

    // Own-only (ADR-011): the other freelancer's slot is absent.
    expect(grid.slots).toHaveLength(1);
    expect(grid.slots[0]!.freelancerId).toBe(FREELANCER);
    expect(grid).toEqual(expected);

    // And it's genuinely scoped — an admin sees BOTH slots via the same tool.
    const asAdmin = await getShootScheduleTool.handler(
      { period: PARITY_PERIOD },
      { staffId: ADMIN, role: 'admin' },
      db,
    );
    expect((asAdmin.card as unknown as { data: { slots: unknown[] } }).data.slots).toHaveLength(2);
  });
});

// ── Permission filter + defence-in-depth refusal ────────────────────────────
/** Anthropic mock that records every stream() arg and replays a scripted list of
 *  { text, content, stop } responses (last one repeats). */
function scriptedAnthropic(script: Array<{ text?: string[]; content: unknown[]; stop: string }>): {
  client: Anthropic;
  calls: Array<{ tools?: Array<{ name: string }> }>;
} {
  const calls: Array<{ tools?: Array<{ name: string }> }> = [];
  let i = 0;
  const client = {
    messages: {
      stream: (args: { tools?: Array<{ name: string }> }) => {
        calls.push(args);
        const step = script[Math.min(i, script.length - 1)]!;
        i += 1;
        return fakeStream(step.text ?? [], asMessage(step.content, step.stop));
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe('BotService — permission filter (get_attendance overridden off)', () => {
  test('the denied tool is absent from the tools sent to Anthropic, and refused if requested anyway', async () => {
    // team_member get_attendance defaults true (🔐 own); override it off. Seed the
    // row directly + drop the cache so the resolver reads through (no audit noise).
    await db
      .insertInto('user_permissions')
      .values({ staff_id: MEMBER, permission_key: 'bot.tool.get_attendance', value: false, set_by: ADMIN })
      .execute();
    await redis.del(`perms:${MEMBER}`);

    // Confirm the filter itself first.
    const perms = new PermissionService(redis);
    const { permitted, denied } = await perms.getPermittedBotTools(MEMBER, 'team_member', db);
    expect(permitted).not.toContain('get_attendance');
    expect(permitted).toContain('list_tasks');
    expect(denied).toContain('get_attendance');

    // The model asks for get_attendance anyway → defence in depth must refuse it.
    const { client, calls } = scriptedAnthropic([
      { content: [{ type: 'tool_use', id: 'toolu_a', name: 'get_attendance', input: {} }], stop: 'tool_use' },
      { text: ['Sorry.'], content: [{ type: 'text', text: 'Sorry.' }], stop: 'end_turn' },
    ]);
    const emitted: Emitted[] = [];
    const svc = new BotService(client, redis, mockIo(emitted));
    const session = await svc.loadSession(MEMBER);
    await svc.handleMessage({ session, staffId: MEMBER, role: 'team_member', userText: 'attendance?', db });

    // Filtered out of the tool list handed to Anthropic…
    const sentToolNames = (calls[0]?.tools ?? []).map((t) => t.name);
    expect(sentToolNames).not.toContain('get_attendance');
    expect(sentToolNames).toContain('list_tasks');

    // …and refused when requested: no attendance card, nothing recorded as used.
    const terminal = emitted.find((e) => e.event === 'bot:message')!.payload;
    expect(terminal.card).toBeUndefined();
    expect(terminal.toolsUsed).toEqual([]);

    await db.deleteFrom('user_permissions').where('staff_id', '=', MEMBER).execute();
    await redis.del(`perms:${MEMBER}`, `bot:session:${MEMBER}`);
  });
});

describe('BotService — Anthropic failure surfaces friendly copy only', () => {
  test('a stream failure finalises with ANTHROPIC_ERROR copy, no code or stack', async () => {
    const client = {
      messages: {
        stream: () => ({
          on() {
            return this;
          },
          async finalMessage() {
            throw new Error('529 overloaded');
          },
        }),
      },
    } as unknown as Anthropic;

    const emitted: Emitted[] = [];
    const svc = new BotService(client, redis, mockIo(emitted));
    const session = await svc.loadSession(ADMIN);
    await svc.handleMessage({ session, staffId: ADMIN, role: 'admin', userText: 'hi', db });

    const terminals = emitted.filter((e) => e.event === 'bot:message');
    expect(terminals).toHaveLength(1);
    const content = terminals[0]!.payload.content as string;
    expect(content).toBe(ANTHROPIC_ERROR_COPY);
    expect(content).not.toMatch(/529|overloaded|Error|ANTHROPIC_ERROR/);
  });
});

describe('trimToTurns — 50-turn cap drops the oldest', () => {
  test('keeps the newest 50 user turns and stays user-first', () => {
    const messages: Anthropic.MessageParam[] = [];
    for (let n = 0; n < 60; n++) {
      messages.push({ role: 'user', content: `turn ${n}` });
      messages.push({ role: 'assistant', content: `reply ${n}` });
    }
    const trimmed = trimToTurns(messages, 50);

    const userTurns = trimmed.filter((m) => m.role === 'user' && typeof m.content === 'string');
    expect(userTurns).toHaveLength(50);
    expect(userTurns[0]!.content).toBe('turn 10'); // 0–9 dropped
    expect(trimmed[0]!.role).toBe('user'); // valid user-first history
  });
});

/**
 * Sprint 8.1 Defect 2 — the DETERMINISTIC half of the denial contract.
 *
 * The model's actual prose is probabilistic, so what's pinned here is the prompt
 * it receives. Before this, denied tools were simply absent from the tool list
 * and the model improvised a refusal — which could be unhelpful, wrong, or leak
 * the permission model.
 */
describe('buildSystemPrompt — TOOL ACCESS denial section', () => {
  // buildSystemPrompt needs no I/O; a bare instance is enough to reach it.
  const svc = new BotService({} as unknown as Anthropic, redis, mockIo([]));

  test('a non-empty denied list yields the verbatim canonical sentence', () => {
    const prompt = svc.buildSystemPrompt('Asha', 'team_member', ['get_attendance']);
    expect(prompt).toContain('TOOL ACCESS');
    expect(prompt).toContain(
      "I don't have permission to [action] on your behalf. Ask an admin to update your bot access settings.",
    );
  });

  test('carries the never-state-the-role constraint (APPFLOW §9)', () => {
    const prompt = svc.buildSystemPrompt('Asha', 'team_member', ['get_attendance']);
    expect(prompt).toContain('Never state which role or permission level is required.');
    expect(prompt).toContain('Never attempt a different tool to work around it.');
  });

  test('keeps the out-of-scope carve-out, so "what is the weather" is not a permission refusal', () => {
    const prompt = svc.buildSystemPrompt('Asha', 'team_member', ['get_attendance']);
    expect(prompt).toMatch(/portal does not cover at all/);
  });

  /**
   * The TTFT lever (NFR §1.2/§1.3), so it is pinned rather than left to drift.
   * A tool-calling turn is two streams and phase 1 returns a bare tool_use block
   * that emits no text — measured — so without this instruction nothing reaches
   * the user until the tool has run. Removing it silently doubles TTFT (measured
   * 959ms median with it, 1946ms without), and no other test would notice.
   */
  test('always instructs a short preamble before a tool call — the TTFT lever', () => {
    for (const denied of [[], ['get_attendance']]) {
      const prompt = svc.buildSystemPrompt('Asha', 'admin', denied);
      expect(prompt).toMatch(/before you call a tool/i);
    }
  });

  test('an empty denied list omits the section entirely — no wasted tokens', () => {
    const prompt = svc.buildSystemPrompt('Asha', 'admin', []);
    expect(prompt).not.toContain('TOOL ACCESS');
    expect(prompt).not.toContain('Ask an admin to update your bot access settings');
  });

  test('denied tools render as capability phrases, never raw tool names', () => {
    const prompt = svc.buildSystemPrompt('Asha', 'freelancer', ['get_attendance', 'get_audit_log']);
    expect(prompt).toContain('viewing attendance records');
    expect(prompt).toContain('viewing the audit log');
    expect(prompt).not.toContain('get_attendance');
    expect(prompt).not.toContain('get_audit_log');
  });

  test('an unknown tool name is dropped rather than echoed into the prompt', () => {
    const prompt = svc.buildSystemPrompt('Asha', 'admin', ['not_a_real_tool']);
    expect(prompt).not.toContain('not_a_real_tool');
    expect(prompt).not.toContain('TOOL ACCESS'); // nothing resolvable → no section
  });
});
