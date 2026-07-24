/**
 * BotService — the AI bot's read-side orchestration (Sprint 8 STEP 3, TRD §9.1).
 *
 * The loop, per message:
 *   load Redis session → build the system prompt (IST date + period + role + name
 *   + anti-hallucination) → filter the 11 query tools by resolvePermission →
 *   stream from Anthropic, emitting `bot:token { sessionId, delta }` per delta on
 *   /ws/notify room user:{staffId} → if the model asked for tools, run each via
 *   its isolating service method with the JWT currentUser, then a SECOND stream →
 *   a terminal `bot:message { sessionId, content, card?, toolsUsed? }`.
 *
 * Reconciliations honoured here: two socket events, never one overloaded (#3);
 * tools reuse isolating services with currentUser (#4); friendly errors only,
 * never a code or stack (#10); archive to messages channel='bot' (#14).
 */
import { randomUUID } from 'node:crypto';

import { currentIstDate, currentIstPeriod } from './BaseService.js';
import { PermissionService } from './PermissionService.js';
import { anthropicToolDefs, getBotTool } from '../lib/bot/tools/registry.js';
import { env } from '../lib/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

import type { CurrentUser } from './AttendanceService.js';
import type { BotCard } from '../lib/bot/tools/types.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { DB } from '@skaly/shared';
import type { Role } from '@skaly/shared/schemas/auth';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import type { Server } from 'socket.io';

const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h (TRD §9.4)
const MAX_TURNS = 50; // 50-turn cap, drop oldest (TRD §9.4)
const MAX_TOKENS = 1024;

// Friendly copy only — never a code or stack (Error-Handling §6, reconciliation #10).
const PERMISSION_DENIED_COPY =
  "I don't have permission to do that on your behalf. Ask an admin to update your bot access settings.";
const GENERIC_TOOL_ERROR_COPY =
  'Something went wrong. Please try again or make the change directly in the portal.';
const ANTHROPIC_ERROR_COPY = "I'm having trouble connecting right now. Please try again.";

export interface BotSession {
  sessionId: string;
  messages: Anthropic.MessageParam[];
  turnCount: number;
  lastActivityAt: string;
}

/** The GET /v1/bot/session/current shape (API-Contract §Bot, reconciliation #8).
 *  A conversational projection — tool plumbing is filtered out. */
export interface BotSessionView {
  sessionId: string | null;
  messages: Array<{ role: string; content: string }>;
  turnCount: number;
  lastActivityAt: string | null;
}

/** Plain text of a stored message: the string as-is, or the joined text blocks
 *  (tool_use / tool_result blocks yield '', so they drop out of the view). */
function extractText(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is Anthropic.TextBlockParam => (b as { type: string }).type === 'text')
      .map((b) => b.text)
      .join('');
  }
  return '';
}

export interface HandleMessageArgs {
  /** Pre-loaded by the route (so its sessionId is in the 202 and a Redis failure
   *  surfaces BEFORE the 202, never as an unhandled rejection in fire-and-forget). */
  session: BotSession;
  staffId: string;
  role: Role;
  userText: string;
  db: Kysely<DB>;
}

/** Prod uses Sonnet for tool-call accuracy; dev/test uses Haiku for cost (TRD §9). */
function botModel(): string {
  return env.NODE_ENV === 'production' ? env.ANTHROPIC_MODEL_PROD : env.ANTHROPIC_MODEL_DEV;
}

/** Keep the last `maxTurns` real user turns. A tool_result is role:'user' too, so
 *  only string-content user messages count as turns; slicing AT the oldest kept
 *  user message keeps every tool exchange intact and a valid user-first history
 *  (Anthropic requires the first message to be role:'user' — slicing after the
 *  dropped turn would orphan its assistant reply and start with 'assistant'). */
export function trimToTurns(messages: Anthropic.MessageParam[], maxTurns: number): Anthropic.MessageParam[] {
  let userTurns = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m !== undefined && m.role === 'user' && typeof m.content === 'string') {
      userTurns += 1;
      if (userTurns === maxTurns) return messages.slice(i); // slice at the oldest KEPT turn
    }
  }
  return messages; // fewer than maxTurns user turns — nothing to drop
}

export class BotService {
  private readonly permissions: PermissionService;
  private readonly model = botModel();

