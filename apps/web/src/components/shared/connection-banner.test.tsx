import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest';

import { ConnectionBanner } from './connection-banner';

/**
 * The reconnection banner (09-ERROR-HANDLING §5.4, Sprint 10 STEP 11).
 *
 * Three claims worth asserting:
 *   - it appears on disconnect and clears on reconnect;
 *   - reconnect refetches ONCE, unconditionally, because the socket has no replay and
 *     the cache is stale by an unknown amount;
 *   - it never blocks — read-only use must continue while disconnected, so a modal
 *     here would be strictly worse than the staleness it warns about.
 */
const socket = vi.hoisted(() => {
  const handlers = new Map<string, () => void>();
  return {
    handlers,
    connected: true,
    subscribed: true,
    on: (e: string, fn: () => void) => handlers.set(e, fn),
    off: (e: string) => handlers.delete(e),
    fire: (e: string) => handlers.get(e)?.(),
  };
});

/**
 * `useSocketRooms` is mocked alongside the socket because the banner now reports
 * CONNECTED only once rooms are ACKED (ADR-025) — not merely when the transport is
 * up. `socket.subscribed` is the ack state these tests drive.
 */
vi.mock('@/lib/socket', () => ({
  WS_NOTIFY: '/ws/notify',
  getSocket: () => socket,
  useSocketRooms: () => ({ subscribed: socket.subscribed }),
}));

let client: QueryClient;

function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConnectionBanner />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  socket.handlers.clear();
  socket.connected = true;
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

afterEach(cleanup);

describe('visibility', () => {
  test('hidden while connected', async () => {
    mount();
    await waitFor(() => expect(socket.handlers.size).toBeGreaterThan(0));
    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });

  test('appears on disconnect', async () => {
    mount();
    await waitFor(() => expect(socket.handlers.size).toBeGreaterThan(0));

    await act(async () => socket.fire('disconnect'));

    const banner = await screen.findByTestId('connection-banner');
    expect(banner.getAttribute('data-state')).toBe('reconnecting');
    expect(banner.textContent).toContain('Reconnecting');
  });

  test('clears on reconnect', async () => {
    mount();
    await waitFor(() => expect(socket.handlers.size).toBeGreaterThan(0));

    await act(async () => socket.fire('disconnect'));
    await screen.findByTestId('connection-banner');

    await act(async () => socket.fire('connect'));
    await waitFor(() => expect(screen.queryByTestId('connection-banner')).toBeNull());
  });

  test('says OFFLINE rather than reconnecting when the OS is certain', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    mount();

    await act(async () => window.dispatchEvent(new Event('offline')));

    const banner = await screen.findByTestId('connection-banner');
    expect(banner.getAttribute('data-state')).toBe('offline');
  });
});

describe('⚠️ the banner must NOT refetch on connect (ADR-025 regression guard)', () => {
  test('a reconnect does not blanket-invalidate — that is the fix that made it worse', async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and it was wrong in a way that read as
    // obviously right: "the socket has no replay, so refetch everything on connect".
    // 09-ERROR-HANDLING §5.4 said the same thing until Sprint 10.1 amended it.
    //
    // The flaw is timing, not intent. A refetch issued on 'connect' goes out BEFORE
    // room membership is re-established, so it can resolve from a server snapshot
    // taken before an event that arrived in the meantime — and overwrite it. Tried
    // in Sprint 10: it moved the race later and made it rarer, so it stopped failing
    // the suite and started reaching users as "it sometimes doesn't update".
    //
    // Resync now belongs to useRealtimeQuery, which runs it AFTER the ack and buffers
    // anything landing during the fetch. This guard exists because the next person to
    // look at a missed event will reach for invalidateQueries-on-connect within about
    // ninety seconds; they should get a red test rather than a plausible diff.
    mount();
    await waitFor(() => expect(socket.handlers.size).toBeGreaterThan(0));
    const spy = vi.spyOn(client, 'invalidateQueries');

    await act(async () => socket.fire('disconnect'));
    await act(async () => socket.fire('connect'));

    expect(spy).not.toHaveBeenCalled();
  });

  test('a disconnect alone does not refetch', async () => {
    mount();
    await waitFor(() => expect(socket.handlers.size).toBeGreaterThan(0));
    const spy = vi.spyOn(client, 'invalidateQueries');

    await act(async () => socket.fire('disconnect'));

    // Refetching while the network is down would just queue failures.
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('⭐ non-blocking', () => {
  test('the banner never intercepts pointer events', async () => {
    mount();
    await waitFor(() => expect(socket.handlers.size).toBeGreaterThan(0));
    await act(async () => socket.fire('disconnect'));

    const banner = await screen.findByTestId('connection-banner');
    // Read-only use continues while disconnected — the grid underneath stays usable.
    expect(banner.className).toContain('pointer-events-none');
  });

  test('it is a status region, not a dialog', async () => {
    mount();
    await waitFor(() => expect(socket.handlers.size).toBeGreaterThan(0));
    await act(async () => socket.fire('disconnect'));

    const banner = await screen.findByTestId('connection-banner');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('aria-live')).toBe('polite');
  });
});
