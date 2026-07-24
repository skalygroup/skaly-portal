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
  handler(input: unknown, currentUser: CurrentUser, db: Kysely<DB>): Promise<BotToolResult>;
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
