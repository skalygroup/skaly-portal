import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MonthLockSync } from './month-lock-sync';

/**
 * `month:lock_changed`'s client half.
 *
 * The load-bearing assertion is that BOTH cache keys refetch. The five module
 * grids read `['months']` and Settings → Months reads `['settings', 'months']` —
 * same endpoint, two entries — so invalidating one leaves the other showing a
 * lock state the server has already changed.
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

const fetchGridMonths = vi.fn(() => Promise.resolve([{ period: '2026-06', locked: false }]));
const fetchPanelMonths = vi.fn(() => Promise.resolve([{ period: '2026-06', locked: false }]));

/** Stands in for a module grid: reads `['months']` to derive `locked`. */
function GridConsumer({ label }: { label: string }) {
  const { data } = useQuery({ queryKey: ['months'], queryFn: fetchGridMonths, staleTime: 60_000 });
  return <span data-testid={label}>{data ? 'loaded' : 'loading'}</span>;
}

/** Stands in for Settings → Months, which uses its own key for the same endpoint. */
function PanelConsumer() {
  const { data } = useQuery({
    queryKey: ['settings', 'months'],
    queryFn: fetchPanelMonths,
    staleTime: 30_000,
  });
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
    expect(fetchGridMonths).toHaveBeenCalledTimes(1);

    fire({ period: '2026-06', locked: true, actorStaffId: 's1' });

    // Without this component the grids keep `locked: false` for the tab's
    // lifetime — nothing else refetches a sitting page — and the user types into
    // cells whose save will 423.
    await waitFor(() => expect(fetchGridMonths).toHaveBeenCalledTimes(2));
    // Two mounted grids, one refetch: they share a key, so TanStack dedups.
    expect(fetchGridMonths).toHaveBeenCalledTimes(2);
  });

  test('⭐ and Settings → Months too, which uses a DIFFERENT key for the same endpoint', async () => {
    renderAll();
    await waitFor(() => expect(screen.getByTestId('panel').textContent).toBe('loaded'));
    expect(fetchPanelMonths).toHaveBeenCalledTimes(1);

    fire({ period: '2026-06', locked: true, actorStaffId: 's1' });

    // Invalidating only `['months']` would leave an admin's own Months panel
    // showing the pre-lock state after another admin locked it.
    await waitFor(() => expect(fetchPanelMonths).toHaveBeenCalledTimes(2));
  });

  test('an unlock is the same event and refetches identically', async () => {
    renderAll();
    await waitFor(() => expect(fetchGridMonths).toHaveBeenCalledTimes(1));

    // One event carries both directions. A consumer that only reacted to
    // `locked: true` would leave a grid read-only after an unlock — refusing
    // edits the server would now accept.
    fire({ period: '2026-06', locked: false, actorStaffId: 's1' });

    await waitFor(() => expect(fetchGridMonths).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fetchPanelMonths).toHaveBeenCalledTimes(2));
  });

  test('the payload is ignored — invalidate, not patch', async () => {
    renderAll();
    await waitFor(() => expect(fetchGridMonths).toHaveBeenCalledTimes(1));

    // The rows also carry lockedBy/lockedAt/unlock reason, which this payload
    // cannot express. A partial patch would put a row in the cache that never
    // existed server-side, so an empty payload must behave identically.
    fire({});

    await waitFor(() => expect(fetchGridMonths).toHaveBeenCalledTimes(2));
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
