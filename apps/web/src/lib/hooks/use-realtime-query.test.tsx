import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, useEffect, useState, type ReactNode } from 'react';
import { describe, test, expect, beforeEach, vi } from 'vitest';

import { useRealtimeQuery, INVALIDATE } from './use-realtime-query';

import type * as SocketModule from '@/lib/socket';


/**
 * ADR-025 — the two gaps, proven separately.
 *
 * The in-flight test is the one that matters. Ordering alone (gate the fetch on the
 * room ack) closes only the pre-join gap, and fixing just that half moves the race
 * later and makes it RARER — which is worse, because it then survives the suite and
 * reaches users as "the badge sometimes doesn't update".
 */

// ── A controllable fake socket ───────────────────────────────────────────────
type Handler = (payload: unknown) => void;

const handlers = new Map<string, Set<Handler>>();

let ackJoin: (() => void) | null = null;

const fakeSocket = {
  connected: true,
  on: (event: string, fn: Handler) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(fn);
  },
  off: (event: string, fn: Handler) => {
    handlers.get(event)?.delete(fn);
  },
  emit: (event: string, ack?: unknown) => {
    if (event === 'room:join' && typeof ack === 'function') {
      // Held so a test can decide WHEN membership is confirmed.
      ackJoin = () => (ack as () => void)();
    }
  },
};

function fire(event: string, payload: unknown): void {
  for (const fn of handlers.get(event) ?? []) fn(payload);
}

/**
 * Lets a test force the subscribed flag (used by the reconnect case); `null` means
 * "behave normally and wait for the ack".
 */
let subscribedOverride: boolean | null = null;

/** Mirrors the real hook's contract; the ack is held so the test controls ordering. */
function useFakeSocketRooms(): { subscribed: boolean } {
  const [subscribed, setSubscribed] = useState(false);
  useEffect(() => {
    fakeSocket.emit('room:join', () => setSubscribed(true));
  }, []);
  return { subscribed: subscribedOverride ?? subscribed };
}

vi.mock('@/lib/socket', async (importOriginal) => {
  const actual = await importOriginal<typeof SocketModule>();
  return {
    ...actual,
    getSocket: () => fakeSocket,
    // The real hook is exercised end-to-end by the E2E specs; here we drive the
    // ack directly so the fetch/join ordering is under the test's control.
    useSocketRooms: useFakeSocketRooms,
  };
});

interface Row {
  id: string;
  n: number;
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

/** Sums an `add` event onto the row; `reset` is expressible only by refetching. */
const applyEvent = (data: Row[], e: { name: string; payload: unknown }) => {
  if (e.name === 'reset') return INVALIDATE;
  const p = e.payload as { id: string; n: number };
  return [...data.filter((r) => r.id !== p.id), { id: p.id, n: p.n }];
};

beforeEach(() => {
  handlers.clear();

  ackJoin = null;
  subscribedOverride = null;
});

describe('ADR-025 — subscribe before fetch', () => {
  test('the query does NOT fire before the room ack', async () => {
    const queryFn = vi.fn(async () => [{ id: 'a', n: 1 }]);

    renderHook(
      () =>
        useRealtimeQuery<Row[]>({
          queryKey: ['t1'],
          queryFn,
          events: ['add'],
          applyEvent,
        }),
      { wrapper },
    );

    // Membership is not confirmed yet.
    expect(queryFn).not.toHaveBeenCalled();

    await act(async () => {
      ackJoin?.();
    });
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
  });

  test('⭐ an event arriving DURING the initial fetch survives it', async () => {
    // The gap ordering alone does not close. Without buffering, the snapshot
    // resolves last and overwrites the patch — silently.
    let release!: (rows: Row[]) => void;
    const queryFn = vi.fn(
      () =>
        new Promise<Row[]>((resolve) => {
          release = resolve;
        }),
    );

    const { result } = renderHook(
      () =>
        useRealtimeQuery<Row[]>({
          queryKey: ['t2'],
          queryFn,
          events: ['add'],
          applyEvent,
        }),
      { wrapper },
    );

    await act(async () => {
      ackJoin?.();
    });
    await waitFor(() => expect(queryFn).toHaveBeenCalled());

    // Arrives while the fetch is in flight — the server's snapshot predates it.
    act(() => {
      fire('add', { id: 'b', n: 2 });
    });

    await act(async () => {
      release([{ id: 'a', n: 1 }]);
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(
        expect.arrayContaining([
          { id: 'a', n: 1 },
          { id: 'b', n: 2 }, // ← lost entirely without the replay
        ]),
      );
    });
  });

  test('an event after the fetch patches the cache directly', async () => {
    const queryFn = vi.fn(async () => [{ id: 'a', n: 1 }]);
    const { result } = renderHook(
      () =>
        useRealtimeQuery<Row[]>({
          queryKey: ['t3'],
          queryFn,
          events: ['add'],
          applyEvent,
        }),
      { wrapper },
    );

    await act(async () => {
      ackJoin?.();
    });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    act(() => {
      fire('add', { id: 'c', n: 3 });
    });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    // Patched, not refetched — ADR-022's whole point.
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  test('an invalidate-only event refetches instead of patching (ADR-022 preserved)', async () => {
    const queryFn = vi.fn(async () => [{ id: 'a', n: 1 }]);
    const { result } = renderHook(
      () =>
        useRealtimeQuery<Row[]>({
          queryKey: ['t4'],
          queryFn,
          events: ['add', 'reset'],
          applyEvent,
        }),
      { wrapper },
    );

    await act(async () => {
      ackJoin?.();
    });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    act(() => {
      fire('reset', {});
    });
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });

  test('⭐ on RE-subscribe the query resyncs; on first subscribe it does not double-fetch', async () => {
    // The reconnect path, and the one that is easy to get subtly wrong: tracking
    // "were we subscribed last render" instead of "have we ever been subscribed"
    // makes a reconnect look like a first subscribe, and the resync silently never
    // fires. That bug was written here first and caught by this test.
    const queryFn = vi.fn(async () => [{ id: 'a', n: 1 }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const localWrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);

    const { result, rerender } = renderHook(
      () =>
        useRealtimeQuery<Row[]>({
          queryKey: ['t5'],
          queryFn,
          events: ['add'],
          applyEvent,
        }),
      { wrapper: localWrapper },
    );

    await act(async () => {
      ackJoin?.();
    });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    // The FIRST subscribe must not invalidate — the gated fetch already ran, and
    // invalidating here would double-fetch on every page load.
    expect(invalidate).not.toHaveBeenCalled();

    // Drop and restore.
    await act(async () => {
      subscribedOverride = false;
      rerender();
    });
    await act(async () => {
      subscribedOverride = true;
      rerender();
    });

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['t5'] }));
  });

  test('applyEvent is pure — same input, same output, no cache access', () => {
    const before: Row[] = [{ id: 'a', n: 1 }];
    const e = { name: 'add', payload: { id: 'b', n: 2 } };
    const first = applyEvent(before, e);
    const second = applyEvent(before, e);
    expect(first).toEqual(second);
    // The input is not mutated — replay would be order-dependent otherwise.
    expect(before).toEqual([{ id: 'a', n: 1 }]);
  });
});
