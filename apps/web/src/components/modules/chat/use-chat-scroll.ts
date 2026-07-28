'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ChatListResponse } from '@skaly/shared';

import { api } from '@/lib/api';

/**
 * Chat history: reverse infinite scroll, with the two things that make chat different
 * from every grid this codebase already has.
 *
 * ⚠️ 1. TanStack Query v5 REQUIRES `initialPageParam`. Omitting it is a RUNTIME error
 *       with an unhelpful message, and it survives `tsc` — so nothing catches it until
 *       the page is open. It is asserted in the tests for exactly that reason.
 *
 * ⚠️ 2. SCROLL ANCHORING. Every prior grid paginates DOWNWARD; chat loads OLDER
 *       messages when scrolling UP, which PREPENDS content. Prepending grows
 *       scrollHeight above the viewport, so the browser keeps scrollTop unchanged and
 *       the user is silently thrown to a different message. Capture scrollHeight
 *       BEFORE the prepend and restore `scrollTop += (newHeight - oldHeight)` in a
 *       useLayoutEffect AFTER.
 *
 *       useLayoutEffect, not useEffect: useEffect runs after paint, so the jump is
 *       visible as a flicker before it is corrected. This is the single most common
 *       chat bug and no unit test catches the visual half of it.
 */
const PAGE_LIMIT = 50;

/** Within this many px of the bottom counts as "reading the live edge". */
export const NEAR_BOTTOM_PX = 100;

export interface UseChatScrollResult {
  messages: ChatListResponse['data'];
  /**
   * CALLBACK refs, not plain useRef objects.
   *
   * A `useRef` is invisible to the effect system: the effect that attaches the scroll
   * listener runs once with whatever `.current` happens to be, and never again. That
   * is fine only if the element is mounted before the first effect and never
   * remounts — neither of which is guaranteed here, since the container renders
   * alongside a pending query and React may remount it.
   *
   * A state-backed callback ref makes the element an effect DEPENDENCY, so the
   * listener and the IntersectionObserver attach when the element actually arrives.
   */
  scrollRef: (el: HTMLDivElement | null) => void;
  sentinelRef: (el: HTMLDivElement | null) => void;
  /** The live container, for consumers that need to measure it. */
  scrollEl: HTMLDivElement | null;
  isPending: boolean;
  isError: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  /** True when the user is at the live edge; drives auto-scroll vs the pill. */
  atBottom: boolean;
  /** Unread arrivals while scrolled away — the "↓ New messages" pill count. */
  pendingCount: number;
  scrollToBottom: () => void;
  /** Load the next OLDER page. The sentinel calls this; exposed so a test can too. */
  loadOlder: () => void;
  /** Call when a socket message arrives so the pill/auto-scroll decision is made. */
  onIncoming: () => void;
}

export function useChatScroll(): UseChatScrollResult {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [sentinelEl, setSentinelEl] = useState<HTMLDivElement | null>(null);

  const [atBottom, setAtBottom] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);

  /** scrollHeight captured immediately before a prepend lands. */
  const heightBeforePrepend = useRef<number | null>(null);

  const query = useInfiniteQuery({
    queryKey: ['chat', 'messages'],
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (pageParam) qs.set('cursor', pageParam);
      return api<ChatListResponse>(`/v1/chat/messages?${qs.toString()}`);
    },
    // ⚠️ REQUIRED in v5 — see the module note. Not optional, not inferred.
    initialPageParam: '',
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
  });

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = query;

  /**
   * The API returns newest-first per page, and later pages are OLDER. The rendered
   * list is oldest→newest top-to-bottom, so flatten and reverse once here rather than
   * making every consumer think about it.
   */
  const messages = (data?.pages ?? []).flatMap((p) => p.data).slice().reverse();

  // ── The anchor: capture BEFORE, restore AFTER ─────────────────────────────
  const loadOlder = useCallback(() => {
    const el = scrollEl;
    if (!el || !hasNextPage || isFetchingNextPage) return;
    // Captured synchronously, before the request — so it is the height the user is
    // currently looking at, not whatever it becomes mid-flight.
    heightBeforePrepend.current = el.scrollHeight;
    void fetchNextPage();
  }, [scrollEl, fetchNextPage, hasNextPage, isFetchingNextPage]);

  useLayoutEffect(() => {
    const el = scrollEl;
    const before = heightBeforePrepend.current;
    if (!el || before === null) return;

    // Restore the user's position relative to the content they were reading. Without
    // this the viewport jumps to the top of the newly-prepended page on every load.
    const delta = el.scrollHeight - before;
    if (delta > 0) el.scrollTop += delta;
    heightBeforePrepend.current = null;
    // Runs whenever the page count changes — i.e. after a prepend commits.
  }, [scrollEl, data?.pages.length]);

  // ── Top sentinel drives the load ──────────────────────────────────────────
  useEffect(() => {
    const sentinel = sentinelEl;
    const root = scrollEl;
    if (!sentinel || !root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadOlder();
      },
      { root, rootMargin: '120px 0px 0px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [scrollEl, sentinelEl, loadOlder]);

  // ── Track the live edge ───────────────────────────────────────────────────
  const handleScroll = useCallback(() => {
    const el = scrollEl;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distance <= NEAR_BOTTOM_PX;
    setAtBottom(near);
    if (near) setPendingCount(0);
  }, [scrollEl]);

  useEffect(() => {
    const el = scrollEl;
    if (!el) return;
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [scrollEl, handleScroll]);

  const scrollToBottom = useCallback(() => {
    const el = scrollEl;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPendingCount(0);
    setAtBottom(true);
  }, [scrollEl]);

  /**
   * A new message arrived.
   *
   * Pin to the bottom ONLY if the user is already there. Yanking someone away from
   * history they are reading is the second most common chat bug — so when they are
   * scrolled up, the arrival becomes a pill instead.
   */
  const onIncoming = useCallback(() => {
    if (atBottom) {
      // After paint, so the new row is measured in.
      requestAnimationFrame(() => scrollToBottom());
    } else {
      setPendingCount((n) => n + 1);
    }
  }, [atBottom, scrollToBottom]);

  return {
    messages,
    scrollRef: setScrollEl,
    sentinelRef: setSentinelEl,
    scrollEl,
    isPending: query.isPending,
    isError: query.isError,
    isFetchingNextPage,
    hasNextPage: Boolean(hasNextPage),
    atBottom,
    pendingCount,
    scrollToBottom,
    loadOlder,
    onIncoming,
  };
}
