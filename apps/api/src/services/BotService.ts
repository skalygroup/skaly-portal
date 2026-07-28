/**
 * BotService — the AI bot's read-side orchestration (Sprint 8 STEP 3, TRD §9.1).
 *
 * The loop, per message:
 *   load Redis session → build the system prompt (IST date + period + role + name
 *   + anti-hallucination) → filter the 11 query tools by resolvePermission →
 *   stream from Anthropic, emitting `bot:token { sessionId, delta }` per delta on
 *   /ws/notify room user:{staffId} → while the model asks for tools, run each via
 *   its isolating service method with the JWT currentUser and stream again, up to
 *   MAX_TOOL_ROUNDS (ADR-018 — Sprint 8's fixed two-phase loop poisoned the
 *   session) → a terminal `bot:message { sessionId, content, card?, toolsUsed? }`.
 *
 * Reconciliations honoured here: two socket events, never one overloaded (#3);
 * tools reuse isolating services with currentUser (#4); friendly errors only,
 * never a code or stack (#10); archive to messages channel='bot' (#14).
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import { currentIstDate, currentIstPeriod } from './BaseService.js';
import { PermissionService } from './PermissionService.js';
import { withActorSource } from '../lib/bot/actor-context.js';
import { buildSummary, makePending, resolveTurn2 } from '../lib/bot/confirmation.js';
import { botErrorCopy } from '../lib/bot/error-copy.js';
import { anthropicToolDefs, capabilityPhrases, getBotTool } from '../lib/bot/tools/registry.js';
import { env } from '../lib/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

import type { CurrentUser } from './AttendanceService.js';
import type { PendingConfirmation } from '../lib/bot/confirmation.js';
import type { ErrorCopyContext } from '../lib/bot/error-copy.js';
import type { BotCard, BotTool } from '../lib/bot/tools/types.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { DB } from '@skaly/shared';
import type { Role } from '@skaly/shared/schemas/auth';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import type { Server } from 'socket.io';

const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h (TRD §9.4)
const MAX_TURNS = 50; // 50-turn cap, drop oldest (TRD §9.4)
const MAX_TOKENS = 1024;
/** Turns returned by the archive fallback — same order of magnitude as the 50-turn
 *  live cap, so a restored conversation looks like the one that expired. */
const ARCHIVE_VIEW_LIMIT = 100;
/** Janitor only — the gate is the record's own 5-minute `expiresAt` (ADR-014). */
const PENDING_JANITOR_TTL_SECONDS = 15 * 60;
/**
 * Tool rounds per user turn. Look-up-then-act needs two; the rest is headroom for
 * a retry after a bad argument. The cap is what keeps this a bounded loop rather
 * than an agent, and it bounds cost and latency with it.
 */
const MAX_TOOL_ROUNDS = 4;

// Friendly copy only — never a code or stack (Error-Handling §6, reconciliation #10).
//
// Backstop only — unpermitted tools are filtered before the model sees them, so
// this fires only if the model invents a tool name. The normal denial path is the
// system prompt's TOOL ACCESS section (Sprint 8.1).
const PERMISSION_DENIED_COPY =
  "I don't have permission to do that on your behalf. Ask an admin to update your bot access settings.";
/** The same sentence in its canonical templated form (Error-Handling §6 /
 *  APPFLOW §9) — the model fills [action] with what was actually asked for. */
const PERMISSION_DENIED_TEMPLATE =
  "I don't have permission to [action] on your behalf. Ask an admin to update your bot access settings.";
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
  /** The `messages` row id of the user's turn, from the route's archiveUserMessage.
   *  ADR-021: the bot's reply links to it via parent_id, and ownership resolves as
   *  COALESCE(m.sender_id, parent.sender_id) — which only works because the row this
   *  points at carries sender_id. */
  userMessageId: string;
  db: Kysely<DB>;
  /** Turn-2 consent from the inline buttons (ADR-014 §1). When `decision` is
   *  present the gate reads it and NEVER `userText` — that string is only the
   *  display line archived to the transcript. */
  decision?: 'confirm' | 'cancel';
  confirmationId?: string;
}

/** APPFLOW §9 turn-2 copy. Deterministic — turn 2 makes no model call, so these
 *  are the literal strings the user sees. */
const CANCELLED_COPY = 'Okay, no changes made.';
const EXPIRED_COPY = 'That confirmation timed out — want me to set it up again?';
const STALE_ID_COPY = "I've already handled that one. What would you like to do?";
const NOT_FOUND_COPY = "I couldn't find that record. Could you tell me which one you mean?";

