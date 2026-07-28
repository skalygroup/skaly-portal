import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, test, expect, beforeEach, vi } from 'vitest';

import { useChatScroll, NEAR_BOTTOM_PX } from './use-chat-scroll';

import { api } from '@/lib/api';

/**
 * The two chat traps the sprint guide calls unforgiving (STEP 10).
 *
 *   1. initialPageParam — a RUNTIME error in TanStack Query v5 that survives tsc, so
 *      nothing catches it until the page is opened. Asserted directly against the
 *      query the hook builds.
 *   2. Scroll anchoring — the viewport must not move when older messages PREPEND.
 *      Unit tests can prove scrollTop was compensated; they cannot prove it looked
 *      right, which is why the E2E in STEP 12 asserts a bounding box too.
 */
vi.mock('@/lib/api', () => ({ api: vi.fn() }));
const apiMock = vi.mocked(api);

// jsdom has no IntersectionObserver; the sentinel is exercised in E2E.
class FakeIO {
  observe() {}
  disconnect() {}
  unobserve() {}
}
vi.stubGlobal('IntersectionObserver', FakeIO);

const msg = (id: string, createdAt = new Date().toISOString()) => ({
  id,
  channel: 'common' as const,
  senderId: 'staff-1',
  senderName: 'Rahul Menon',
  senderAvatarUrl: null,
  content: `message ${id}`,
  parentId: null,
  mentions: [],
  replyCount: 0,
  isDeleted: false,
  createdAt,
});

const page = (ids: string[], nextCursor: string | null = null) => ({
  data: ids.map((id) => msg(id)),
  meta: { nextCursor },
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(() => useChatScroll(), { wrapper });
}

/**
 * Attach a fake scroll container through the CALLBACK ref, exactly as React would.
 *
 * This is why the hook exposes a callback ref rather than a useRef object: attaching
 * through it re-runs the effects that depend on the element, so the scroll listener
 * and the observer are really wired. With a plain ref the test could set `.current`
 * and the listener would never attach — the assertions would then be measuring
 * nothing while passing.
 */
function attachScroller(
  attach: (el: HTMLDivElement | null) => void,
  { scrollHeight = 1000, clientHeight = 400, scrollTop = 600 } = {},
) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true, writable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true, writable: true });
  el.scrollTop = scrollTop;
  act(() => attach(el));
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.mockResolvedValue(page(['a', 'b']));
});

describe('⭐ initialPageParam — the v5 runtime error that survives typecheck', () => {
  test('the first fetch runs and resolves, which it cannot without initialPageParam', async () => {
    const { result } = mount();

    // Omitting initialPageParam throws inside useInfiniteQuery at call time with an
    // unhelpful message. Reaching resolved data at all is the assertion.
    await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(0));
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  test('the first request sends NO cursor — the initial page param is empty', async () => {
    mount();
    await waitFor(() => expect(apiMock).toHaveBeenCalled());

    const url = apiMock.mock.calls[0]![0] as string;
    expect(url).toContain('/v1/chat/messages?');
    expect(url).not.toContain('cursor=');
  });

  test('the hook is paired with getNextPageParam — a cursor page is reachable', async () => {
    apiMock.mockResolvedValueOnce(page(['a'], 'cursor-1'));
    const { result } = mount();
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
  });

  test('a null nextCursor ends pagination', async () => {
    apiMock.mockResolvedValue(page(['a'], null));
    const { result } = mount();
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.hasNextPage).toBe(false);
  });
});

describe('⭐ scroll anchoring across a prepend', () => {
  test('⭐ scrollTop is compensated by exactly the height the prepend added', async () => {
    apiMock.mockResolvedValueOnce(page(['newest'], 'cursor-1'));
    const { result } = mount();
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    // The user is scrolled up, reading history — scrollTop 0, container 1000px.
    const el = attachScroller(result.current.scrollRef, { scrollHeight: 1000, scrollTop: 0 });

    // The older page resolves, and the DOM grows by 600px ABOVE the viewport as the
    // prepended rows render. Growing scrollHeight before the state commits is what
    // the browser actually does.
    apiMock.mockResolvedValueOnce(page(['older'], null));
    await act(async () => {
      result.current.loadOlder();
      (el as unknown as { scrollHeight: number }).scrollHeight = 1600;
    });

    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    // Compensated by exactly the delta. Without it scrollTop stays 0 and the user is
    // silently thrown to the top of a page they were not reading.
    expect(el.scrollTop).toBe(600);
  });

  test('no compensation when nothing was prepended', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    const el = attachScroller(result.current.scrollRef, { scrollHeight: 1000, scrollTop: 250 });
    // A re-render that adds no page must not move the viewport.
    await act(async () => {
      result.current.onIncoming();
    });
    expect(el.scrollTop).toBe(250);
  });
});

describe('auto-scroll only at the live edge', () => {
  test('a new message while at the bottom scrolls down', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const { result } = mount();
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    const el = attachScroller(result.current.scrollRef, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    act(() => {
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.atBottom).toBe(true);

    act(() => result.current.onIncoming());

    expect(el.scrollTop).toBe(1000);
    expect(result.current.pendingCount).toBe(0);
    raf.mockRestore();
  });

  test('⭐ a new message while reading history does NOT yank the viewport', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    // Scrolled well up — the user is reading, not watching.
    const el = attachScroller(result.current.scrollRef, { scrollHeight: 2000, clientHeight: 400, scrollTop: 100 });
    act(() => {
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.atBottom).toBe(false);

    act(() => result.current.onIncoming());

    // Position untouched, and the arrival becomes a pill instead.
    expect(el.scrollTop).toBe(100);
    expect(result.current.pendingCount).toBe(1);
  });

  test('the pill counts arrivals and clears on scroll back to the bottom', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    const el = attachScroller(result.current.scrollRef, { scrollHeight: 2000, clientHeight: 400, scrollTop: 100 });
    act(() => el.dispatchEvent(new Event('scroll')));

    act(() => {
      result.current.onIncoming();
      result.current.onIncoming();
      result.current.onIncoming();
    });
    expect(result.current.pendingCount).toBe(3);

    el.scrollTop = 1600; // within NEAR_BOTTOM_PX of 2000 - 400
    act(() => el.dispatchEvent(new Event('scroll')));

    expect(result.current.pendingCount).toBe(0);
    expect(result.current.atBottom).toBe(true);
  });

  test('the near-bottom threshold is a real tolerance, not exact equality', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    // 40px from the bottom — a user who nudged the wheel is still "at the bottom".
    const el = attachScroller(result.current.scrollRef, { scrollHeight: 2000, clientHeight: 400, scrollTop: 1560 });
    act(() => el.dispatchEvent(new Event('scroll')));

    expect(NEAR_BOTTOM_PX).toBeGreaterThan(0);
    expect(result.current.atBottom).toBe(true);
  });
});

describe('ordering', () => {
  test('messages render oldest-first even though the API returns newest-first', async () => {
    apiMock.mockResolvedValue({
      data: [msg('newest', '2026-07-27T10:00:00Z'), msg('older', '2026-07-27T09:00:00Z')],
      meta: { nextCursor: null },
    });
    const { result } = mount();
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    // Top-to-bottom must read chronologically; the reversal happens once, here.
    expect(result.current.messages.map((m) => m.id)).toEqual(['older', 'newest']);
  });
});
