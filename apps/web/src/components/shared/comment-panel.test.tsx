import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CommentPanel, CommentPanelHost, CommentTrigger, useCommentPanelStore } from './comment-panel';

import { api } from '@/lib/api';

/**
 * Comments on a grid row (STEP 9).
 *
 * The two assertions that carry this file: hostile content renders as LITERAL
 * TEXT (NFR §4.3 — the panel reuses chat's element-emitting renderer, and this
 * proves the reuse actually took), and the thread refreshes off `notify:new`
 * filtered by type — there is no `comment:new` event and a test that invented
 * one would pass while the feature stayed dead (the `report_ready` lesson).
 */
const handlers = new Map<string, (payload: unknown) => void>();

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
    ) {
      super(code);
    }
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/mutation-errors', () => ({ handleMutationError: vi.fn() }));
vi.mock('@/lib/socket', () => ({
  useNotifySocket: (event: string, handler: (payload: unknown) => void) => {
    handlers.set(event, handler);
  },
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(search) }));

let search = '';
const apiMock = vi.mocked(api);

const RECORD = { module: 'shoot_planner' as const, recordId: 'cl-1', period: '2026-06' };

const comment = (over: Record<string, unknown> = {}) => ({
  id: 'c-1',
  content: 'Slot 2 moved to the 14th',
  author: { staffId: 'st-2', name: 'Rahul Menon', role: 'manager' },
  acknowledgedBy: null,
  acknowledgedAt: null,
  createdAt: '2026-06-14T09:30:00.000Z',
  ...over,
});

const STAFF = [
  { id: 'st-1', name: 'Priya Nair', role: 'admin' },
  { id: 'st-2', name: 'Rahul Menon', role: 'manager' },
];

let commentRows: ReturnType<typeof comment>[] = [];
let meRole = 'admin';

function mockApi() {
  apiMock.mockImplementation((path: string) => {
    if (path.startsWith('/v1/comments?')) return Promise.resolve({ data: commentRows });
    if (path === '/v1/staff') return Promise.resolve({ data: STAFF });
    if (path === '/v1/staff/me')
      return Promise.resolve({ id: 'st-1', name: 'Priya Nair', role: meRole });
    return Promise.resolve({ data: {} });
  });
}

function renderPanel(props: { locked?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CommentPanel
        {...RECORD}
        recordName="Naaz Furniture"
        open
        onClose={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  handlers.clear();
  search = '';
  commentRows = [comment()];
  meRole = 'admin';
  // The store is a module singleton, so an open panel would leak into the next test.
  useCommentPanelStore.setState({ target: null });
  vi.clearAllMocks();
  mockApi();
});
afterEach(cleanup);

describe('the thread', () => {
  test('renders each comment with its author and a DM Mono timestamp', async () => {
    commentRows = [comment(), comment({ id: 'c-2', content: 'Confirmed with the client' })];
    renderPanel();

    await waitFor(() => expect(screen.getAllByTestId('comment')).toHaveLength(2));
    expect(screen.getAllByText('Rahul Menon')).toHaveLength(2);
    expect(screen.getByText('Slot 2 moved to the 14th')).toBeTruthy();
    // The timestamp is a <time> with the machine-readable value, not just prose.
    expect(document.querySelector('time')?.getAttribute('dateTime')).toBe(
      '2026-06-14T09:30:00.000Z',
    );
  });

  test('an empty thread says so rather than rendering nothing', async () => {
    commentRows = [];
    renderPanel();
    await waitFor(() => expect(screen.getByText(/No comments on this row yet/)).toBeTruthy());
  });

  test('⭐ a mention of the current user is highlighted', async () => {
    commentRows = [comment({ content: '@Priya Nair can you confirm?' })];
    renderPanel();

    // mention-self is the gold tint; a mention of somebody else is not tinted.
    await waitFor(() => expect(screen.getByTestId('mention-self').textContent).toBe('@Priya Nair'));
  });

  test('⭐ a <script> in a comment renders as literal text', async () => {
    const payload = '<script>alert("xss")</script>';
    commentRows = [comment({ content: payload })];
    const { container } = renderPanel();

    await waitFor(() => expect(screen.getByTestId('comment').textContent).toContain(payload));
    expect(container.querySelector('script')).toBeNull();
  });
});

describe('the composer', () => {
  test('Enter posts and clears the draft; Shift+Enter does not', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('comment')).toBeTruthy());

    const box = screen.getByTestId('comment-composer');
    await user.click(box);
    await user.keyboard('needs a reshoot{Shift>}{Enter}{/Shift}');
    expect((box as HTMLTextAreaElement).value).toContain('needs a reshoot');
    expect(apiMock).not.toHaveBeenCalledWith('/v1/comments', expect.anything());

    apiMock.mockImplementationOnce(() =>
      Promise.resolve({ data: comment({ id: 'c-9', content: 'needs a reshoot' }) }),
    );
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/v1/comments', {
        method: 'POST',
        body: JSON.stringify({ ...RECORD, content: 'needs a reshoot' }),
      }),
    );
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });

  test('the posted comment appears without waiting for a notification', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('comment')).toBeTruthy());

    apiMock.mockImplementationOnce(() =>
      Promise.resolve({ data: comment({ id: 'c-9', content: 'posted by me' }) }),
    );
    await user.click(screen.getByTestId('comment-composer'));
    await user.keyboard('posted by me{Enter}');

    // The author is excluded from their own fan-out (ADR-006), so nothing is
    // coming to refetch this — the row has to be appended locally or the comment
    // vanishes until the next fetch.
    await waitFor(() => expect(screen.getByText('posted by me')).toBeTruthy());
  });

  test('⭐ @ opens the autocomplete over the staff list, and choosing inserts the name', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('comment')).toBeTruthy());

    const box = screen.getByTestId('comment-composer');
    await user.click(box);
    await user.keyboard('@Rah');

    await waitFor(() => expect(screen.getAllByTestId('comment-mention-option')).toHaveLength(1));
    await user.click(screen.getByTestId('comment-mention-option'));
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe('@Rahul Menon '));
  });

  test('a locked period disables the composer (the 423 stays the boundary)', async () => {
    renderPanel({ locked: true });
    await waitFor(() => expect(screen.getByTestId('comment')).toBeTruthy());
    expect((screen.getByTestId('comment-composer') as HTMLTextAreaElement).disabled).toBe(true);
  });
});

