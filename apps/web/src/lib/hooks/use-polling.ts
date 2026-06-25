'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Variable-interval poller used by the /signup/pending page (APPFLOW §2.6).
 *
 * The cadence ramps — e.g. 10s → 30s → 60s → 60s… — instead of a fixed
 * interval, so we check often right after submit and back off as the wait
 * drags on. That's why this is a chain of `setTimeout`s (each delay can differ)
 * and never `setInterval`. Polling halts when `shouldStop(data)` is true
 * (approved/rejected), when `maxDuration` elapses (default 10min), or when
 * `stop()` is called.
 *
 * The scheduling core is extracted as {@link createPoller} so the cadence,
 * stop conditions, and pause/resume are unit-testable with fake timers — no
 * React, no DOM. The hook is a thin wrapper that wires it to component state
 * and to tab-visibility (poll only while the tab is visible — APPFLOW §2.6).
 */

export interface Poller {
  /** Begin polling from the first delay. */
  start(): void;
  /** Stop permanently; cancels any pending timer. Idempotent. */
  stop(): void;
  /** Suspend polling (tab hidden); keeps state so resume can continue. */
  pause(): void;
  /** Resume after a pause with an immediate poll, then continue the cadence. */
  resume(): void;
  readonly isStopped: boolean;
}

interface PollerOptions<T> {
  fetcher: () => Promise<T>;
  delays: number[];
  shouldStop: (data: T) => boolean;
  maxDuration: number;
  onData: (data: T) => void;
  onError?: (err: unknown) => void;
  onStop?: () => void;
}

/**
 * Pure scheduler. No React/DOM — drives a `fetcher` on a ramping delay
 * sequence and reports results via callbacks. The last entry in `delays`
 * repeats once the sequence is exhausted (steady-state cadence).
 */
export function createPoller<T>(opts: PollerOptions<T>): Poller {
  const { fetcher, delays, shouldStop, maxDuration, onData, onError, onStop } = opts;
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let paused = false;
  let startedAt = 0;

  // Steady-state once the ramp is exhausted: repeat the final delay.
  const delayFor = (i: number) => delays[Math.min(i, delays.length - 1)] ?? maxDuration;
  const elapsed = () => Date.now() - startedAt >= maxDuration;

  function clearPending() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearPending();
    onStop?.();
  }

  function schedule() {
    clearPending();
    if (stopped || paused) return;
    timer = setTimeout(run, delayFor(index));
  }

  async function run() {
    timer = null;
    if (stopped || paused) return;
    try {
      const data = await fetcher();
      // The poll may have been stopped/paused while the request was in flight.
      if (stopped || paused) return;
      onData(data);
      if (shouldStop(data)) return stop();
    } catch (err) {
      onError?.(err);
      // A transient failure shouldn't kill the poll — fall through and retry.
      if (stopped || paused) return;
    }
    index += 1;
    if (elapsed()) return stop();
    schedule();
  }

  return {
    start() {
      startedAt = Date.now();
      stopped = false;
      paused = false;
      index = 0;
      schedule();
    },
    stop,
    pause() {
      if (paused || stopped) return;
      paused = true;
      clearPending();
    },
    resume() {
      if (!paused || stopped) return;
      paused = false;
      // Poll immediately on return so the user sees fresh status right away,
      // then the cadence continues from the current delay.
      void run();
    },
    get isStopped() {
      return stopped;
    },
  };
}

export interface UsePollingResult<T> {
  data: T | null;
  isPolling: boolean;
  stop: () => void;
}

export function usePolling<T>(
  fetcher: () => Promise<T>,
  delays: number[],
  shouldStop: (data: T) => boolean,
  maxDuration: number = 10 * 60 * 1000,
): UsePollingResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [isPolling, setIsPolling] = useState(true);

  // The caller passes fresh closures each render; keep them in refs so the
  // poller (created once) always calls the latest without restarting.
  const fetcherRef = useRef(fetcher);
  const shouldStopRef = useRef(shouldStop);
  fetcherRef.current = fetcher;
  shouldStopRef.current = shouldStop;

  const pollerRef = useRef<Poller | null>(null);

  // Snapshot cadence config once — it's constant in every call site.
  const delaysRef = useRef(delays);
  const maxRef = useRef(maxDuration);

  useEffect(() => {
    const poller = createPoller<T>({
      fetcher: () => fetcherRef.current(),
      delays: delaysRef.current,
      shouldStop: (d) => shouldStopRef.current(d),
      maxDuration: maxRef.current,
      onData: setData,
      onStop: () => setIsPolling(false),
    });
    pollerRef.current = poller;
    // Reset to true on (re)start — StrictMode's dev double-invoke runs the
    // cleanup (which flips this false) before the second start.
    setIsPolling(true);
    poller.start();

    const onVisibility = () => {
      if (document.visibilityState === 'visible') poller.resume();
      else poller.pause();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // If the tab is already hidden on mount, don't poll until it's shown.
    if (document.visibilityState !== 'visible') poller.pause();

    return () => {
      poller.stop();
      document.removeEventListener('visibilitychange', onVisibility);
      pollerRef.current = null;
    };
    // Intentionally run once; live values flow through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = useCallback(() => {
    pollerRef.current?.stop();
    setIsPolling(false);
  }, []);

  return { data, isPolling, stop };
}