  constructor(
    private readonly anthropic: Anthropic,
    private readonly redis: Redis,
    private readonly io: Server,
  ) {
    this.permissions = new PermissionService(redis);
  }

  private sessionKey(staffId: string): string {
    return `bot:session:${staffId}`;
  }

  /** Load the Redis session, or create + persist a new one so its sessionId is
   *  stable across the 202 ack and the async stream. */
  async loadSession(staffId: string): Promise<BotSession> {
    const raw = await this.redis.get(this.sessionKey(staffId));
    if (raw) return JSON.parse(raw) as BotSession;
    const session: BotSession = {
      sessionId: randomUUID(),
      messages: [],
      turnCount: 0,
      lastActivityAt: new Date().toISOString(),
    };
    await this.redis.set(this.sessionKey(staffId), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
    return session;
  }

  async clearSession(staffId: string): Promise<void> {
    await this.redis.del(this.sessionKey(staffId));
  }

  /** Read-only conversational view for GET — never creates a session; returns the
   *  null-session shape when none exists. */
  async sessionView(staffId: string): Promise<BotSessionView> {
    const raw = await this.redis.get(this.sessionKey(staffId));
    if (!raw) return { sessionId: null, messages: [], turnCount: 0, lastActivityAt: null };
    const s = JSON.parse(raw) as BotSession;
    const messages = s.messages
      .map((m) => ({ role: m.role, content: extractText(m.content) }))
      .filter((m) => m.content.length > 0);
    return { sessionId: s.sessionId, messages, turnCount: s.turnCount, lastActivityAt: s.lastActivityAt };
  }

  private emit(staffId: string, event: 'bot:token' | 'bot:message', payload: Record<string, unknown>): void {
    this.io.of('/ws/notify').to(`user:${staffId}`).emit(event, payload);
  }

  async handleMessage({ session, staffId, role, userText, db }: HandleMessageArgs): Promise<void> {
    const { sessionId } = session;
    let fullText = '';

    try {
      const currentUser: CurrentUser = { staffId, role };
      const name = await this.staffName(staffId, db);
      const permittedNames = await this.permissions.getPermittedBotTools(staffId, role, db);
      const tools = anthropicToolDefs(permittedNames);
      const system = this.buildSystemPrompt(name, role);

      const messages: Anthropic.MessageParam[] = [...session.messages, { role: 'user', content: userText }];

      const onText = (delta: string): void => {
        fullText += delta;
        this.emit(staffId, 'bot:token', { sessionId, delta });
      };

      // ── Phase 1 ──────────────────────────────────────────────────────────
      const first = await this.stream(system, tools, messages, onText);
      messages.push({ role: 'assistant', content: first.content });

      let card: BotCard | undefined;
      const toolsUsed: string[] = [];
      const toolBlocks = first.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      // ── Phase 2 (only if the model asked for tools) ──────────────────────
      if (first.stop_reason === 'tool_use' && toolBlocks.length > 0) {
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of toolBlocks) {
          const { toolResult, cardOut, used } = await this.runTool(block, permittedNames, currentUser, db);
          results.push(toolResult);
          if (used) toolsUsed.push(block.name);
          if (cardOut) card = cardOut; // multiple tools → the last card wins (documented)
        }
        messages.push({ role: 'user', content: results });

        const second = await this.stream(system, tools, messages, onText);
        messages.push({ role: 'assistant', content: second.content });
      }

      // ── Terminal message — the render finalises once ─────────────────────
      this.emit(staffId, 'bot:message', { sessionId, content: fullText, card, toolsUsed });

      // Best-effort persistence — a failure here must not fire the error copy.
      await this.persistSession(staffId, sessionId, session.turnCount, messages).catch((err) =>
        logger.error({ err, staffId }, 'bot session persist failed'),
      );
      await this.archiveBotMessage(staffId, fullText, db).catch((err) =>
        logger.error({ err, staffId }, 'bot message archive failed'),
      );
    } catch (err) {
      // Anthropic unreachable after the SDK's built-in 429/529 retries, or a
      // mid-stream failure. Mid-stream is NOT retryable (a restart would duplicate
      // already-streamed text), so finalize with whatever streamed + the friendly
      // error rather than restarting the stream.
      logger.error({ err, staffId }, 'bot handleMessage failed');
      const content = fullText ? `${fullText}\n\n${ANTHROPIC_ERROR_COPY}` : ANTHROPIC_ERROR_COPY;
      this.emit(staffId, 'bot:message', { sessionId, content, toolsUsed: [] });
    }
  }

