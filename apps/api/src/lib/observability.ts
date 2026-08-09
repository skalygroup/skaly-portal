/**
 * Sentry, wired behind an OPTIONAL DSN (audit H-07).
 *
 * ⚠️ THE INFRA SPEC DOES NOT PROVISION SENTRY. `10-INFRA-DEPLOYMENT.md` §8 names
 * Railway alerts (error rate, p95, pool usage) and the in-app rollover
 * notifications as the monitoring story, and §6's env list carried no DSN until
 * this sprint added one, marked optional. So Sentry here is OPT-IN DIAGNOSTICS,
 * not the monitor: unset `SENTRY_DSN` and this file does nothing at all — no
 * init, no network, no behavioural change anywhere. Set it and every unhandled
 * 500 arrives tagged with the same `traceId` the user was shown.
 *
 * That tag is the entire point. Error-Handling §4 puts a `traceId` in the 500
 * envelope so a person can read it off their screen; without the matching tag on
 * the Sentry side there is no way to get from "the user says they saw
 * a1b2c3…" to the stack trace, and the integration is just a second inbox.
 *
 * `@sentry/node` only — deliberately NOT `@sentry/nextjs` on the web side. Its
 * build-time plugin rewrites the webpack config and uploads source maps, which
 * changes the Vercel build; that build cannot be verified from here, and the one
 * moment not to discover a broken build config is the launch deploy.
 */
import * as Sentry from '@sentry/node';

import type { ErrorEvent, EventHint } from '@sentry/node';

/** Header and body keys that must never leave the process (NFR §4). */
const SENSITIVE_KEYS = /^(password|token|secret|code|email|authorization|cookie|api[-_]?key)$/i;

/**
 * Strip anything that could carry a credential or a person's identity.
 *
 * Runs on the whole event, recursively, because Sentry attaches request data,
 * breadcrumbs and `extra` from several places and a key-by-key allowlist at the
 * top level would miss a token nested in a captured request body.
 */
export function scrubPII<T>(value: T, depth = 0): T {
  // Bounded: an event with a cyclic or pathologically deep object must not turn
  // error reporting into the outage.
  if (depth > 6 || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((v) => scrubPII(v, depth + 1)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.test(key) ? '[redacted]' : scrubPII(v, depth + 1);
  }
  return out as unknown as T;
}

/** The `beforeSend` hook, exported so a test can drive it without a live client. */
export function beforeSend(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
  // Cookies and the Authorization header are the two that arrive automatically,
  // so they are removed outright rather than redacted key-by-key.
  if (event.request) {
    delete event.request.cookies;
    delete event.request.headers?.authorization;
    delete event.request.headers?.Authorization;
  }
  return scrubPII(event);
}

/**
 * Initialise Sentry if — and only if — a DSN is configured. Safe to call twice.
 *
 * `tracesSampleRate: 0`: this is error reporting, not APM. Railway owns p95 and
 * error rate (§8), and performance tracing would duplicate that at a per-event
 * cost for a signal nobody is watching.
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0,
    beforeSend,
  });
}

/** True when a DSN was configured AND init succeeded. */
export const sentryEnabled = (): boolean => Boolean(process.env.SENTRY_DSN && Sentry.getClient());

/**
 * Report an unhandled error, tagged so it can be found from the user's screen.
 *
 * A no-op when Sentry is disabled — every call site can therefore be an
 * unconditional line rather than an `if` the next person has to remember.
 */
export function captureError(
  error: unknown,
  tags: Record<string, string | undefined>,
  extra?: Record<string, unknown>,
): void {
  if (!sentryEnabled()) return;
  Sentry.captureException(error, {
    tags: Object.fromEntries(Object.entries(tags).filter(([, v]) => v !== undefined)) as Record<
      string,
      string
    >,
    extra: extra ? scrubPII(extra) : undefined,
  });
}
