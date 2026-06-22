import { describe, test, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import internalAuthPlugin from '../../src/middleware/internalAuth.plugin.js';

// Mock env with a known CRON_SECRET (32+ chars)
vi.mock('../../src/lib/env.js', () => ({
  env: {
    CRON_SECRET: 'test-cron-secret-that-is-at-least-32-characters-long!!',
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
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

const VALID_SECRET = 'test-cron-secret-that-is-at-least-32-characters-long!!';

describe('internalAuth.plugin', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    await app.register(internalAuthPlugin);

    // Register a test route that uses the decorator
    app.get('/test-internal', {
      preHandler: app.verifyInternalSecret,
    }, async () => {
      return { data: 'ok' };
    });

    await app.ready();
  });

  test('valid secret passes through', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test-internal',
      headers: { 'x-internal-secret': VALID_SECRET },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: 'ok' });
  });

  test('wrong secret returns 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test-internal',
      headers: {
        'x-internal-secret': 'wrong-cron-secret-that-is-at-least-32-characters-long!!',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  test('missing header returns 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test-internal',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  test('length mismatch returns 401 after delay', async () => {
    const start = Date.now();
    const res = await app.inject({
      method: 'GET',
      url: '/test-internal',
      headers: { 'x-internal-secret': 'short' },
    });
    const elapsed = Date.now() - start;

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    // Should have waited ~50ms for timing-attack mitigation
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});