describe('acknowledge', () => {
  test('an admin can acknowledge; the badge names who did', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('comment-acknowledge-c-1')).toBeTruthy());

    commentRows = [comment({ acknowledgedBy: { staffId: 'st-1', name: 'Priya Nair' } })];
    await user.click(screen.getByTestId('comment-acknowledge-c-1'));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/v1/comments/c-1/acknowledge', {
        method: 'PATCH',
        body: JSON.stringify({ acknowledged: true }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('comment-acknowledged').textContent).toContain('Priya Nair'),
    );
  });

  test('a team member is not offered the button — the route is admin/manager', async () => {
    meRole = 'team_member';
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('comment')).toBeTruthy());
    expect(screen.queryByTestId('comment-acknowledge-c-1')).toBeNull();
  });
});

describe('live updates', () => {
  test('⭐ new_comment on THIS record refetches the thread', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('comment')).toBeTruthy());

    const onNotify = handlers.get('notify:new');
    // If this is undefined the panel subscribed to something the server never
    // emits — there is no `comment:new` event, only the notification type.
    expect(onNotify, 'the panel must subscribe to notify:new').toBeDefined();

    commentRows = [comment(), comment({ id: 'c-2', content: 'and another' })];
    // ⚠️ The SERVER's shape: NotificationService emits the row, so the jsonb is
    // `payload`. This test asserted `data` and passed against a component that
    // never refreshed in production — the field name is load-bearing.
    onNotify!({
      id: 'n-1',
      type: 'new_comment',
      title: 'New comment',
      payload: { recordId: 'cl-1', module: 'shoot_planner', commentId: 'c-2' },
    });

    await waitFor(() => expect(screen.getByText('and another')).toBeTruthy());
  });

  test('a notification for a DIFFERENT record is ignored', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('comment')).toBeTruthy());
    const calls = apiMock.mock.calls.length;

    handlers.get('notify:new')!({
      type: 'new_comment',
      payload: { recordId: 'cl-99', module: 'shoot_planner' },
    });
    // Same guard for an unrelated type: one task assignment must not refetch
    // every open thread in the building.
    handlers.get('notify:new')!({ type: 'task_assigned', payload: { recordId: 'cl-1' } });

    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.mock.calls.length).toBe(calls);
  });
});

/**
 * The trigger and the panel are deliberately NOT nested: the trigger sits in a
 * TanStack cell, and a cell remount would take a nested panel down with it.
 * These render both halves the way the portal layout does.
 */
function renderTriggerAndHost() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CommentTrigger {...RECORD} recordName="Naaz Furniture" />
      <CommentPanelHost />
    </QueryClientProvider>,
  );
}

describe('the trigger', () => {
  test('clicking it opens the panel that lives outside the cell', async () => {
    const user = userEvent.setup();
    renderTriggerAndHost();
    expect(screen.queryByTestId('comment-composer')).toBeNull();

    await user.click(screen.getByTestId('comments-open-cl-1'));
    await waitFor(() => expect(screen.getByTestId('comment')).toBeTruthy());
  });

  test('⭐ the panel survives the trigger remounting — the TanStack column rebuild', async () => {
    const user = userEvent.setup();
    const { unmount } = renderTriggerAndHost();
    await user.click(screen.getByTestId('comments-open-cl-1'));
    await waitFor(() => expect(screen.getByTestId('comment')).toBeTruthy());

    // What a column rebuild does to a cell: throw it away and mount a new one.
    // With the open flag inside the trigger this closed the panel mid-typing.
    unmount();
    renderTriggerAndHost();
    await waitFor(() => expect(screen.getByTestId('comment')).toBeTruthy());
  });
});

describe('the deep link', () => {
  test('⭐ ?comments=<recordId> opens that row’s thread', async () => {
    search = 'period=2026-06&comments=cl-1';
    renderTriggerAndHost();

    // The `new_comment` notification links to /<module>?period=…&comments=<id>.
    // Without this the link lands on the right grid and the user has to guess
    // which row was commented on.
    await waitFor(() => expect(screen.getByTestId('comment')).toBeTruthy());
  });

  test('a trigger for another row stays shut', async () => {
    search = 'period=2026-06&comments=cl-99';
    renderTriggerAndHost();

    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('comment')).toBeNull();
  });
});
