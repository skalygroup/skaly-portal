import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { SearchPalette } from './search-palette';

import { api } from '@/lib/api';

/**
 * The CMD+K palette (Sprint 9 STEP 11).
 *
 * Two of these are regression locks rather than feature tests: `shouldFilter`
 * (cmdk silently dropping server results is the classic wiring bug) and the
 * debounce (one request per burst, FR-SEARCH-02).
 */
const nav = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
  usePathname: () => '/home',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api', () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

const task = (n: number) => ({
  id: `task-${n}`,
  // Deliberately shares no substring with the query the tests type — cmdk's own
  // fuzzy filter would drop every one of these if shouldFilter were left on.
  description: `Edit the Naaz Furniture reel ${n}`,
  period: '2026-07',
  status: 'To Do',
  clientName: 'Naaz Furniture',
});

const STAFF = { id: 'staff-1', name: 'Rahul Menon', role: 'team_member', avatarUrl: null };

const results = {
  tasks: [1, 2, 3, 4, 5, 6, 7].map(task),
  clients: [{ id: 'client-1', name: 'Naaz Furniture' }],
  staff: [STAFF],
  comments: [],
};

/** Every /v1/search request the palette made, in order. */
let searchCalls: string[] = [];

function mockApi(role: string): void {
  apiMock.mockImplementation(((path: string) => {
    if (path.startsWith('/v1/staff/me')) return Promise.resolve({ role });
    if (path.startsWith('/v1/search')) {
      searchCalls.push(path);
      return Promise.resolve({ data: results });
    }
    return Promise.reject(new Error(`unexpected request: ${path}`));
  }) as typeof api);
}

function renderPalette(role = 'admin') {
  mockApi(role);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SearchPalette />
    </QueryClientProvider>,
  );
}

/** The global hotkey, as a real cancelable event so preventDefault is observable. */
function pressHotkey(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'k',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
}

async function openAndType(text: string, role = 'admin') {
  const user = userEvent.setup();
  renderPalette(role);
  pressHotkey();
  await user.type(await screen.findByPlaceholderText(/search tasks/i), text);
  return user;
}

beforeEach(() => {
  searchCalls = [];
  nav.push.mockReset();
  apiMock.mockReset();
  // jsdom has no layout engine: cmdk observes its list for resizes and scrolls
  // the selected item into view, neither of which jsdom implements.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('the hotkey', () => {
  test('CMD+K opens the palette and prevents the browser default', () => {
    renderPalette();
    expect(screen.queryByPlaceholderText(/search tasks/i)).toBeNull();

    const event = pressHotkey();

    expect(screen.getByPlaceholderText(/search tasks/i)).toBeTruthy();
    // Without preventDefault, Chrome/Firefox steal the chord for their own
    // address-bar search.
    expect(event.defaultPrevented).toBe(true);
  });

  test('a second press closes it again', () => {
    renderPalette();
    pressHotkey();
    pressHotkey();
    expect(screen.queryByPlaceholderText(/search tasks/i)).toBeNull();
  });
});

describe('the query', () => {
  test('does not fire below 2 characters', async () => {
    await openAndType('n');
    // Long enough for the 200ms debounce to have fired if it were going to.
    await new Promise((r) => setTimeout(r, 350));
    expect(searchCalls).toEqual([]);
    expect(screen.getByText(/type at least 2 characters/i)).toBeTruthy();
  });

  test('a burst of keystrokes issues exactly ONE request', async () => {
    await openAndType('naaz');
    await waitFor(() => expect(searchCalls.length).toBe(1));
    expect(searchCalls[0]).toContain('q=naaz');

    // And nothing trails in afterwards.
    await new Promise((r) => setTimeout(r, 350));
    expect(searchCalls.length).toBe(1);
  });

  test('the scope pill re-keys the query, and defaults to this month', async () => {
    const user = await openAndType('naaz');
    await waitFor(() => expect(searchCalls.length).toBe(1));
    expect(searchCalls[0]).toContain('scope=current');

    await user.click(screen.getByRole('button', { name: 'All time' }));
    await waitFor(() => expect(searchCalls.length).toBe(2));
    expect(searchCalls[1]).toContain('scope=all_time');
  });
});

describe('rendering server results', () => {
  test('⚠️ shouldFilter={false}: results render even when they do not match cmdk’s heuristic', async () => {
    // "qqqq" appears in no result text or value. With cmdk's default client-side
    // filtering, every server result would be hidden — the single most common
    // bug when wiring cmdk to a server search.
    await openAndType('qqqq');
    expect(await screen.findByText('Edit the Naaz Furniture reel 1')).toBeTruthy();
    expect(screen.getByText('Naaz Furniture')).toBeTruthy();
  });

  test('shows 5 per group, and [Show more] reveals the rest with NO new request', async () => {
    const user = await openAndType('naaz');
    await screen.findByText('Edit the Naaz Furniture reel 1');

    expect(screen.getByText('Edit the Naaz Furniture reel 5')).toBeTruthy();
    expect(screen.queryByText('Edit the Naaz Furniture reel 6')).toBeNull();

    const callsBefore = searchCalls.length;
    await user.click(screen.getByText(/show more/i));

    expect(screen.getByText('Edit the Naaz Furniture reel 7')).toBeTruthy();
    // The other 15 of the 20 were already in hand (FR-SEARCH-03).
    expect(searchCalls.length).toBe(callsBefore);
  });
});

describe('result navigation (APPFLOW §12)', () => {
  test('a task result navigates with period + highlight', async () => {
    const user = await openAndType('naaz');
    await user.click(await screen.findByText('Edit the Naaz Furniture reel 1'));
    expect(nav.push).toHaveBeenCalledWith('/tasks?period=2026-07&highlight=task-1');
  });

  test('a staff result takes admin/manager to the staff settings page', async () => {
    const user = await openAndType('rahul', 'admin');
    await user.click(await screen.findByText('Rahul Menon'));
    expect(nav.push).toHaveBeenCalledWith('/settings/staff/staff-1');
  });

  test('the same result opens the profile in place for a team_member — no navigation', async () => {
    const user = await openAndType('rahul', 'team_member');
    await user.click(await screen.findByText('Rahul Menon'));

    expect(nav.push).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Rahul Menon')).toBeTruthy();
  });
});
