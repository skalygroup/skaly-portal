// @vitest-environment node
// Pure client logic (singleton + the C-05 handshake); socket.io-client and the
// Supabase client are mocked, so no jsdom and no real network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock socket.io-client: a fake socket that records handlers + emits ───────
const handlers = new Map<string, (payload: unknown) => void>();
const fakeSocket = {
  on: vi.fn((event: string, fn: (payload: unknown) => void) => {
    handlers.set(event, fn);
    return fakeSocket;
  }),
  off: vi.fn(),
  emit: vi.fn(),
};
const ioMock = vi.fn((_url: string, _opts?: unknown) => fakeSocket);
vi.mock('socket.io-client', () => ({ io: ioMock }));

// ── Mock the Supabase browser client ─────────────────────────────────────────
const getSession = vi.fn(async () => ({ data: { session: { access_token: 'tok-1', expires_at: 1_900_000_000 } } }));
const refreshSession = vi.fn(async () => ({ data: { session: { access_token: 'tok-2', expires_at: 1_900_003_600 } } }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession, refreshSession } }),
}));

const WS_URL = 'ws://localhost:3001';

beforeEach(() => {
  process.env.NEXT_PUBLIC_WS_URL = WS_URL;
  handlers.clear();
  vi.clearAllMocks();
  vi.resetModules(); // reset the module-level socket singleton between tests
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('getSocket', () => {
  it('connects once to /ws/notify with the TRD §8 reconnection policy and returns the singleton', async () => {
    const { getSocket } = await import('./socket');

    const a = getSocket();
    const b = getSocket();
    expect(a).toBe(b); // singleton — one connection per tab
    expect(ioMock).toHaveBeenCalledTimes(1);

    const [url, opts] = ioMock.mock.calls[0]!;
    expect(url).toBe(`${WS_URL}/ws/notify`);
    expect(opts).toMatchObject({
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      reconnectionAttempts: Infinity,
    });
  });

  it('the auth callback hands the server both token and exp from the Supabase session', async () => {
    const { getSocket } = await import('./socket');
    getSocket();

    const opts = ioMock.mock.calls[0]![1] as unknown as { auth: (cb: (d: unknown) => void) => void };
    const received = await new Promise((resolve) => opts.auth(resolve));
    expect(received).toEqual({ token: 'tok-1', exp: 1_900_000_000 });
  });

  it('C-05: on auth:refresh_required it refreshes via Supabase and re-hands the fresh token on the live socket', async () => {
    const { getSocket } = await import('./socket');
    getSocket();

    // The client registered a handler for the server's warning.
    const onRefresh = handlers.get('auth:refresh_required');
    expect(onRefresh).toBeTypeOf('function');

    onRefresh!(undefined);
    await vi.waitFor(() => expect(fakeSocket.emit).toHaveBeenCalled());

    expect(refreshSession).toHaveBeenCalledTimes(1);
    // Emitted on the SAME socket (no reconnect) with the refreshed token.
    expect(fakeSocket.emit).toHaveBeenCalledWith('auth:refresh', { token: 'tok-2' });
  });
});
