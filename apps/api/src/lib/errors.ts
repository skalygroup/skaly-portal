/**
 * Canonical application errors — 09-ERROR-HANDLING.md §2 (code table) + §4
 * (global handler).
 *
 * `AppError` is the single base class for known, expected failures. Throw it
 * from services and routes; the global error handler registered in app.ts
 * renders every AppError as the canonical envelope
 *   { error: { code, message, details? } }
 * and never leaks internals.
 *
 * The HTTP status is derived from ERROR_CODES — not passed per throw — so a
 * given code can never drift to the wrong status across call sites.
 *
 * NOTE: Sprint 1's AuthService still throws a separate `AuthError`
 * (services/AuthService.ts) that emits the identical envelope via per-route
 * try/catch. Both coexist deliberately: new Sprint 2 services throw AppError
 * and rely on the global handler. AuthError may be folded into AppError later.
 */

/**
 * Every application error code and its HTTP status, per 09-ERROR-HANDLING.md §2.
 * This is the single source of truth for code → status; add new codes here.
 */
export const ERROR_CODES = {
  // ── Auth & Access ──────────────────────────────────────────────────
  UNAUTHORIZED: 401,
  TOKEN_EXPIRED: 401,
  ACCOUNT_DEACTIVATED: 401,
  MFA_REQUIRED: 403,
  MFA_FAILED: 403,
  MFA_LOCKED: 403,
  PERMISSION_DENIED: 403,
  INVITE_EXPIRED: 400,
  INVITE_ALREADY_USED: 400,

  // ── Period / Month Lock ────────────────────────────────────────────
  PERIOD_LOCKED: 423,
  PERIOD_NOT_FOUND: 404,
  UNLOCK_REASON_REQUIRED: 400,
  ALREADY_PROCESSED: 409,

  // ── Data Integrity ─────────────────────────────────────────────────
  VALIDATION_ERROR: 400,
  STALE_DATA: 409,
  DEPENDENCY_UNRESOLVED: 400,
  STAGE_SEQUENCE_VIOLATION: 400,
  SHOOT_RESET_CONFIRMATION_REQUIRED: 400,
  CLIENT_SHOOT_SLOTS_REQUIRED: 400,
  RESOURCE_NOT_FOUND: 404,
  // 410, not 404: the row is still there and still readable — only R2's 30-day
  // lifecycle rule took the object. A 404 tells the panel the id is bogus, so it
  // cannot offer [Regenerate], which is the one action that resolves this.
  RESOURCE_EXPIRED: 410,

  // ── File Upload ────────────────────────────────────────────────────
  FILE_TOO_LARGE: 400,
  TASK_ATTACHMENT_LIMIT_EXCEEDED: 400,
  INVALID_FILE_TYPE: 400,
  INVALID_ROLE: 400,

  // ── Bot ────────────────────────────────────────────────────────────
  BOT_TOOL_DENIED: 403,
  ANTHROPIC_ERROR: 503,

  // ── Rate Limiting & Server ─────────────────────────────────────────
  RATE_LIMIT_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
  DATABASE_UNAVAILABLE: 503,
  CACHE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * Known application error. `statusCode` is looked up from ERROR_CODES so the
 * caller only supplies the code; `details` carries the structured payload the
 * envelope surfaces (e.g. STALE_DATA → { currentVersion, updatedBy }).
 */
export class AppError extends Error {
  readonly statusCode: number;

  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = ERROR_CODES[code];
    // Preserve `instanceof AppError` across the TS -> ES transpile target.
    Object.setPrototypeOf(this, AppError.prototype);
  }
}