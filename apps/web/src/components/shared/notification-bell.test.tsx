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

// Capture the socket subscriptions so tests can drive events directly.
vi.mock('@/lib/socket', () => ({
  useNotifySocket: (event: string, handler: (payload: unknown) => void) => {
    sockets.handlers.set(event, handler);
  },
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

/** Fire a socket event exactly as the server would. */
async function emit(event: string, payload: unknown) {
  await act(async () => {
    sockets.handlers.get(event)?.(payload);
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
