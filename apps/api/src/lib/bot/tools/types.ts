/**
 * The bot tool contract (Sprint 8 STEP 3). Every query tool is a thin wrapper
 * that calls its EXISTING isolating service method with the JWT-authenticated
 * `currentUser` — the 🔐 own-data scoping and the ADR-011 freelancer predicate
 * live in the service, never here — then shapes a typed card for the frontend.
 *
 * Two invariants (reconciliations #4, #9):
 *   - No tool input schema ever contains a staffId. The caller is always
 *     `currentUser` (the JWT), so a prompt cannot make the model impersonate.
 *   - `isMutation` is carried on every descriptor (all query tools `false`) so
 *     Sprint 9's two-turn confirmation interceptor (TRD §9.2) slots into the same
 *     loop without unpicking it.
 */
import type { CurrentUser } from '../../../services/AttendanceService.js';
import type { SummarySpec } from '../confirmation.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { DB } from '@skaly/shared';
import type { Kysely } from 'kysely';
import type { z } from 'zod';

/** A small typed payload the frontend card registry renders (STEP 7). */
export interface BotCard {
  type: string;
  [k: string]: unknown;
}

export interface BotToolResult {
  /** Fed back to Anthropic as the tool_result content — what the model reasons over. */
  text: string;
  /** Attached to the terminal bot:message for the frontend to render. */
  card?: BotCard;
  /**
   * MUTATION TOOLS ONLY. The deep link for the outcome message (APPFLOW §12).
   *
   * Returned by the handler rather than derived from a descriptor field, because
   * only the handler holds the service's DTO — and `create_task` / `add_client`
   * learn their id from it. A descriptor-level link would have to be fed the
   * handler's return value, which is this shape, not the row.
   */
  link?: string;
}

/** The current state of a mutation target, read at turn 1. */
export interface ToolCurrentState {
  /** Whatever the summary needs — the loaded row, projected. */
  state: Record<string, unknown>;
  /** Present only for versioned targets (content_pipelines, content_calendar).
   *  ADR-008: tasks and shoot_schedules are unversioned and return none. */
  version?: number;
}

/** Storage/registry shape — input erased to `unknown`; BotService validates it
 *  against `inputSchema` before calling the handler. */
export interface BotTool {
  name: string;
  description: string;
  /**
   * A short human-readable phrase for what this tool does ("viewing attendance
   * records"), used to name DENIED capabilities in the system prompt (Sprint 8.1).
   *
   * Separate from `description` on purpose: `description` is model-facing prose
   * that explains scoping rules, and some of them name a role outright ("a team
   * member sees only their own column") — injecting that into the denial list
   * would breach APPFLOW §9's "never state which role is required".
   */
  capability: string;
  inputSchema: z.ZodTypeAny;
  /** Anthropic tool `input_schema` (hand-written; the inputs are tiny). */
  jsonSchema: Anthropic.Tool['input_schema'];
  isMutation: boolean;
  /**
   * MUTATION TOOLS ONLY (Sprint 9). Load the target for the turn-1 summary and
   * capture its version. A missing target throws RESOURCE_NOT_FOUND *here* — so a
   * hallucinated id fails before any pending state exists.
   */
  readCurrent?(input: unknown, currentUser: CurrentUser, db: Kysely<DB>): Promise<ToolCurrentState>;
  /** MUTATION TOOLS ONLY. How this tool renders its confirmation summary. */
  summary?: SummarySpec;
  /** `expectedVersion` is passed only for versioned targets, from the pending record. */
  handler(
    input: unknown,
    currentUser: CurrentUser,
    db: Kysely<DB>,
    expectedVersion?: number,
  ): Promise<BotToolResult>;
}

/**
 * Authoring helper: the handler is written against the schema's inferred type,
 * then the descriptor is erased to `BotTool` for the registry. Keeps per-tool
 * type-safety at the definition site without an `any` in every tool file.
 */
export function defineTool<S extends z.ZodTypeAny>(t: {
  name: string;
  description: string;
  capability: string;
  inputSchema: S;
  jsonSchema: Anthropic.Tool['input_schema'];
  isMutation: boolean;
  handler(input: z.infer<S>, currentUser: CurrentUser, db: Kysely<DB>): Promise<BotToolResult>;
}): BotTool {
  return t as unknown as BotTool;
}

/**
 * The mutation counterpart. `isMutation: true` is set here rather than written out
 * eleven times — a mutation tool that forgot the flag would skip the confirmation
 * gate entirely and execute on turn 1, which is the single worst bug available in
 * this sprint. It is not a field worth trusting to copy-paste.
 *
 * `State` is the shape `readCurrent` returns, so `summary` is typed against it at
 * the definition site.
 */
export function defineMutationTool<S extends z.ZodTypeAny, State extends Record<string, unknown>>(t: {
  name: string;
  description: string;
  capability: string;
  inputSchema: S;
  jsonSchema: Anthropic.Tool['input_schema'];
  readCurrent(
    input: z.infer<S>,
    currentUser: CurrentUser,
    db: Kysely<DB>,
  ): Promise<{ state: State; version?: number }>;
  summary: {
    entity: string;
    action: (input: z.infer<S>) => string;
    target: (state: State) => string;
    period?: (input: z.infer<S>, state: State) => string | undefined;
    changes: ReadonlyArray<{
      field: string;
      from: (state: State) => unknown;
      to: (input: z.infer<S>) => unknown;
    }>;
  };
  handler(
    input: z.infer<S>,
    currentUser: CurrentUser,
    db: Kysely<DB>,
    expectedVersion?: number,
  ): Promise<BotToolResult>;
}): BotTool {
  return { ...t, isMutation: true } as unknown as BotTool;
}
