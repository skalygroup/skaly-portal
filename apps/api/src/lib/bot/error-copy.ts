/**
 * The single error→copy mapping for the bot (Error-Handling §6, audit M-08).
 *
 * ONE table, not a switch at each call site: the turn-1 tool loop and the turn-2
 * executor both surface service errors, and two copies of this would drift into
 * "something went wrong" on one path and a helpful sentence on the other.
 *
 * RULES, and they are all one rule — the user is a person, not a debugger:
 *   - never an error code, never an HTTP status, never a stack
 *   - never a role or permission name (APPFLOW §9: the bot must not explain the
 *     permission model, only that it cannot help)
 *   - never the word "version", which is our concurrency model leaking
 *   - every message that CAN offer a way forward does
 */
import type { AppError } from '../errors.js';

/** Fields a message may interpolate. All optional — a missing one degrades the
 *  sentence gracefully rather than printing "undefined". */
export interface ErrorCopyContext {
  /** Human month label for a locked period, e.g. "July 2026". */
  month?: string;
  /** What the user asked for, for the permission refusal. */
  action?: string;
  /** The blocking dependency's description. */
  dependency?: string;
  /** Who moved the record out from under us. */
  updatedBy?: string;
}

const GENERIC = 'Something went wrong. Please try again or make the change directly in the portal.';

type CopyFn = (ctx: ErrorCopyContext) => string;

const COPY: Record<string, CopyFn> = {
  PERIOD_LOCKED: ({ month }) =>
    `I can't update that record — ${month ?? 'that month'} is locked. Ask an admin to unlock it if a correction is needed.`,

  PERMISSION_DENIED: ({ action }) =>
    `I don't have permission to ${action ?? 'do that'} on your behalf. Ask an admin to update your bot access settings.`,
  BOT_TOOL_DENIED: ({ action }) =>
    `I don't have permission to ${action ?? 'do that'} on your behalf. Ask an admin to update your bot access settings.`,

  DEPENDENCY_UNRESOLVED: ({ dependency }) =>
    dependency
      ? `I can't mark that task as Done — it depends on "${dependency}" which isn't finished yet.`
      : "I can't mark that task as Done — it depends on another task that isn't finished yet.",

  STAGE_SEQUENCE_VIOLATION: () =>
    "I can't mark that stage as complete — the previous stage hasn't been done yet.",

  /**
   * NEWLY REACHABLE in Sprint 9, and by design: ADR-014 captures the version when
   * the summary is built, so a human editing the same row while the user reads the
   * confirmation produces an honest 409 instead of a silent overwrite. The copy has
   * to offer recovery — this is the one error the user did nothing to cause.
   */
  STALE_DATA: ({ updatedBy }) =>
    `That record changed while I was waiting for your confirmation${updatedBy ? ` — ${updatedBy} updated it` : ''}. Want me to take another look and try again?`,

  VALIDATION_ERROR: () => "I couldn't do that — some of the details weren't valid. Could you rephrase?",

  RESOURCE_NOT_FOUND: () => "I couldn't find that record. Could you tell me which one you mean?",

  PERIOD_NOT_FOUND: () => "That month isn't set up in the portal yet, so I can't make changes in it.",

  CLIENT_SHOOT_SLOTS_REQUIRED: () =>
    "I need to know how many shoots a month that client gets before I can add them. How many?",

  ANTHROPIC_ERROR: () => "I'm having trouble connecting right now. Please try again in a moment.",
};

/**
 * A dependency cycle is a `VALIDATION_ERROR` like any other at the service, but it
 * needs its own sentence — "some details weren't valid" tells the user nothing
 * about a loop they can actually go and break (ADR-009).
 */
const CYCLE_COPY = "I can't set that dependency — it would create a loop between those tasks.";

function looksLikeCycle(message: string): boolean {
  return /cycle|circular|loop/i.test(message);
}

/**
 * Friendly copy for an error. Anything unmapped falls to the generic line — which
 * is a real outcome, not a gap: a code we have never seen must not have its raw
 * text shown to a user.
 */
export function botErrorCopy(err: unknown, ctx: ErrorCopyContext = {}): string {
  const code = (err as Partial<AppError> | null)?.code;
  if (typeof code !== 'string') return GENERIC;

  if (code === 'VALIDATION_ERROR' && looksLikeCycle(String((err as Error).message ?? ''))) {
    return CYCLE_COPY;
  }

  return COPY[code]?.(ctx) ?? GENERIC;
}

/** Exported for the test that asserts every row is reachable and clean. */
export const BOT_ERROR_CODES = Object.keys(COPY);
export const BOT_GENERIC_ERROR_COPY = GENERIC;
export const BOT_CYCLE_ERROR_COPY = CYCLE_COPY;