/**
 * Fed back for a mutation `tool_use` block at turn 1 INSTEAD of executing it.
 *
 * Mandatory, not cosmetic: the Anthropic API rejects any request where a
 * `tool_use` block has no matching `tool_result` in the following turn. Omitting
 * it produces a 400 on the user's NEXT message, which reads as an unrelated bug.
 */
const AWAITING_CONFIRMATION_RESULT = [
  'AWAITING_USER_CONFIRMATION. A summary has been presented to the user for approval.',
  'Do not call this tool again. Ask the user to confirm, briefly.',
].join('\n');

/** Prod uses Sonnet for tool-call accuracy; dev/test uses Haiku for cost (TRD §9). */
function botModel(): string {
  return env.NODE_ENV === 'production' ? env.ANTHROPIC_MODEL_PROD : env.ANTHROPIC_MODEL_DEV;
}

/** Keep the last `maxTurns` real user turns. A tool_result is role:'user' too, so
 *  only string-content user messages count as turns; slicing AT the oldest kept
 *  user message keeps every tool exchange intact and a valid user-first history
 *  (Anthropic requires the first message to be role:'user' — slicing after the
 *  dropped turn would orphan its assistant reply and start with 'assistant'). */
/**
 * Enforce `tool_use` ⇄ `tool_result` pairing in BOTH directions, keyed on
 * `tool_use_id`: drop a `tool_use` with no `tool_result` in the following message,
 * and drop a `tool_result` whose `tool_use` is not there (or was just dropped).
 *
 * The Anthropic API rejects a transcript containing either, so persisting one
 * poisons the session permanently: every later message 400s and the user sees
 * "I'm having trouble connecting" until they start a new conversation. Sprint 8 did
 * exactly that whenever its second stream asked for another tool.
 *
 * Runs at BOTH boundaries, deliberately (ADR-018 §3):
 *   - persist, so a bad transcript is never stored; and
 *   - READ, before the first API call of every message, so a session poisoned by an
 *     older build heals itself on the user's next message instead of staying broken
 *     for its whole 12h TTL.
 * Two choke points every path already passes through, rather than auditing each
 * branch for a rule it could quietly stop following. A message left with no content
 * at all is dropped entirely.
 */
