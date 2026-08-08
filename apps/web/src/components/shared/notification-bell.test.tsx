import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { NotificationBell } from './notification-bell';

import { api } from '@/lib/api';

/**
 * The bell (Sprint 10 STEP 5, UIUX §16).
 *
 * The load-bearing test here is "notify:new prepends WITHOUT a refetch". A bell that
 * refetches per notification is the org-wide fan-out problem in miniature — 50 users,
 * one task assignment, 50 GETs — and it is invisible in manual testing because the
 * data still looks right.
 *
 * The second is that badge and panel read ONE cache entry. Fetching the count
 * separately is how you get a "3" over an empty list.
 */
const nav = vi.hoisted(() => ({ push: vi.fn() }));
const sockets = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
  usePathname: () => '/home',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api', () => ({ api: vi.fn() }));

/**
 * Capture the socket subscriptions so tests can drive events directly.
 *
 * The bell now subscribes through `useRealtimeQuery` (ADR-025), which calls
 * `getSocket().on(...)` and gates its fetch on confirmed room membership. So the
 * mock has to supply both halves: a socket whose handlers we can fire, and a
 * `useSocketRooms` that reports subscribed — otherwise the query never runs and
 * every assertion here fails on an empty bell.
 */
vi.mock('@/lib/socket', () => ({
  WS_NOTIFY: '/ws/notify',
  useSocketRooms: () => ({ subscribed: true }),
  getSocket: () => ({
    connected: true,
    on: (event: string, handler: (payload: unknown) => void) => {
      sockets.handlers.set(event, handler);
    },
    off: () => {},
    emit: () => {},
  }),
}));

const apiMock = vi.mocked(api);

const notification = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'n-1',
  type: 'task_assigned',
  title: 'Edit the Naaz reel',
  body: 'You were assigned a task',
  payload: { taskId: 'task-1', period: '2026-07' },
  isRead: false,
  createdAt: new Date().toISOString(),
  ...over,
});

const listResponse = (items: ReturnType<typeof notification>[], unreadCount?: number) => ({
  data: items,
  meta: {
    unreadCount: unreadCount ?? items.filter((n) => !n.isRead).length,
    totalReturned: items.length,
    limit: 50,
  },
});

function renderBell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NotificationBell />
    </QueryClientProvider>,
  );
}

/**
 * Fire a socket event exactly as the server would — BY THE SERVER'S NAME.
 *
 * Throws on an unregistered name rather than `?.()`-ing into nothing. That
 * optional call is how the reports panel shipped a handler bound to an event no
 * server ever emits: the test fired the same wrong name, hit `undefined`, did
 * nothing, and passed. Every name below must appear in the api's emit list
 * (`notify:new`, `notify:read`); if the bell stops subscribing to one, this
 * fails loudly instead of quietly proving nothing.
 */
