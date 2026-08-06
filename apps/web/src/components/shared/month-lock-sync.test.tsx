import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MonthLockSync } from './month-lock-sync';

/**
 * `month:lock_changed`'s client half.
 *
 * The load-bearing assertion is that every surface reading `GET /v1/months`
 * refetches from ONE invalidation. That used to take two, because Settings →
 * Months kept its own `['settings', 'months']` entry for the same endpoint; the
 * keys were unified in Sprint 12 STEP 8. So the panel is mounted here under the
 * shared key, and if anyone re-splits it this test's single refetch stops
 * reaching it.
 */
const handlers = new Map<string, (payload: unknown) => void>();

/**
 * Fire the event BY THE SERVER'S NAME, and throw if nothing is listening.
 *
 * `handlers.get(x)?.(...)` is a silent no-op on a miss — the shape that let the
 * reports panel subscribe to an event the server never emits and still show
 * green. `month:lock_changed` is what MonthService.lockMonth broadcasts.
 */
function fire(payload: unknown) {
  const handler = handlers.get('month:lock_changed');
  if (!handler) throw new Error('MonthLockSync never subscribed to "month:lock_changed"');
  handler(payload);
}

vi.mock('@/lib/socket', () => ({
  useNotifySocket: (event: string, handler: (payload: unknown) => void) => {
    handlers.set(event, handler);
  },
}));

const fetchMonths = vi.fn(() => Promise.resolve([{ period: '2026-06', locked: false }]));

/** Stands in for a module grid: reads `['months']` to derive `locked`. */
function GridConsumer({ label }: { label: string }) {
  const { data } = useQuery({ queryKey: ['months'], queryFn: fetchMonths, staleTime: 60_000 });
  return <span data-testid={label}>{data ? 'loaded' : 'loading'}</span>;
}

/** Stands in for Settings → Months — same endpoint, same key, its own staleTime. */
function PanelConsumer() {
  const { data } = useQuery({ queryKey: ['months'], queryFn: fetchMonths, staleTime: 30_000 });
  return <span data-testid="panel">{data ? 'loaded' : 'loading'}</span>;
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

function renderAll() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MonthLockSync />
      <GridConsumer label="grid-a" />
      <GridConsumer label="grid-b" />
      <PanelConsumer />
    </QueryClientProvider>,
  );
}

describe('month:lock_changed', () => {
  test('⭐ refetches the GRIDS — the surface that was silently missing', async () => {
    renderAll();
    await waitFor(() => expect(screen.getByTestId('grid-a').textContent).toBe('loaded'));
    expect(fetchMonths).toHaveBeenCalledTimes(1);

    fire({ period: '2026-06', locked: true, actorStaffId: 's1' });

    // Without this component the grids keep `locked: false` for the tab's
    // lifetime — nothing else refetches a sitting page — and the user types into
    // cells whose save will 423.
    await waitFor(() => expect(fetchMonths).toHaveBeenCalledTimes(2));
  });

  test('⭐ ONE invalidation reaches Settings → Months too — the unified key', async () => {
    renderAll();
    await waitFor(() => expect(screen.getByTestId('panel').textContent).toBe('loaded'));
    // Three mounted consumers, one fetch: the grids and the panel share the key,
    // so TanStack dedups. That is the unification — before it, the panel had its
    // own entry and its own fetch, and an invalidation naming only `['months']`
    // left an admin's Months panel showing the pre-lock state.
    expect(fetchMonths).toHaveBeenCalledTimes(1);

    fire({ period: '2026-06', locked: true, actorStaffId: 's1' });

    await waitFor(() => expect(fetchMonths).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('panel').textContent).toBe('loaded');
  });

  test('an unlock is the same event and refetches identically', async () => {
    renderAll();
    await waitFor(() => expect(fetchMonths).toHaveBeenCalledTimes(1));

    // One event carries both directions. A consumer that only reacted to
    // `locked: true` would leave a grid read-only after an unlock — refusing
    // edits the server would now accept.
    fire({ period: '2026-06', locked: false, actorStaffId: 's1' });

    await waitFor(() => expect(fetchMonths).toHaveBeenCalledTimes(2));
  });

  test('the payload is ignored — invalidate, not patch', async () => {
    renderAll();
    await waitFor(() => expect(fetchMonths).toHaveBeenCalledTimes(1));

    // The rows also carry lockedBy/lockedAt/unlock reason, which this payload
    // cannot express. A partial patch would put a row in the cache that never
    // existed server-side, so an empty payload must behave identically.
    fire({});

    await waitFor(() => expect(fetchMonths).toHaveBeenCalledTimes(2));
  });

  test('renders nothing', () => {
    const qc = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MonthLockSync />
      </QueryClientProvider>,
    );
    expect(container.innerHTML).toBe('');
  });
});
