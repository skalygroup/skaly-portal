// @vitest-environment node
// The scheduler core is pure (timers + Date only); run in node to sidestep the
// repo's currently-broken jsdom install.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPoller } from './use-polling';

/**
 * Unit tests for the polling scheduler core. Fake timers let us assert the
 * exact delay sequence, the stop conditions, and pause/resume without React.
 */
describe('createPoller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const DELAYS = [10_000, 30_000, 60_000];

  it('respects the ramping delay sequence and repeats the last delay', async () => {
    const fetcher = vi.fn().mockResolvedValue('pending');
    const poller = createPoller<string>({
      fetcher,
      delays: DELAYS,
      shouldStop: (d) => d === 'approved',
      maxDuration: 10 * 60 * 1000,
      onData: () => {},
    });
    poller.start();

    // Nothing fires before the first delay.
    expect(fetcher).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetcher).toHaveBeenCalledTimes(0);

    // 10s → first poll.
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // +30s → second poll.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // +60s → third poll.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(3);

    // Last delay repeats: another +60s → fourth poll.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(4);

    poller.stop();
  });

  it('stops when shouldStop returns true', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce('pending')
      .mockResolvedValueOnce('approved')
      .mockResolvedValue('approved');
    const onStop = vi.fn();
    const poller = createPoller<string>({
      fetcher,
      delays: DELAYS,
      shouldStop: (d) => d === 'approved',
      maxDuration: 10 * 60 * 1000,
      onData: () => {},
      onStop,
    });
    poller.start();

    await vi.advanceTimersByTimeAsync(10_000); // pending
    await vi.advanceTimersByTimeAsync(30_000); // approved → stop
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(poller.isStopped).toBe(true);

    // No further polls after stop.
    await vi.advanceTimersByTimeAsync(60_000 * 5);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stops once maxDuration elapses', async () => {
    const fetcher = vi.fn().mockResolvedValue('pending');
    const onStop = vi.fn();
    // Cap at 50s with a 10s steady cadence → polls at 10,20,30,40,50 then stops.
    const poller = createPoller<string>({
      fetcher,
      delays: [10_000],
      shouldStop: () => false,
      maxDuration: 50_000,
      onData: () => {},
      onStop,
    });
    poller.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(poller.isStopped).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('pause halts polling; resume polls immediately then continues', async () => {
    const fetcher = vi.fn().mockResolvedValue('pending');
    const poller = createPoller<string>({
      fetcher,
      delays: DELAYS,
      shouldStop: () => false,
      maxDuration: 10 * 60 * 1000,
      onData: () => {},
    });
    poller.start();

    await vi.advanceTimersByTimeAsync(10_000); // first poll
    expect(fetcher).toHaveBeenCalledTimes(1);

    poller.pause();
    await vi.advanceTimersByTimeAsync(60_000 * 3); // no polls while paused
    expect(fetcher).toHaveBeenCalledTimes(1);

    poller.resume(); // immediate poll
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Cadence continues after resume.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(3);

    poller.stop();
  });

  it('keeps polling after a transient fetch error', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue('pending');
    const onError = vi.fn();
    const poller = createPoller<string>({
      fetcher,
      delays: DELAYS,
      shouldStop: () => false,
      maxDuration: 10 * 60 * 1000,
      onData: () => {},
      onError,
    });
    poller.start();

    await vi.advanceTimersByTimeAsync(10_000); // throws
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000); // recovers, keeps going
    expect(fetcher).toHaveBeenCalledTimes(2);

    poller.stop();
  });
});