async function emit(event: string, payload: unknown) {
  const handler = sockets.handlers.get(event);
  if (!handler) throw new Error(`the bell never subscribed to "${event}"`);
  await act(async () => {
    handler(payload);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sockets.handlers.clear();
  apiMock.mockResolvedValue(listResponse([notification()]));
});

afterEach(cleanup);

describe('the badge', () => {
  test('reflects the unread count from the list response', async () => {
    apiMock.mockResolvedValue(
      listResponse([notification({ id: 'a' }), notification({ id: 'b' }), notification({ id: 'c', isRead: true })]),
    );
    renderBell();

    expect((await screen.findByTestId('notification-badge')).textContent).toBe('2');
  });

  test('caps the DISPLAY at 99+, not the query', async () => {
    apiMock.mockResolvedValue(listResponse([notification()], 250));
    renderBell();

    expect((await screen.findByTestId('notification-badge')).textContent).toBe('99+');
  });

  test('is absent when nothing is unread', async () => {
    apiMock.mockResolvedValue(listResponse([notification({ isRead: true })]));
    renderBell();

    await screen.findByRole('button', { name: 'Notifications' });
    expect(screen.queryByTestId('notification-badge')).toBeNull();
  });
});

describe('notify:new', () => {
  test('⭐ prepends from the payload and does NOT refetch', async () => {
    renderBell();
    await screen.findByTestId('notification-badge');

    const callsAfterInitialLoad = apiMock.mock.calls.length;

    await emit('notify:new', {
      id: 'n-live',
      type: 'holiday_added',
      title: 'Diwali — 2026-11-08',
      message: 'A holiday was added to the calendar',
      payload: { period: '2026-11' },
      is_read: false,
      created_at: new Date().toISOString(),
    });

    // The badge moved…
    expect((await screen.findByTestId('notification-badge')).textContent).toBe('2');
    // …and the query function was NOT called again. This is the whole point: the
    // payload is complete enough to render, so the bell never refetches.
    expect(apiMock.mock.calls.length).toBe(callsAfterInitialLoad);
  });

  test('the prepended row is rendered in the panel, from the same cache entry', async () => {
    const user = userEvent.setup();
    renderBell();
    await screen.findByTestId('notification-badge');

    await emit('notify:new', {
      id: 'n-live',
      type: 'holiday_added',
      title: 'Diwali — 2026-11-08',
      message: null,
      payload: { period: '2026-11' },
      is_read: false,
      created_at: new Date().toISOString(),
    });

    await user.click(screen.getByRole('button', { name: /Notifications/ }));

    // Badge and panel are one source of truth — a count with an empty list behind
    // it is the classic two-sources bug.
    expect(await screen.findByText('Diwali — 2026-11-08')).not.toBeNull();
    expect(screen.getAllByTestId('notification-row')).toHaveLength(2);
  });

  test('a redelivered notification is not double-counted', async () => {
    renderBell();
    await screen.findByTestId('notification-badge');

    const payload = {
      id: 'n-dupe',
      type: 'task_assigned',
      title: 'Same one twice',
      message: null,
      payload: {},
      is_read: false,
      created_at: new Date().toISOString(),
    };
    // Socket.io can redeliver on reconnect.
    await emit('notify:new', payload);
    await emit('notify:new', payload);

    expect((await screen.findByTestId('notification-badge')).textContent).toBe('2');
  });
});

describe('notify:read — cross-tab', () => {
  test('patches the exact rows and decrements the badge', async () => {
    apiMock.mockResolvedValue(listResponse([notification({ id: 'a' }), notification({ id: 'b' })]));
    renderBell();
    expect((await screen.findByTestId('notification-badge')).textContent).toBe('2');

    // Another tab marked one read.
    await emit('notify:read', { ids: ['a'] });

    expect((await screen.findByTestId('notification-badge')).textContent).toBe('1');
  });

  test('read-all in another tab clears the badge entirely', async () => {
    apiMock.mockResolvedValue(listResponse([notification({ id: 'a' }), notification({ id: 'b' })]));
    renderBell();
    await screen.findByTestId('notification-badge');

    await emit('notify:read', { ids: ['a', 'b'] });

    await waitFor(() => expect(screen.queryByTestId('notification-badge')).toBeNull());
  });

  test('a repeated notify:read does not drive the count negative', async () => {
    apiMock.mockResolvedValue(listResponse([notification({ id: 'a' })]));
    renderBell();
    await screen.findByTestId('notification-badge');

    await emit('notify:read', { ids: ['a'] });
    await emit('notify:read', { ids: ['a'] });

    await waitFor(() => expect(screen.queryByTestId('notification-badge')).toBeNull());
  });
});

describe('the panel', () => {
  test('clicking a row marks it read and navigates to the registry deep link', async () => {
    const user = userEvent.setup();
    renderBell();
    await screen.findByTestId('notification-badge');

    await user.click(screen.getByRole('button', { name: /Notifications/ }));
    await user.click(await screen.findByTestId('notification-row'));

    // The URL comes from the registry's linkBuilder — no construction in the component.
    expect(nav.push).toHaveBeenCalledWith('/tasks?period=2026-07&highlight=task-1');
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/v1/notifications/n-1/read', { method: 'PUT' }),
    );
  });

  test('[Mark all read] clears the badge and calls read-all', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(listResponse([notification({ id: 'a' }), notification({ id: 'b' })]));
    renderBell();
    await screen.findByTestId('notification-badge');

    await user.click(screen.getByRole('button', { name: /Notifications/ }));
    await user.click(await screen.findByRole('button', { name: 'Mark all read' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/v1/notifications/read-all', { method: 'PUT' }),
    );
    await waitFor(() => expect(screen.queryByTestId('notification-badge')).toBeNull());
  });

  test('closes on Escape', async () => {
    const user = userEvent.setup();
    renderBell();
    await screen.findByTestId('notification-badge');

    await user.click(screen.getByRole('button', { name: /Notifications/ }));
    expect(await screen.findByRole('dialog')).not.toBeNull();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('closes on an outside click', async () => {
    const user = userEvent.setup();
    renderBell();
    await screen.findByTestId('notification-badge');

    await user.click(screen.getByRole('button', { name: /Notifications/ }));
    expect(await screen.findByRole('dialog')).not.toBeNull();

    await user.click(document.body);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('renders the empty state when there is nothing', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(listResponse([]));
    renderBell();

    await user.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText(/all caught up/i)).not.toBeNull();
  });

  test('a critical type renders untruncated (FR-NOTIF-04), driven by registry severity', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(
      listResponse([
        notification({
          id: 'r',
          type: 'rollover_failed',
          title: 'Rollover failed',
          body: 'A long failure message that must not be clamped to two lines.',
        }),
      ]),
    );
    renderBell();

    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    const body = await screen.findByText(/must not be clamped/);
    // Severity comes from the registry, so the next critical type inherits this
    // without a type-name check in the component.
    expect(body.className).not.toContain('line-clamp-2');
  });
});

/**
 * ⭐ Sprint 13 — the four rollover types and the inline recovery action (ADR-036).
 *
 * Every payload below is shaped like the SERVER's row, not like the component's
 * props: snake_case `is_read`/`created_at`, the jsonb under `payload`. That is the
 * bug caught twice already (report_ready, live comments) — a test that fires the
 * handler's assumed shape passes against a feature that is dead in production.
 */
describe('the rollover notifications (Sprint 13)', () => {
  const rolloverFailure = (over: Record<string, unknown> = {}) =>
    notification({
      id: 'rf-1',
      type: 'rollover_failed',
      title: 'Rollover failed',
      body: 'Rollover for July 2094 failed at step audit. The previous month is intact — data was not affected. A detailed summary is being generated.',
      payload: { period: '2094-07', failedStep: 'audit', action: 'manual_rollover' },
      ...over,
    });

  test('month_ready and rollover_success render as ordinary rows, with no action', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(
      listResponse([
        notification({ id: 'mr', type: 'month_ready', title: 'July 2094 is ready', payload: { period: '2094-07' } }),
        notification({ id: 'rs', type: 'rollover_success', title: 'Rollover completed', payload: { period: '2094-07' } }),
      ]),
    );
    renderBell();

    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    expect(await screen.findByText('July 2094 is ready')).not.toBeNull();
    expect(screen.getByText('Rollover completed')).not.toBeNull();
    // No recovery button on a success — the payload carries no `action`.
    expect(screen.queryByTestId('manual-rollover')).toBeNull();
  });

  test('a TEMPLATED failure body (the AI summary failed) renders fine on its own', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(listResponse([rolloverFailure()]));
    renderBell();

    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    // The component must assume nothing about enrichment: the templated body IS a
    // complete notification (ADR-036 §2), and it is what an admin sees whenever
    // Anthropic was down at 00:01.
    const body = await screen.findByText(/The previous month is intact/);
    expect(body.className).not.toContain('line-clamp-2');
    expect(screen.getByTestId('manual-rollover')).not.toBeNull();
  });

  test('an ENRICHED failure body renders in full, untruncated', async () => {
    const user = userEvent.setup();
    const summary =
      'The system could not finish setting up the new month last night. None of your existing data was changed or lost. You can retry it from this notification, and if it fails again the team should be told.';
    apiMock.mockResolvedValue(listResponse([rolloverFailure({ body: summary })]));
    renderBell();

    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    const body = await screen.findByText(/could not finish setting up/);
    expect(body.textContent).toBe(summary);
    expect(body.className).not.toContain('line-clamp-2');
  });

  test('⭐ [Manual rollover] POSTs the shared idempotent endpoint and disables on click', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(listResponse([rolloverFailure()]));
    renderBell();

    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    const button = await screen.findByTestId('manual-rollover');

    // Never resolves during the assertion window, so the pending state is observable.
    let release: (() => void) | undefined;
    apiMock.mockImplementationOnce(
      () => new Promise<never>((_, reject) => { release = () => reject(new Error('done')); }),
    );
    await user.click(button);

    // The SAME endpoint the cron hits (ADR-037 §4) — not a force path.
    expect(apiMock).toHaveBeenCalledWith('/v1/internal/rollover?period=2094-07', { method: 'POST' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    release?.();
  });

  test('a failed manual rollover offers a retry rather than a second error surface', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(listResponse([rolloverFailure()]));
    renderBell();

    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    apiMock.mockRejectedValueOnce(new Error('still broken'));
    await user.click(await screen.findByTestId('manual-rollover'));

    await waitFor(() => expect(screen.getByTestId('manual-rollover').textContent).toBe('Retry rollover'));
    // The notification above it already says what went wrong; a competing toast
    // would tell the admin the same thing twice.
    expect(screen.getByText(/The previous month is intact/)).not.toBeNull();
  });

  test('a successful manual rollover reports completion in place', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(listResponse([rolloverFailure()]));
    renderBell();

    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    apiMock.mockResolvedValueOnce({ data: { period: '2094-07', status: 'completed' } });
    await user.click(await screen.findByTestId('manual-rollover'));

    await waitFor(() => expect(screen.getByText(/Rollover completed for 2094-07/)).not.toBeNull());
  });

  test('⭐ a rollover notification arriving over the SERVER emit lands in the panel', async () => {
    const user = userEvent.setup();
    renderBell();
    await screen.findByTestId('notification-badge');
    await user.click(screen.getByRole('button', { name: /Notifications/ }));

    // The server's row shape, over notify:new — a TYPE, not an event of its own.
    await emit('notify:new', {
      id: 'rf-live',
      type: 'rollover_view_refresh_failed',
      title: 'Dashboard refresh failed',
      message: 'Rollover for July 2094 failed at step view_refresh. The previous month is intact.',
      payload: { period: '2094-07', failedStep: 'view_refresh', action: 'manual_rollover' },
      is_read: false,
      created_at: new Date().toISOString(),
    });

    expect(await screen.findByText('Dashboard refresh failed')).not.toBeNull();
    expect(screen.getByTestId('manual-rollover')).not.toBeNull();
  });
});
