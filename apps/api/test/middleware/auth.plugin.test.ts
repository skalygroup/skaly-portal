import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT, generateKeyPair, type KeyLike } from 'jose';
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';

// ── Shared mock state (hoisted so vi.mock factories can close over it) ──────
const h = vi.hoisted(() => {
  const redisStore = new Map<string, string>();
  return {
    // Public key the mocked createRemoteJWKSet resolves to; set in beforeAll.
    keyHolder: { publicKey: undefined as unknown as KeyLike },
    // DB lookup spy — lets us assert how many times the staff row was queried.
    executeTakeFirst: vi.fn(),
    redisStore,
    redisGet: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    redisSet: vi.fn(async (key: string, val: string) => {
      redisStore.set(key, val);
      return 'OK';
    }),
    redisDel: vi.fn(async (key: string) => (redisStore.delete(key) ? 1 : 0)),
  };
});

vi.mock('../../src/lib/env.js', () => ({
  env: {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_JWKS_URL: 'https://test.supabase.co/auth/v1/.well-known/jwks.json',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

// Chainable Kysely stub: every builder method returns the same object until
// executeTakeFirst (the spy) resolves the row.
vi.mock('../../src/lib/db.js', () => {
  const qb: Record<string, unknown> = {};
  qb.selectFrom = () => qb;
  qb.select = () => qb;
  qb.where = () => qb;
  qb.executeTakeFirst = h.executeTakeFirst;
  return { db: qb, pool: {} };
});

vi.mock('../../src/lib/redis.js', () => ({
  redis: { get: h.redisGet, set: h.redisSet, del: h.redisDel },
}));

// Keep real jose (real jwtVerify / SignJWT) but resolve keys locally instead
// of fetching a remote JWKS.
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createRemoteJWKSet: () => async () => h.keyHolder.publicKey };
});

// Imported AFTER mocks are declared.
import authPlugin, { invalidateStaffCache } from '../../src/middleware/auth.plugin.js';

const ISSUER = 'https://test.supabase.co/auth/v1';
const UID = '5aaf8b90-0444-4649-9229-32204ef8a633';

let privateKey: KeyLike;

function signToken(opts?: { sub?: string; issuer?: string; audience?: string }) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(opts?.sub ?? UID)
    .setIssuer(opts?.issuer ?? ISSUER)
    .setAudience(opts?.audience ?? 'authenticated')
    .setExpirationTime('1h')
    .sign(privateKey);
}

function makeStaffRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'staff-uuid-1',
    supabase_uid: UID,
    name: 'Mohammed Arslaan',
    email: 'arslxxn.786@gmail.com',
    role: 'admin',
    active: true,
    mfa_enrolled: false,
    avatar_url: null,
    ...overrides,
  };
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(authPlugin);

  app.get('/protected', { preHandler: app.verifyJwt }, async (req) => req.user);
  app.get(
    '/admin-only',
    { preHandler: [app.verifyJwt, app.requireRole('admin')] },
    async () => ({ ok: true }),
  );
  app.get(
    '/admin-or-manager',
    { preHandler: [app.verifyJwt, app.requireRole('admin', 'manager')] },
    async () => ({ ok: true }),
  );

  await app.ready();
  return app;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('auth.plugin', () => {
  beforeAll(async () => {
    const { publicKey, privateKey: priv } = await generateKeyPair('RS256');
    h.keyHolder.publicKey = publicKey;
    privateKey = priv;
  });

  beforeEach(() => {
    vi.clearAllMocks(); // clears call counts; mock implementations survive
    h.redisStore.clear();
  });

  test('401 NO_TOKEN when Authorization header is missing', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('NO_TOKEN');
  });

  test('401 INVALID_TOKEN on a malformed token', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: auth('this.is.not-a-real-jwt'),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_TOKEN');
  });

  test('401 INVALID_TOKEN when issuer/audience do not match', async () => {
    const app = await buildTestApp();
    const token = await signToken({ issuer: 'https://evil.example.com/auth/v1' });
    const res = await app.inject({ method: 'GET', url: '/protected', headers: auth(token) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_TOKEN');
  });

  test('401 NO_STAFF_ROW when the token is valid but no staff row exists', async () => {
    h.executeTakeFirst.mockResolvedValue(undefined);
    const app = await buildTestApp();
    const token = await signToken({ sub: 'unknown-supabase-uid' });
    const res = await app.inject({ method: 'GET', url: '/protected', headers: auth(token) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('NO_STAFF_ROW');
  });

  test('403 ACCOUNT_DEACTIVATED when the staff row is inactive', async () => {
    h.executeTakeFirst.mockResolvedValue(makeStaffRow({ active: false }));
    const app = await buildTestApp();
    const token = await signToken();
    const res = await app.inject({ method: 'GET', url: '/protected', headers: auth(token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ACCOUNT_DEACTIVATED');
  });

  test('200 with request.user on a valid token + active staff', async () => {
    h.executeTakeFirst.mockResolvedValue(makeStaffRow());
    const app = await buildTestApp();
    const token = await signToken();
    const res = await app.inject({ method: 'GET', url: '/protected', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const user = res.json();
    expect(user).toMatchObject({ id: 'staff-uuid-1', role: 'admin', supabase_uid: UID });
  });

  test("requireRole('admin') returns 403 for a team_member, without leaking the required role", async () => {
    h.executeTakeFirst.mockResolvedValue(makeStaffRow({ role: 'team_member' }));
    const app = await buildTestApp();
    const token = await signToken();
    const res = await app.inject({ method: 'GET', url: '/admin-only', headers: auth(token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PERMISSION_DENIED');
    // M-08: message is the literal "Permission denied." — no role mentioned.
    expect(res.json().error.message).toBe('Permission denied.');
    expect(JSON.stringify(res.json())).not.toContain('admin');
  });

  test("requireRole('admin','manager') returns 200 for both roles", async () => {
    for (const role of ['admin', 'manager'] as const) {
      h.executeTakeFirst.mockResolvedValue(makeStaffRow({ role }));
      h.redisStore.clear();
      const app = await buildTestApp();
      const token = await signToken();
      const res = await app.inject({
        method: 'GET',
        url: '/admin-or-manager',
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
    }
  });

  test('second request to the same user is served from the Redis cache (DB queried once)', async () => {
    h.executeTakeFirst.mockResolvedValue(makeStaffRow());
    const app = await buildTestApp();
    const token = await signToken();

    const first = await app.inject({ method: 'GET', url: '/protected', headers: auth(token) });
    const second = await app.inject({ method: 'GET', url: '/protected', headers: auth(token) });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(h.executeTakeFirst).toHaveBeenCalledTimes(1);
    expect(h.redisSet).toHaveBeenCalledTimes(1);
  });

  test('invalidateStaffCache forces the next request to re-query the DB', async () => {
    h.executeTakeFirst.mockResolvedValue(makeStaffRow());
    const app = await buildTestApp();
    const token = await signToken();

    await app.inject({ method: 'GET', url: '/protected', headers: auth(token) }); // DB hit #1, caches
    await invalidateStaffCache(UID); // drops the cache entry
    await app.inject({ method: 'GET', url: '/protected', headers: auth(token) }); // DB hit #2

    expect(h.redisDel).toHaveBeenCalledWith(`staff_lookup:${UID}`);
    expect(h.executeTakeFirst).toHaveBeenCalledTimes(2);
  });

  test('a Redis get failure falls through to the DB and still succeeds', async () => {
    h.redisGet.mockRejectedValueOnce(new Error('redis down'));
    h.executeTakeFirst.mockResolvedValue(makeStaffRow());
    const app = await buildTestApp();
    const token = await signToken();
    const res = await app.inject({ method: 'GET', url: '/protected', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    expect(h.executeTakeFirst).toHaveBeenCalledTimes(1);
  });
});
