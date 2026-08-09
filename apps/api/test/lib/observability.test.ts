import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import type { ErrorEvent } from '@sentry/node';

/**
 * `vi.mock`, not `vi.spyOn`: an ESM module namespace is not configurable, so
 * spying on `@sentry/node`'s exports throws outright. Mocking also means this
 * suite can never open a real transport by accident, which is the property that
 * matters most in a file whose entire subject is "does it stay silent".
 */
const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(() => 'event-id'),
  /** null until a test says otherwise — `sentryEnabled()` gates on this. */
  client: null as object | null,
}));

vi.mock('@sentry/node', () => ({
  init: sentry.init,
  captureException: sentry.captureException,
  getClient: () => sentry.client ?? undefined,
}));

const { beforeSend, captureError, initSentry, scrubPII, sentryEnabled } = await import(
  '../../src/lib/observability.js'
);

/**
 * H-07 — Sentry behind an optional DSN.
 *
 * ⚠️ THE LOAD-BEARING TEST IS THE NO-OP ONE. The infra spec does not provision
 * Sentry (§8 is Railway alerts + in-app notifications), so the overwhelmingly
 * likely production state on launch day is DSN-unset — and in that state this
 * wiring must be invisible: no init, no client, no network, and above all no
 * change to the error envelope a user sees. Code that only behaves when
 * configured is code that gets its first real exercise during an incident.
 */
const PREVIOUS_DSN = process.env.SENTRY_DSN;

beforeEach(() => {
  delete process.env.SENTRY_DSN;
  sentry.init.mockClear();
  sentry.captureException.mockClear();
  sentry.client = null;
});

afterEach(() => {
  if (PREVIOUS_DSN === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = PREVIOUS_DSN;
});

describe('⭐ with no DSN, Sentry is completely inert', () => {
  test('initSentry does not initialise a client', () => {
    initSentry();

    expect(sentry.init, 'Sentry.init must not be called without a DSN').not.toHaveBeenCalled();
    expect(sentryEnabled()).toBe(false);
  });

  test('captureError is a silent no-op — not a throw, not a queued event', () => {
    // Deliberately called the way production calls it: unconditionally, with no
    // `if` at the call site. That is only safe if this is genuinely inert.
    expect(() => captureError(new Error('boom'), { traceId: 'abc' })).not.toThrow();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('the PII scrub (NFR §4)', () => {
  test('redacts credentials and identities at any depth', () => {
    const scrubbed = scrubPII({
      ok: 'kept',
      password: 'hunter2',
      nested: { token: 'sk-live-abc', email: 'someone@skaly.in', safe: 42 },
      list: [{ apiKey: 'k' }, { fine: true }],
    });

    expect(scrubbed).toEqual({
      ok: 'kept',
      password: '[redacted]',
      nested: { token: '[redacted]', email: '[redacted]', safe: 42 },
      list: [{ apiKey: '[redacted]' }, { fine: true }],
    });
  });

  test('does not recurse without bound on a deeply nested object', () => {
    // An error-reporting path that can hang on a pathological payload turns a
    // handled 500 into an outage.
    let deep: Record<string, unknown> = { password: 'x' };
    for (let i = 0; i < 200; i += 1) deep = { next: deep };

    expect(() => scrubPII(deep)).not.toThrow();
  });

  test('⭐ beforeSend strips the Authorization header and cookies outright', () => {
    const event = {
      request: {
        url: 'https://api.skaly.in/v1/staff',
        cookies: { session: 'abc' },
        headers: { authorization: 'Bearer secret-token', 'user-agent': 'test' },
      },
      extra: { email: 'admin@skaly.in', period: '2094-07' },
    } as unknown as ErrorEvent;

    const sent = beforeSend(event);

    expect(sent?.request?.cookies).toBeUndefined();
    expect(sent?.request?.headers?.authorization).toBeUndefined();
    // Everything harmless survives — a scrub that drops the diagnostics too is a
    // scrub nobody keeps enabled.
    expect(sent?.request?.headers?.['user-agent']).toBe('test');
    expect(sent?.extra?.period).toBe('2094-07');
    expect(sent?.extra?.email).toBe('[redacted]');
  });
});

describe('with a DSN set, errors are captured WITH the traceId tag', () => {
  test('the tag is present — it is the only join back to the user’s screen', () => {
    process.env.SENTRY_DSN = 'https://public@o0.ingest.sentry.io/0';
    // getClient is what `sentryEnabled` gates on.
    sentry.client = {};

    const err = new Error('unhandled');
    captureError(err, { traceId: 'trace-123' }, { path: '/v1/tasks', method: 'GET' });

    expect(sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tags: { traceId: 'trace-123' } }),
    );
  });

  test('a Tier 1 rollover failure carries its failedStep', () => {
    process.env.SENTRY_DSN = 'https://public@o0.ingest.sentry.io/0';
    // getClient is what `sentryEnabled` gates on.
    sentry.client = {};

    captureError(new Error('recompute exploded'), {
      rollover: 'tier1',
      period: '2094-07',
      failedStep: 'recompute',
    });

    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { rollover: 'tier1', period: '2094-07', failedStep: 'recompute' },
      }),
    );
  });

  test('undefined tags are dropped rather than sent as the string "undefined"', () => {
    process.env.SENTRY_DSN = 'https://public@o0.ingest.sentry.io/0';
    // getClient is what `sentryEnabled` gates on.
    sentry.client = {};

    captureError(new Error('x'), { traceId: 't', missing: undefined });

    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { traceId: 't' }, extra: undefined });
  });
});