  private async stream(
    system: string,
    tools: Anthropic.Tool[],
    messages: Anthropic.MessageParam[],
    onText: (delta: string) => void,
  ): Promise<Anthropic.Message> {
    const stream = this.anthropic.messages.stream({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system,
      tools: tools.length > 0 ? tools : undefined,
      messages,
    });
    stream.on('text', onText);
    return stream.finalMessage();
  }

  private async runTool(
    block: Anthropic.ToolUseBlock,
    permittedNames: readonly string[],
    currentUser: CurrentUser,
    db: Kysely<DB>,
  ): Promise<{ toolResult: Anthropic.ToolResultBlockParam; cardOut?: BotCard; used: boolean }> {
    const mk = (content: string, isError = false): Anthropic.ToolResultBlockParam => ({
      type: 'tool_result',
      tool_use_id: block.id,
      content,
      is_error: isError,
    });

    const tool = getBotTool(block.name);
    // Defence in depth: the tool list sent to Anthropic was already filtered, but
    // refuse anything not permitted rather than trust the model.
    if (!tool || !permittedNames.includes(block.name)) {
      return { toolResult: mk(PERMISSION_DENIED_COPY, true), used: false };
    }

    const parsed = tool.inputSchema.safeParse(block.input ?? {});
    if (!parsed.success) {
      return { toolResult: mk('That request was missing or had an invalid detail. Please rephrase.', true), used: false };
    }

    try {
      const { text, card } = await tool.handler(parsed.data, currentUser, db);
      return { toolResult: mk(text), cardOut: card, used: true };
    } catch (err) {
      if (err instanceof AppError && (err.code === 'PERMISSION_DENIED' || err.code === 'BOT_TOOL_DENIED')) {
        return { toolResult: mk(PERMISSION_DENIED_COPY, true), used: false };
      }
      logger.error({ err, tool: block.name, staffId: currentUser.staffId }, 'bot tool execution failed');
      return { toolResult: mk(GENERIC_TOOL_ERROR_COPY, true), used: false };
    }
  }

  private buildSystemPrompt(name: string, role: Role): string {
    return [
      'You are the AI assistant for the Scaly business management portal.',
      `Current date (IST): ${currentIstDate()}. Current period: ${currentIstPeriod()}.`,
      `You are assisting ${name} (role: ${role}).`,
      'Only use the provided tools to answer questions about portal data. If the data is unavailable or you have no tool for it, say so plainly — never invent data.',
      'You can only see data this user is authorised for; do not claim access to anything outside the tools you were given.',
    ].join('\n');
  }

  private async staffName(staffId: string, db: Kysely<DB>): Promise<string> {
    const row = await db.selectFrom('staff').select('name').where('id', '=', staffId).executeTakeFirst();
    return row?.name ?? 'there';
  }

  private async persistSession(
    staffId: string,
    sessionId: string,
    prevTurnCount: number,
    messages: Anthropic.MessageParam[],
  ): Promise<void> {
    const updated: BotSession = {
      sessionId,
      messages: trimToTurns(messages, MAX_TURNS),
      turnCount: Math.min(prevTurnCount + 1, MAX_TURNS),
      lastActivityAt: new Date().toISOString(),
    };
    await this.redis.set(this.sessionKey(staffId), JSON.stringify(updated), 'EX', SESSION_TTL_SECONDS);
  }

  /** Archive the user's message and return its row id — the C-01 `messageId`. The
   *  route calls this SYNCHRONOUSLY before sending the 202 (TRD §9.1). */
  async archiveUserMessage(staffId: string, content: string, db: Kysely<DB>): Promise<string> {
    const row = await db
      .insertInto('messages')
      .values({ channel: 'bot', sender_id: staffId, sender_type: 'user', content, content_type: 'text' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  private async archiveBotMessage(staffId: string, content: string, db: Kysely<DB>): Promise<void> {
    await db
      .insertInto('messages')
      .values({ channel: 'bot', sender_id: staffId, sender_type: 'bot', content, content_type: 'text' })
      .execute();
  }
}