export function stripDanglingToolUse(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  /** tool_use ids we KEPT — a tool_result is an orphan unless its id is in here. */
  const issued = new Set<string>();

  for (const [i, m] of messages.entries()) {
    if (!Array.isArray(m.content)) {
      out.push(m);
      continue;
    }

    const next = messages[i + 1];
    const kept = m.content.filter((b) => {
      const block = b as { type?: string; id?: string; tool_use_id?: string };

      if (block.type === 'tool_use') {
        const answered =
          Array.isArray(next?.content) &&
          next.content.some(
            (r) =>
              (r as { type?: string }).type === 'tool_result' &&
              (r as { tool_use_id?: string }).tool_use_id === block.id,
          );
        if (answered && block.id !== undefined) issued.add(block.id);
        return answered;
      }
      if (block.type === 'tool_result') {
        return block.tool_use_id !== undefined && issued.has(block.tool_use_id);
      }
      return true;
    });

    if (kept.length === m.content.length) {
      out.push(m);
    } else if (kept.length > 0) {
      out.push({ ...m, content: kept });
    }
    // else: nothing but unpaired blocks — drop the message.
  }

  return out;
}

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

  // ── Pending confirmation (ADR-014 §3) ─────────────────────────────────────
  //
  // Its own key, deliberately, and NOT a field inside the session blob.
  // `consumePending` has to be atomic or a double-click fires an irreversible
  // write twice — and inside the blob it cannot be:
  //   - WATCH/MULTI is per-CONNECTION, and this app shares one ioredis client, so
  //     two concurrent consumers on the same connection both pass the CAS.
  //   - a Lua script would have to cjson-decode/encode the whole session, and
  //     cjson turns an empty `messages: []` into `{}` — corrupting the transcript
  //     to protect the pending record.
  // A dedicated key makes the consume a single atomic GETDEL on a shared
  // connection, which is exactly the primitive this needs.
  private pendingKey(staffId: string): string {
    return `bot:pending:${staffId}`;
  }

  /**
   * Store the turn-1 record, replacing any previous one (single-pending rule).
   *
   * The Redis TTL is deliberately LONGER than the record's own 5-minute
   * `expiresAt`: expiry is decided on read so an expired confirmation can be
   * reported as "that timed out" instead of being indistinguishable from one that
   * never existed. The TTL is only a janitor for abandoned records.
   */
  async setPending(staffId: string, pending: PendingConfirmation): Promise<void> {
    await this.redis.set(
      this.pendingKey(staffId),
      JSON.stringify(pending),
      'EX',
      PENDING_JANITOR_TTL_SECONDS,
    );
  }

  /** Read AND clear in one atomic step, before execution — so a double-click
   *  finds nothing the second time. Returns null when there is none. */
  async consumePending(staffId: string): Promise<PendingConfirmation | null> {
    const raw = await this.redis.getdel(this.pendingKey(staffId));
    return raw ? (JSON.parse(raw) as PendingConfirmation) : null;
  }

  /** Peek without consuming — for resolving intent before deciding to execute. */
  async peekPending(staffId: string): Promise<PendingConfirmation | null> {
    const raw = await this.redis.get(this.pendingKey(staffId));
    return raw ? (JSON.parse(raw) as PendingConfirmation) : null;
  }

  /** Cancel, expiry, non-affirmative, and replacement all clear it. */
  async clearPending(staffId: string): Promise<void> {
    await this.redis.del(this.pendingKey(staffId));
  }

  /** Load the Redis session, or create + persist a new one so its sessionId is
   *  stable across the 202 ack and the async stream. */
  async loadSession(staffId: string, db: Kysely<DB>): Promise<BotSession> {
    const raw = await this.redis.get(this.sessionKey(staffId));
    if (raw) return JSON.parse(raw) as BotSession;
    const session: BotSession = {
      sessionId: randomUUID(),
      messages: [],
      turnCount: 0,
      lastActivityAt: new Date().toISOString(),
    };
    await this.redis.set(this.sessionKey(staffId), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);

    // ADR-021 §4: one bot_sessions row per conversation, created at the same moment
    // as the Redis session. The Redis blob's sessionId IS the row's PK, so the
    // envelope needs no second identifier — and migration 020's table stops being an
    // orphan no sprint wrote to. Best-effort: losing the envelope must not fail the
    // user's message, because parent_id (not this) is what carries ownership.
    await db
      .insertInto('bot_sessions')
      .values({ id: session.sessionId, staff_id: staffId })
      .execute()
      .catch((err: unknown) => logger.error({ err, staffId }, 'bot session envelope insert failed'));

    // A live session supersedes any "cleared" marker — leaving it would only matter if
    // this session later expired, and by then the clear is long spent.
    await this.redis.del(this.clearedKey(staffId));

    return session;
  }

  /**
   * "New conversation" — drop the live session AND record that it was deliberate.
   *
   * The marker exists because the ADR-021 archive fallback cannot otherwise tell two
   * very different situations apart: a session that EXPIRED after 12h (where the user
   * wants their history back) and one the user explicitly CLEARED (where they asked for
   * a blank slate). Both leave Redis empty, so without this the Clear button appears to
   * do nothing — the old conversation is immediately resurrected from the archive.
   *
   * Scoped to the session TTL on purpose: "start fresh" is an intent about the current
   * session, and once that window has passed the live session would have expired
   * anyway, so letting the archive become reachable again is the correct end state.
   */
  async clearSession(staffId: string): Promise<void> {
    await this.redis.del(this.sessionKey(staffId));
    await this.redis.set(this.clearedKey(staffId), '1', 'EX', SESSION_TTL_SECONDS);
  }

  private clearedKey(staffId: string): string {
    return `bot:cleared:${staffId}`;
  }

  /** Read-only conversational view for GET — never creates a session; returns the
   *  null-session shape when none exists. */
  async sessionView(staffId: string, db: Kysely<DB>): Promise<BotSessionView> {
    const raw = await this.redis.get(this.sessionKey(staffId));
    // ADR-021 §5: Redis first, then the archive. Without this fallback the 12-month
    // retention keeps rows nobody can reach — attributable but write-only, which is
    // barely better than unattributable.
    //
    // …but NOT after an explicit clear. See clearSession: an expired session and a
    // cleared one are indistinguishable from Redis alone, and resurrecting a
    // conversation the user just dismissed is worse than losing the fallback.
    if (!raw) {
      const cleared = await this.redis.get(this.clearedKey(staffId));
      if (cleared) return { sessionId: null, messages: [], turnCount: 0, lastActivityAt: null };
      return this.archivedView(staffId, db);
    }
    const s = JSON.parse(raw) as BotSession;
    const messages = s.messages
      .map((m) => ({ role: m.role, content: extractText(m.content) }))
      .filter((m) => m.content.length > 0);
    return { sessionId: s.sessionId, messages, turnCount: s.turnCount, lastActivityAt: s.lastActivityAt };
  }

  /**
   * The archive rendered in the shape the live session returns, oldest-first so the
   * client renders it identically whichever source served it. `sessionId` is null:
   * the conversation is readable but no longer resumable, which is exactly true once
   * the Redis envelope has expired.
   */
  private async archivedView(staffId: string, db: Kysely<DB>): Promise<BotSessionView> {
    const rows = await this.getBotConversation(staffId, ARCHIVE_VIEW_LIMIT, 0, db);
    if (rows.length === 0) return { sessionId: null, messages: [], turnCount: 0, lastActivityAt: null };
    const ordered = [...rows].reverse();
    return {
      sessionId: null,
      messages: ordered.map((r) => ({
        role: r.sender_type === 'bot' ? ('assistant' as const) : ('user' as const),
        content: r.content,
      })),
      turnCount: ordered.filter((r) => r.sender_type === 'user').length,
      lastActivityAt: rows[0]!.created_at.toISOString(),
    };
  }

  private emit(staffId: string, event: 'bot:token' | 'bot:message', payload: Record<string, unknown>): void {
    this.io.of('/ws/notify').to(`user:${staffId}`).emit(event, payload);
  }

  /**
   * The ONE way a terminal turn leaves this service: persist, THEN emit.
   *
   * Same discipline as NotificationService (Sprint 2). A client that was
   * disconnected when the socket fired recovers the turn from
   * GET /v1/bot/session/current — but only if it was written first. Emitting first
   * loses the turn for exactly the user who most needs it.
   */
  private async finalise(args: {
    staffId: string;
    sessionId: string;
    turnCount: number;
    messages: Anthropic.MessageParam[];
    content: string;
    card?: BotCard;
    toolsUsed?: string[];
    parentId: string;
    db: Kysely<DB>;
  }): Promise<void> {
    const { staffId, sessionId, turnCount, messages, content, card, toolsUsed = [], parentId, db } = args;

    // `messages` is persisted exactly as given — the caller owns the transcript
    // shape. The tool-loop path already ends with the assistant's blocks; the
    // turn-2 paths append their own server-rendered line.
    await this.persistSession(staffId, sessionId, turnCount, messages).catch((err) =>
      logger.error({ err, staffId }, 'bot session persist failed'),
    );

    // BOTH durable writes precede the emit (ADR-021 §6). The DB archive used to run
    // after it, which left the 12-month archive — the only record that outlives the
    // 12h Redis TTL — losing exactly the turn a disconnected client needs to recover.
    await this.archiveBotMessage(staffId, content, db, parentId).catch((err) =>
      logger.error({ err, staffId }, 'bot message archive failed'),
    );
    await this.touchBotSession(sessionId, db);

    this.emit(staffId, 'bot:message', { sessionId, content, card, toolsUsed });
  }

  /**
   * The turn-2 branch. Returns true when it handled the message (so handleMessage
   * returns without ever touching Anthropic), false to fall through to the normal
   * Sprint 8 flow.
   *
   * Every outcome here is server-rendered. The five resolutions come from
   * `resolveTurn2`, which is pure and unit-tested per branch.
   */
  private async handleTurn2(args: HandleMessageArgs, currentUser: CurrentUser): Promise<boolean> {
    const { session, staffId, userText, userMessageId, db, decision, confirmationId } = args;
    const { sessionId } = session;

    const pending = await this.peekPending(staffId);
    // Fast path: no pending record and no button press is the overwhelmingly common
    // case — don't make every ordinary question pay for the machinery.
    if (!pending && !decision) return false;

    const resolution = resolveTurn2(pending, { content: userText, confirmationId, decision });
    const messages: Anthropic.MessageParam[] = [
      ...session.messages,
      { role: 'user', content: userText },
    ];
    // Turn 2 produces no model output, so the archived assistant turn IS the copy.
    const finalise = (content: string, card?: BotCard, toolsUsed?: string[]): Promise<void> =>
      this.finalise({
        staffId,
        sessionId,
        turnCount: session.turnCount,
        messages: [...messages, { role: 'assistant', content }],
        content,
        card,
        toolsUsed,
        parentId: userMessageId,
        db,
      });

    switch (resolution.kind) {
      case 'cancelled':
        await this.clearPending(staffId);
        await finalise(CANCELLED_COPY);
        return true;

      case 'expired':
        await this.clearPending(staffId);
        await finalise(EXPIRED_COPY);
        return true;

      case 'stale_id':
        await finalise(STALE_ID_COPY);
        return true;

      case 'none':
        // A pending confirmation does NOT survive an unrelated message. This is the
        // path a qualified "yes, but make it Friday" takes: the summary the user
        // consented to no longer matches what they want, so it is discarded and
        // re-planned as a fresh turn rather than executed.
        await this.clearPending(staffId);
        return false;

      case 'execute':
        await this.executeConfirmed(resolution.pending, args, currentUser, messages, finalise);
        return true;
    }
  }

  /**
   * Execute a confirmed mutation. Consume first, then re-validate, then write.
   */
  private async executeConfirmed(
    resolved: PendingConfirmation,
    args: HandleMessageArgs,
    currentUser: CurrentUser,
    _messages: Anthropic.MessageParam[],
    finalise: (content: string, card?: BotCard, toolsUsed?: string[]) => Promise<void>,
  ): Promise<void> {
    const { staffId, role, db } = args;

    // CONSUME BEFORE EXECUTING — the whole point of consume-once. An atomic GETDEL,
    // so of two concurrent double-clicks only one gets a record; the loser sees null
    // and is told it has already been handled rather than firing the write twice.
    const pending = await this.consumePending(staffId);
    if (!pending || pending.confirmationId !== resolved.confirmationId) {
      await finalise(STALE_ID_COPY);
      return;
    }

    const tool = getBotTool(pending.toolName);
    if (!tool) {
      logger.error({ staffId, tool: pending.toolName }, 'confirmed tool no longer in registry');
      await finalise(botErrorCopy(null));
      return;
    }

    // RE-RESOLVE THE PERMISSION (ADR-014 §6). Five minutes is long enough for an
    // admin to revoke a bot tool, and nothing else on this path would notice: the
    // services assert ROLE, not the per-user bot.tool.* override.
    const { permitted } = await this.permissions.getPermittedBotTools(staffId, role, db);
    if (!permitted.includes(pending.toolName)) {
      // The summary's action reads as a verb phrase ("mark task as done"), which fits
      // the §6 template. `capability` is a gerund built for the denial LIST
      // ("changing a task status") and produces "permission to changing…" here.
      await finalise(
        botErrorCopy({ code: 'BOT_TOOL_DENIED' }, { action: pending.summary.action.toLowerCase() }),
      );
      return;
    }

    // The period lock is deliberately NOT re-asserted here. Every service whose
    // target is period-scoped calls assertPeriodNotLocked INSIDE its own
    // transaction, which is strictly stronger than a check out here: atomic with
    // the write, and reading the real period rather than the summary's display
    // string. A duplicate pre-check would only add a race it cannot close.
    try {
      // The write, and the ONLY place a mutation handler is ever called.
      const result = await withActorSource('bot', () =>
        tool.handler(pending.input, currentUser, db, pending.expectedVersion),
      );

      // Server-rendered outcome — the summary the user consented to, restated. No
      // model call produced this sentence.
      const content = `Done — ${pending.summary.action}: ${pending.summary.target}.`;
      await finalise(
        content,
        { type: 'mutation_result', summary: pending.summary, link: result.link },
        [pending.toolName],
      );
    } catch (err) {
      logger.error({ err, staffId, tool: pending.toolName }, 'confirmed bot mutation failed');
      await finalise(botErrorCopy(err, this.errorContext(err, pending)));
    }
  }

  /** Interpolation for the error copy, pulled from the error's own details rather
   *  than guessed — STALE_DATA carries who moved the record, and saying their name
   *  is the difference between a dead end and a next step. */
  private errorContext(err: unknown, pending: PendingConfirmation): ErrorCopyContext {
    const details = (err as { details?: Record<string, unknown> } | null)?.details;
    const updatedBy = (details?.updatedBy as { name?: string } | null | undefined)?.name;
    const dependency = (details?.dependencyTask as { description?: string } | null | undefined)
      ?.description;
    return {
      month: pending.summary.period,
      action: pending.summary.action.toLowerCase(),
      updatedBy: updatedBy ?? undefined,
      dependency: dependency ?? undefined,
    };
  }

  async handleMessage(args: HandleMessageArgs): Promise<void> {
    const { session, staffId, role, userText, userMessageId, db } = args;
    const { sessionId } = session;
    let fullText = '';

    try {
      const currentUser: CurrentUser = { staffId, role };

      // ── TURN 2 RUNS FIRST, before anything else (ADR-014 §5) ─────────────
      // Zero model calls on any branch below. A confirmed change must not be
      // narrated by a probabilistic system, and it saves a full round trip.
      if (await this.handleTurn2(args, currentUser)) return;

      const name = await this.staffName(staffId, db);
      // Only `permitted` reaches the model; `denied` never becomes a tool def —
      // it goes into the prompt so the refusal is our copy, not the model's
      // improvisation (Sprint 8.1 Defect 2).
      const { permitted: permittedNames, denied } = await this.permissions.getPermittedBotTools(
        staffId,
        role,
        db,
      );
      const tools = anthropicToolDefs(permittedNames);
      const system = this.buildSystemPrompt(name, role, denied);

      // Sanitise the REPLAYED history, not just what we are about to store: a
      // session poisoned before this fix shipped would otherwise 400 on every
      // message until its TTL expired (ADR-018 §3). Every later call in the loop
      // builds on this array, so one pass here covers all of them.
      const messages: Anthropic.MessageParam[] = [
        ...stripDanglingToolUse(session.messages),
        { role: 'user', content: userText },
      ];

      const onText = (delta: string): void => {
        fullText += delta;
        this.emit(staffId, 'bot:token', { sessionId, delta });
      };

      let card: BotCard | undefined;
      const toolsUsed: string[] = [];

      // ── The tool loop ────────────────────────────────────────────────────
      //
      // BOUNDED, not fixed at two phases. Sprint 8 ran exactly stream → tools →
      // stream, which had two consequences found by driving the real UI:
      //
      //   1. If the SECOND stream also returned a tool_use, it was persisted with
      //      no matching tool_result. The Anthropic API rejects that, so every
      //      later message in the session 400'd — surfacing as "I'm having trouble
      //      connecting" forever, until the user started a new conversation. The
      //      session was permanently poisoned by one ordinary retry.
      //   2. A mutation was unreachable by natural language. The system prompt
      //      tells the model to look an id up first, which spends round 1 — and
      //      there was no round 2 to act in. It only worked if the user already
      //      knew the uuid.
      //
      // The cap is what keeps this a loop and not an agent: a handful of rounds is
      // ample for look-up-then-act, and it bounds both cost and latency.
      let staged = false; // a confirmation was staged — see below
      let capped = true; // still true only if every round asked for another tool
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const reply = await this.stream(system, tools, messages, onText);
        messages.push({ role: 'assistant', content: reply.content });

        const toolBlocks = reply.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        if (reply.stop_reason !== 'tool_use' || toolBlocks.length === 0) {
          capped = false;
          break;
        }

        // Every tool_use gets a tool_result in the very next message — including
        // the synthetic one the confirmation interceptor returns. That invariant is
        // the whole fix, and it now holds on every round rather than only the first.
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of toolBlocks) {
          const { toolResult, cardOut, used } = await this.runTool(block, permittedNames, currentUser, db);
          results.push(toolResult);
          if (used) toolsUsed.push(block.name);
          if (cardOut) {
            card = cardOut; // multiple tools → the last card wins (documented)
            if (cardOut.type === 'confirmation') staged = true;
          }
        }
        messages.push({ role: 'user', content: results });

        if (staged) {
          // A pending confirmation exists. Take ONE more stream so the model asks
          // the question conversationally, then stop unconditionally: continuing
          // would let it stage a second mutation in the same turn, and the
          // single-pending rule would silently discard the one the user is about to
          // be shown.
          const ask = await this.stream(system, tools, messages, onText);
          messages.push({ role: 'assistant', content: ask.content });
          // If it reached for another tool anyway, answer that block rather than
          // leaving it dangling — the 400 above is exactly what we are fixing.
          const dangling = ask.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
          );
          if (dangling.length > 0) {
            messages.push({
              role: 'user',
              content: dangling.map((b) => ({
                type: 'tool_result' as const,
                tool_use_id: b.id,
                content: AWAITING_CONFIRMATION_RESULT,
                is_error: false,
              })),
            });
          }
          capped = false;
          break;
        }
      }

      // Cap hit: the model still wanted tools. Finalise with whatever it streamed
      // plus the friendly copy — the same graceful finalisation the mid-stream
      // failure path uses (11-THIRD-PARTY §3.4). NOT another stream: a throw here,
      // or a retry that duplicates already-streamed text, reads to the user as
      // exactly the "trouble connecting" bug this loop was rewritten to fix.
      if (capped) {
        fullText = fullText ? `${fullText}\n\n${GENERIC_TOOL_ERROR_COPY}` : GENERIC_TOOL_ERROR_COPY;
      }

      // ── Terminal message — persist, THEN emit (see finalise) ─────────────
      // The assistant's tool blocks are already in `messages`; finalise appends the
      // conversational text, so the transcript keeps both.
      await this.finalise({
        staffId,
        sessionId,
        turnCount: session.turnCount,
        messages,
        content: fullText,
        card,
        toolsUsed,
        parentId: userMessageId,
        db,
      });
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

  /**
   * Turn 1 for a mutation tool: read the target, render the summary, store ONE
   * pending record, and hand the model a synthetic tool_result so it asks the
   * question conversationally. The tool is not executed.
   */
  private async prepareConfirmation(
    tool: BotTool,
    input: Record<string, unknown>,
    currentUser: CurrentUser,
    db: Kysely<DB>,
    mk: (content: string, isError?: boolean) => Anthropic.ToolResultBlockParam,
  ): Promise<{ toolResult: Anthropic.ToolResultBlockParam; cardOut?: BotCard; used: boolean }> {
    if (!tool.readCurrent || !tool.summary) {
      // Unreachable via defineMutationTool, which requires both. Refuse rather than
      // execute — a mutation tool that cannot describe itself must not run.
      logger.error({ tool: tool.name }, 'mutation tool missing readCurrent/summary');
      return { toolResult: mk(botErrorCopy(null), true), used: false };
    }

    let current;
    try {
      // The anti-hallucination gate. A made-up id 404s HERE, so no pending record
      // is ever created for a record that does not exist.
      current = await tool.readCurrent(input, currentUser, db);
    } catch (err) {
      logger.info({ err, tool: tool.name, staffId: currentUser.staffId }, 'mutation target read failed');
      const code = (err as { code?: string } | null)?.code;
      return {
        toolResult: mk(code === 'RESOURCE_NOT_FOUND' ? NOT_FOUND_COPY : botErrorCopy(err), true),
        used: false,
      };
    }

    // A request that changes nothing gets a plain answer, not a confirmation card
    // for an empty diff. No pending record — there is nothing to consent to.
    if (current.noChange) {
      return { toolResult: mk(current.noChange), used: false };
    }

    const pending = makePending({
      confirmationId: randomUUID(),
      toolName: tool.name,
      input,
      expectedVersion: current.version,
      summary: buildSummary(tool.summary, input, current.state),
    });
    // Replaces any previous pending record — one intent at a time (ADR-014 §3).
    await this.setPending(currentUser.staffId, pending);

    return {
      toolResult: mk(AWAITING_CONFIRMATION_RESULT),
      cardOut: {
        type: 'confirmation',
        confirmationId: pending.confirmationId,
        toolName: pending.toolName,
        summary: pending.summary,
      },
      // Not "used" — nothing was written. toolsUsed reports completed work.
      used: false,
    };
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
      // No pending state on an invalid input — the normal tool-error path.
      return { toolResult: mk('That request was missing or had an invalid detail. Please rephrase.', true), used: false };
    }

    // ── TURN-1 INTERCEPTOR (ADR-014) ──────────────────────────────────────
    // A mutation NEVER executes here. If you find yourself calling handler()
    // before consent, stop. Query tools (isMutation: false) skip this entirely and
    // take the unchanged Sprint 8 path below.
    if (tool.isMutation) {
      return this.prepareConfirmation(tool, parsed.data as Record<string, unknown>, currentUser, db, mk);
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

  /**
   * The system prompt. `denied` carries the tools this caller may NOT use.
   *
   * Those tools are stripped from the Anthropic `tools` array before the model
   * sees them, so without this section the model has no idea a capability was
   * withheld and improvises a refusal — which may be unhelpful, factually wrong
   * ("attendance isn't tracked here"), or leak the permission model. Naming them
   * here makes the denial OUR copy (Error-Handling §6 / APPFLOW §9) instead.
   */
  buildSystemPrompt(name: string, role: Role, denied: readonly string[] = []): string {
    const base = [
      'You are the AI assistant for the Scaly business management portal.',
      `Current date (IST): ${currentIstDate()}. Current period: ${currentIstPeriod()}.`,
      `You are assisting ${name} (role: ${role}).`,
      'Only use the provided tools to answer questions about portal data. If the data is unavailable or you have no tool for it, say so plainly — never invent data.',
      'You can only see data this user is authorised for; do not claim access to anything outside the tools you were given.',
      // TTFT (NFR §1.2/§1.3). A tool-calling turn is two streams, and phase 1
      // returns a bare tool_use block — measured: it emits NO text at all, so
      // nothing reaches the user until the tool has run and phase 2 begins. That
      // put the first visible token at ~2s median, 4.5s worst.
      //
      // Asking for one sentence up front gives phase 1 something to stream while
      // the tool runs, which is also just what a person does ("let me check…").
      // It is real output, not a spinner dressed up as text.
      'Before you call a tool, first write ONE short sentence (under 12 words) saying what you are about to look up, then call the tool.',
      // Sprint 9: there is deliberately no fuzzy-id resolver. A guessed id fails the
      // turn-1 existence read, which is a wasted turn for the user — so make looking
      // it up the instruction rather than the fallback.
      'To act on a record, first look it up with a query tool to obtain its id. Never guess an id.',
    ];

    // Omitted entirely when nothing is denied — no wasted tokens, and no
    // invitation to refuse things this caller can actually do.
    const phrases = capabilityPhrases(denied);
    if (phrases.length === 0) return base.join('\n');

    return [
      // THE BASE PROMPT COMPETES WITH THE DENIAL BLOCK, and the base line wins by
      // default — it is more general and it comes first. Measured: with attendance
      // denied, the model answered "I don't have access to attendance records
      // through the portal tools available to me", which is precisely the
      // "no tool for it, say so plainly" instruction being followed. Naming the
      // exception where that instruction is given is what resolves it; adding more
      // emphasis to the TOOL ACCESS block below does not, because the model is not
      // ignoring an instruction, it is obeying a different one.
      ...base.map((line) =>
        line.startsWith('Only use the provided tools')
          ? `${line} EXCEPTION: for the capabilities listed under TOOL ACCESS below, do not say you have no tool — use the exact sentence given there.`
          : line,
      ),
      '',
      'TOOL ACCESS',
      `This user does not have access to the following capabilities: ${phrases.join(', ')}.`,
      '',
      'If the user asks for something that would require one of these, reply with exactly this',
      'sentence and nothing more:',
      `"${PERMISSION_DENIED_TEMPLATE}"`,
      'Replace [action] with a short description of what they asked for.',
      '',
      'Never state which role or permission level is required. Never explain why access is denied.',
      'Never attempt a different tool to work around it.',
      '',
      // Load-bearing: without it the bot answers "what's the weather?" with a
      // permission refusal, which is both wrong and confusing.
      'This applies only to the capabilities listed above. If the user asks about something the',
      'portal does not cover at all, say you can’t help with that instead — do not use the',
      'permission sentence.',
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
      // Sanitise BEFORE trimming: a dangling tool_use must never reach Redis, and
      // trimming can only remove whole leading turns, never repair one.
      messages: trimToTurns(stripDanglingToolUse(messages), MAX_TURNS),
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

  /**
   * Archive the bot's reply (ADR-021 §2).
   *
   * `sender_id` is NULL — the canonical schema comment, which the previous write
   * violated by stamping the caller's staffId onto a row the bot authored. Ownership
   * is not lost: `parent_id` points at the user's turn, and `getBotConversation`
   * resolves it by join.
   */
  private async archiveBotMessage(
    staffId: string,
    content: string,
    db: Kysely<DB>,
    parentId: string,
  ): Promise<void> {
    await db
      .insertInto('messages')
      .values({
        channel: 'bot',
        sender_id: null,
        sender_type: 'bot',
        content,
        content_type: 'text',
        parent_id: parentId,
      })
      .execute();
  }

  /**
   * The session envelope's activity bump (ADR-021 §4). One UPDATE per turn against
   * a row keyed by the sessionId the Redis blob already carries — bot_sessions owns
   * the session lifecycle, never ownership, so it is never read to answer "whose
   * message is this".
   */
  private async touchBotSession(sessionId: string, db: Kysely<DB>): Promise<void> {
    await db
      .updateTable('bot_sessions')
      .set({ last_activity_at: new Date() })
      .where('id', '=', sessionId)
      .execute()
      .catch((err: unknown) => logger.error({ err, sessionId }, 'bot session touch failed'));
  }

  /**
   * The bot conversation for one staff member, newest first — the DB fallback behind
   * GET /v1/bot/session/current once the 12h Redis TTL has lapsed (ADR-021 §5).
   *
   * COALESCE is what makes this work across both write shapes: rows written after
   * ADR-021 carry NULL sender_id and resolve through the parent, and the ~344 legacy
   * rows that carry their own sender_id resolve directly. That is why the ADR needs
   * no backfill.
   */
  async getBotConversation(
    staffId: string,
    limit: number,
    offset: number,
    db: Kysely<DB>,
  ): Promise<{ sender_type: string; content: string; created_at: Date }[]> {
    const rows = await db
      .selectFrom('messages as m')
      .leftJoin('messages as p', 'p.id', 'm.parent_id')
      .select(['m.sender_type', 'm.content', 'm.created_at'])
      .where('m.channel', '=', 'bot')
      .where('m.deleted_at', 'is', null)
      .where(sql<boolean>`COALESCE(m.sender_id, p.sender_id) = ${staffId}`)
      .orderBy('m.created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();
    return rows as { sender_type: string; content: string; created_at: Date }[];
  }
}
