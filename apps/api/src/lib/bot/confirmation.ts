/**
 * The two-turn mutation confirmation state machine (ADR-014, TRD §9.2).
 *
 * Sprint 9 is the first time a probabilistic system triggers an irreversible
 * write, so every decision that matters is made here, deterministically:
 *
 *   turn 1  the tool is NOT executed. Its target is read, a summary is rendered
 *           from the validated input + that read, and a single pending record is
 *           stored carrying the version seen at summary time.
 *   turn 2  consent is resolved by `resolveTurn2` — never by the model — and the
 *           stored call is executed. No Anthropic request on that path at all.
 *
 * This file makes NO Anthropic calls and NO service calls. It is pure state logic
 * plus rendering, unit-testable with no I/O. The Redis read/write half lives in
 * BotService (setPending / consumePending / clearPending).
 */

/** The structured, server-rendered summary the user consents to (ADR-014 §4). */
export interface ConfirmationSummary {
  /** "Mark task as Done" */
  action: string;
  /** "Task" */
  entity: string;
  /** "Edit the Naaz Furniture reel" */
  target: string;
  period?: string;
  changes: Array<{ field: string; from: string; to: string }>;
}

/**
 * The pending record. Stored server-side; the client may reference it by
 * `confirmationId` and may never supply the tool, the input, or the version.
 */
export interface PendingConfirmation {
  confirmationId: string;
  toolName: string;
  /** Zod-validated at turn 1 — re-validated at turn 2 is unnecessary, but harmless. */
  input: Record<string, unknown>;
  /** Versioned targets only (content_pipelines, content_calendar). ADR-008: tasks
   *  and shoot_schedules are unversioned and carry nothing. */
  expectedVersion?: number;
  summary: ConfirmationSummary;
  /** ISO — turn 1 + 5 minutes. Checked on read, NOT by the Redis TTL: an expired
   *  record must stay readable long enough to say "that timed out" rather than be
   *  indistinguishable from no record at all. */
  expiresAt: string;
}

/** What the client may send on a turn-2 request. */
export interface Turn2Body {
  /** The display string archived to the transcript ("Yes, go ahead"). */
  content: string;
  confirmationId?: string;
  decision?: 'confirm' | 'cancel';
}

export type Turn2Resolution =
  | { kind: 'execute'; pending: PendingConfirmation }
  | { kind: 'cancelled' }
  | { kind: 'expired' }
  | { kind: 'stale_id' }
  | { kind: 'none' };

/**
 * The affirmative allowlist. EXACT match after normalisation — deliberately not a
 * `startsWith` or a regex.
 *
 * "yes, but make it Friday" must be false. It reads as consent to a human and is
 * not: the user is asking for something the summary does not say. Falling through
 * to `none` clears the pending state and re-plans it as a fresh turn, which is the
 * behaviour we want, not a shortcoming of the list.
 */
const AFFIRMATIVES: ReadonlySet<string> = new Set([
  'yes',
  'y',
  'yeah',
  'yep',
  'confirm',
  'confirmed',
  'go ahead',
  'do it',
  'proceed',
  'ok',
  'okay',
]);

export function isAffirmative(raw: string): boolean {
  // Trailing '.' / '!' only — nothing that could merge two words or strip a
  // qualifier ("yes, but…" keeps its comma and stays off the list).
  const normalised = raw.trim().toLowerCase().replace(/[.!]+$/, '').trim();
  return AFFIRMATIVES.has(normalised);
}

export function isExpired(pending: PendingConfirmation, now: Date = new Date()): boolean {
  return Date.parse(pending.expiresAt) <= now.getTime();
}

/**
 * Resolve turn 2 as a flat precedence chain — read top to bottom, first match wins.
 *
 * `pending` is the consumed-or-peeked server record (null when there is none).
 * The client never supplies it.
 */
