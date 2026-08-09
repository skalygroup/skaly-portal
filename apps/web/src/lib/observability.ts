'use client';

import * as Sentry from '@sentry/react';

import type { ErrorEvent } from '@sentry/react';

/**
 * Sentry on the web, behind an OPTIONAL DSN (audit H-07).
 *
 * ⚠️ `@sentry/react`, NOT `@sentry/nextjs`, and that is the whole point of this
 * file existing instead of a `sentry.client.config.ts`. The Next SDK's value is
 * its build-time plugin — a webpack wrapper plus source-map upload — and that
 * plugin changes the Vercel build. This build cannot be verified from here, and
 * the launch deploy is the single worst moment to discover a broken build
 * config. So: a plain browser SDK, initialised manually, with no build step.
 *
 * Unset `NEXT_PUBLIC_SENTRY_DSN` and nothing here runs: no init, no network, no
 * behavioural change. Every module error boundary still renders and still
 * isolates exactly as it does today — Sentry is purely additive to them.
 */
const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

/** Keys that must never leave the browser (NFR §4). */
const SENSITIVE_KEYS = /^(password|token|secret|code|email|authorization|cookie|api[-_]?key)$/i;

export function scrubPII<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrubPII(v, depth + 1)) as unknown as T;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.test(key) ? '[redacted]' : scrubPII(v, depth + 1);
  }
  return out as unknown as T;
}

export function beforeSend(event: ErrorEvent): ErrorEvent | null {
  if (event.request) {
    delete event.request.cookies;
    delete event.request.headers?.authorization;
  }
  // Breadcrumbs are the browser-side leak nobody expects: a fetch breadcrumb
  // records the URL, and a token in a query string would ride along.
  return scrubPII(event);
}

export function initSentry(): void {
  if (!DSN) return;
  Sentry.init({
    dsn: DSN,
    environment: process.env.NODE_ENV ?? 'development',
    // Error reporting, not APM. Railway owns p95 (Infra §8).
    tracesSampleRate: 0,
    beforeSend,
  });
}

export const sentryEnabled = (): boolean => Boolean(DSN && Sentry.getClient());

/** A no-op when Sentry is disabled, so call sites need no `if`. */
export function captureError(error: unknown, tags?: Record<string, string>): void {
  if (!sentryEnabled()) return;
  Sentry.captureException(error, tags ? { tags } : undefined);
}
