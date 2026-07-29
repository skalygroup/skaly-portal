import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import type * as AuthVerify from '../../src/lib/auth-verify.js';
import type { FastifyInstance } from 'fastify';

type AuthUser = AuthVerify.AuthUser;

/**
 * ADR-024 — the rate limiter keys per USER, not per IP (audit A1, deploy blocker).
 *
 * ⚠️ EVERY ASSERTION HERE IS BEHAVIOURAL, ON PURPOSE. A test that read the config
 * would pass against the broken build: `@fastify/rate-limit` defaults to the
 * `onRequest` hook, and `verifyJwt` is a ROUTE-level preHandler, so a
 * `keyGenerator` of `req.user?.id ?? ip` silently falls through to the IP on every
 * request. The config reads as fixed and nothing changes — which is the exact class
 * of failure (A3) that produced an untrustworthy suite result in Sprint 10.
 *
 * The only thing that catches it is two users' counters moving independently.
 *
 * The Supabase verifier is mocked rather than minting RS256 tokens: both `app.ts`
 * (the identify hook) and `auth.plugin.ts` import it from this one module, so a
 * single mock covers the whole path under test while leaving the ordering — the
 * thing being tested — completely real.
 */
/**
 * A LOW limit, set before `app.js` is imported so `env.RATE_LIMIT_MAX` picks it
 * up at register time.
 *
 * Without it the only thing assertable is that two counters move
 * independently — true of a broken build the moment before it 429s everyone
 * together. The point of ADR-024 is what happens AT the ceiling, and reaching a
 * real 429 at 150 would mean 151 injects per test.
 */
const LIMIT = 8;
const PREVIOUS_LIMIT = process.env.RATE_LIMIT_MAX;
process.env.RATE_LIMIT_MAX = String(LIMIT);

const USER_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const USER_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

/** `token-x` → a stable uuid for x, so a test can take a bucket nobody else uses. */
function idFor(token: string): string {
  if (token === 'token-a') return USER_A;
  if (token === 'token-b') return USER_B;
  return `cccccccc-0000-4000-8000-0000000000${token.slice(-1).charCodeAt(0).toString(16)}`;
}

function userFor(token: string): AuthUser {
  const id = idFor(token);
  return {
    id,
    supabase_uid: `uid-${id}`,
    name: token,
    email: `${token}@rl.itest`,
    role: 'admin',
    active: true,
    mfa_enrolled: true,
    avatar_url: null,
  };
}

vi.mock('../../src/lib/auth-verify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthVerify>();
  return {
    ...actual,
    verifySupabaseToken: vi.fn(async (token: string) => {
      if (!/^token-[a-z]$/.test(token)) {
        throw new actual.TokenVerificationError('INVALID_TOKEN', 'nope');
      }
      return userFor(token);
    }),
  };
});

const { buildApp } = await import('../../src/app.js');
const { pool } = await import('../../src/lib/db.js');
const { redis } = await import('../../src/lib/redis.js');

/** `/v1/health` needs no auth, so the response reflects the LIMITER, not a gate. */
async function hit(
  app: FastifyInstance,
  opts: { token?: string; ip?: string } = {},
): Promise<number> {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/health',
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    remoteAddress: opts.ip ?? '10.0.0.1',
  });
  return Number(res.headers['x-ratelimit-remaining']);
}

describe('ADR-024 — rate limiting is keyed per user', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool.end();
    redis.disconnect();
    // `fileParallelism: false` means one process runs every file in turn, so a
    // limit of 8 left in the environment would silently 429 whichever suite ran
    // next — a failure with no connection to the file that caused it.
    if (PREVIOUS_LIMIT === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = PREVIOUS_LIMIT;
  });

  test('⭐ two authenticated users have INDEPENDENT buckets', async () => {
    // The assertion that fails on the pre-ADR-024 build: both users keyed to the
    // same IP, so B's counter carried on where A's left off.
    const a1 = await hit(app, { token: 'token-a' });
    const a2 = await hit(app, { token: 'token-a' });
    expect(a2).toBe(a1 - 1); // A's own bucket is counting down

    const b1 = await hit(app, { token: 'token-b' });
    expect(b1).toBeGreaterThan(a2); // B did NOT inherit A's consumption
  });

  test('the same user from two different IPs shares ONE bucket', async () => {
    // The point of keying by identity: moving between office wifi and a phone
    // hotspot must not hand you a fresh allowance.
    const first = await hit(app, { token: 'token-a', ip: '10.0.0.7' });
    const second = await hit(app, { token: 'token-a', ip: '198.51.100.9' });
    expect(second).toBe(first - 1);
  });

  test('an unauthenticated request keys by IP, in a namespace of its own', async () => {
    // Two different anonymous addresses do not share, and neither inherits a
    // user's bucket — the `ip:` prefix is what stops an address colliding with a
    // staff id.
    const anonOne = await hit(app, { ip: '203.0.113.1' });
    const anonTwo = await hit(app, { ip: '203.0.113.2' });
    expect(anonTwo).toBeGreaterThan(anonOne - 1);

    const anonOneAgain = await hit(app, { ip: '203.0.113.1' });
    expect(anonOneAgain).toBe(anonOne - 1);
  });

  /**
   * ⭐ Audit A1, at the ceiling — the deploy blocker itself.
   *
   * Every other test here reads `x-ratelimit-remaining`, which is a report about
   * the limiter rather than the limiter's decision. This one takes a real bucket
   * all the way to a real 429 and then asks a DIFFERENT user, from the SAME
   * address, whether they can still work.
   *
   * That is the exact shape of the incident: with one shared bucket, one busy
   * person throttles the whole organisation, and the 429 reaches the UI as
   * "Could not load your profile" — never as a rate-limit error. Nothing in the
   * product says what happened, which is why this needs an assertion rather
   * than a header.
   */
  test('⭐ A1: one user hammered to a real 429 does NOT 429 anybody else', async () => {
    const status = async (token: string): Promise<number> => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/health',
        headers: { authorization: `Bearer ${token}` },
        remoteAddress: '10.0.0.1', // ONE address for both — the whole point
      });
      return res.statusCode;
    };

    for (let i = 0; i < LIMIT; i += 1) {
      expect(await status('token-c'), `request ${i + 1} of C's own budget`).toBe(200);
    }
    expect(await status('token-c'), "C's budget is spent").toBe(429);

    // Same IP, same instant, different identity.
    expect(await status('token-d'), 'D must not inherit C‘s exhaustion').toBe(200);
  });

  test('⚠️ hook-ordering guard: an authenticated call does NOT touch the IP bucket', async () => {
    // This is the regression guard for the trap. If the limiter runs at the
    // default `onRequest` hook, `request.user` is unset, the key degrades to the
    // IP, and an authenticated request decrements the SAME bucket as an anonymous
    // one from that address. Here they must be independent.
    const ip = '192.0.2.55';
    const anonBefore = await hit(app, { ip });
    await hit(app, { token: 'token-b', ip });
    await hit(app, { token: 'token-b', ip });
    const anonAfter = await hit(app, { ip });

    expect(anonAfter).toBe(anonBefore - 1); // only the two anonymous calls counted
  });
});