export function resolveTurn2(
  pending: PendingConfirmation | null,
  body: Turn2Body,
  now: Date = new Date(),
): Turn2Resolution {
  // ── Structured consent from the buttons wins outright ─────────────────────
  if (body.decision) {
    // No record, or a different one: the client is referencing something already
    // handled or replaced. Never fall through to the typed-text path — a stale
    // [Confirm] must not execute whatever happens to be pending now.
    if (!pending || pending.confirmationId !== body.confirmationId) return { kind: 'stale_id' };
    // Cancel before expiry: "no changes made" is true either way, and it is the
    // more useful thing to say.
    if (body.decision === 'cancel') return { kind: 'cancelled' };
    if (isExpired(pending, now)) return { kind: 'expired' };
    return { kind: 'execute', pending };
  }

  // ── Typed text: only an exact affirmative counts, and only with a record ───
  if (!pending) return { kind: 'none' };
  if (!isAffirmative(body.content)) return { kind: 'none' };
  if (isExpired(pending, now)) return { kind: 'expired' };
  return { kind: 'execute', pending };
}

/**
 * How ONE mutation tool contributes its summary — supplied by the tool descriptor
 * (STEP 4), not by a table in this file. A parallel table here would be a second
 * list of the eleven tools to keep in sync with the registry, which is the drift
 * Sprint 8.1 spent a sprint deleting.
 *
 * Each tool spends ~5 lines; this file owns all the rendering.
 */
export interface SummarySpec {
  entity: string;
  action: (input: Record<string, unknown>) => string;
  target: (state: Record<string, unknown>) => string;
  period?: (input: Record<string, unknown>, state: Record<string, unknown>) => string | undefined;
  changes: ReadonlyArray<{
    field: string;
    from: (state: Record<string, unknown>) => unknown;
    to: (input: Record<string, unknown>) => unknown;
  }>;
}

const EM_DASH = '—';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 'YYYY-MM-DD' → '15 Jul 2026'. Formatted from the string parts, NOT via a Date:
 * a calendar date has no time and no zone, and running one through
 * Date/Intl-with-a-timezone is exactly what produced the off-by-one the pg DATE
 * parser sweep fixed. date-fns is not an API dependency (it is web-only) and is
 * not worth adding for one format.
 */
export function formatCalendarDate(value: string): string {
  const m = CALENDAR_DATE.exec(value);
  if (!m) return value;
  const [, year, month, day] = m;
  const name = MONTHS[Number(month) - 1];
  if (!name) return value;
  return `${Number(day)} ${name} ${year}`;
}

/** One field value as the user reads it. Nothing renders as a bare null. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return EM_DASH;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value instanceof Date) return formatCalendarDate(value.toISOString().slice(0, 10));
  if (typeof value === 'string') return formatCalendarDate(value);
  return String(value);
}

/**
 * Render the summary the user consents to. `from` comes from the current-state
 * read, `to` from the validated input — the model contributes neither, and may not
 * paraphrase the result (ADR-014 §4).
 */
export function buildSummary(
  spec: SummarySpec,
  input: Record<string, unknown>,
  state: Record<string, unknown>,
): ConfirmationSummary {
  return {
    action: spec.action(input),
    entity: spec.entity,
    target: spec.target(state),
    period: spec.period?.(input, state),
    changes: spec.changes.map((c) => ({
      field: c.field,
      from: renderValue(c.from(state)),
      to: renderValue(c.to(input)),
    })),
  };
}

/** Turn-1 record factory — one place that decides the 5-minute window. */
export const PENDING_TTL_MS = 5 * 60 * 1000;

export function makePending(args: {
  confirmationId: string;
  toolName: string;
  input: Record<string, unknown>;
  expectedVersion?: number;
  summary: ConfirmationSummary;
  now?: Date;
}): PendingConfirmation {
  const now = args.now ?? new Date();
  return {
    confirmationId: args.confirmationId,
    toolName: args.toolName,
    input: args.input,
    expectedVersion: args.expectedVersion,
    summary: args.summary,
    expiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
  };
}
