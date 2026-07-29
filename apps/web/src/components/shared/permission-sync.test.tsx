import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PermissionSync } from './permission-sync';

/**
 * ADR-029's client half (STEP 10).
 *
 * The interesting assertion is the COUNT. `['staff-me']` has five consumers —
 * the four module grids and the search palette — and one permission change must
 * produce one refetch, not five. It already would, because they share a cache
 * key; this test is what stops someone "fixing" a future bug by giving one of
 * them its own key.
 */
const handlers = new Map<string, (payload: unknown) => void>();
const refresh = vi.fn();

/**
 * Fire the event BY THE SERVER'S NAME, and throw if nothing is listening.
 *
 * `handlers.get(x)?.(...)` is a silent no-op on a miss — the shape that let the
 * reports panel subscribe to an event the server never emits and still show
 * green. `permission_changed` is the name PermissionService actually emits.
 */
function fire(payload: unknown) {
  const handler = handlers.get('permission_changed');
  if (!handler) throw new Error('PermissionSync never subscribed to "permission_changed"');
  handler(payload);
}

vi.mock('@/lib/socket', () => ({
  useNotifySocket: (event: string, handler: (payload: unknown) => void) => {
    handlers.set(event, handler);
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const fetchMe = vi.fn(() => Promise.resolve({ permissions: {} }));

/** Stands in for the grids: same key, same query, mounted more than once. */
function MeConsumer({ label }: { label: string }) {
  const { data } = useQuery({ queryKey: ['staff-me'], queryFn: fetchMe, staleTime: 60_000 });
  return <span data-testid={label}>{data ? 'loaded' : 'loading'}</span>;
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

function renderWithConsumers() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PermissionSync />
      <MeConsumer label="grid-a" />
      <MeConsumer label="grid-b" />
      <MeConsumer label="palette" />
    </QueryClientProvider>,
  );
}

describe('permission_changed', () => {
  test('⭐ triggers exactly ONE /v1/staff/me refetch across every consumer', async () => {
    renderWithConsumers();
    await waitFor(() => expect(screen.getByTestId('grid-a').textContent).toBe('loaded'));
    expect(fetchMe).toHaveBeenCalledTimes(1);

    fire({ staffId: 's1', permissionKey: 'module.tasks.read' });

    await waitFor(() => expect(fetchMe).toHaveBeenCalledTimes(2));
    // Three mounted consumers, one additional fetch — not three.
    expect(fetchMe).toHaveBeenCalledTimes(2);
  });

  test('⭐ also refreshes the Server Components, where the settings nav is derived', async () => {
    renderWithConsumers();
    await waitFor(() => expect(screen.getByTestId('grid-a').textContent).toBe('loaded'));

    fire({ staffId: 's1', permissionKey: 'module.tasks.read' });

    // Invalidating a client cache does nothing for `requirePanel` or the settings
    // nav — both resolve permissions on the server. Without this the nav a user
    // sees and the gate answering their next URL can disagree.
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  test('the payload is ignored — this is an invalidate, not a patch', async () => {
    renderWithConsumers();
    await waitFor(() => expect(fetchMe).toHaveBeenCalledTimes(1));

    // ADR-022's matrix: the event names the key that changed but cannot express
    // what it RESOLVES to. Reacting to the payload would be a second resolver,
    // in the browser, guessing — so an empty payload must behave identically.
    fire({});
    await waitFor(() => expect(fetchMe).toHaveBeenCalledTimes(2));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('renders nothing', () => {
    const qc = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={qc}>
        <PermissionSync />
      </QueryClientProvider>,
    );
    expect(container.innerHTML).toBe('');
  });
});
