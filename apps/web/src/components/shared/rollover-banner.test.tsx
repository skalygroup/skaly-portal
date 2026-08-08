import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { RolloverBanner, inRolloverWindow } from './rollover-banner';

/**
 * The rollover-window banner (NFR §3.1, Sprint 13 STEP 7).
 *
 * The clock is faked rather than the helper mocked: the whole risk in this
 * component is timezone arithmetic — a banner keyed off the HOST's midnight shows
 * up at 00:01 local time for a user in London and never at 00:01 IST, which is
 * exactly when it is supposed to appear.
 */
const sockets = vi.hoisted(() => ({ handlers: new Map<string, (p: unknown) => void>() }));

vi.mock('@/lib/socket', () => ({
  WS_NOTIFY: '/ws/notify',
  useNotifySocket: (event: string, handler: (p: unknown) => void) => {
    sockets.handlers.set(event, handler);
  },
}));

/** 2026-09-01 00:02 IST = 2026-08-31 18:32 UTC. */
const INSIDE_WINDOW = new Date('2026-08-31T18:32:00Z');
/** 2026-09-01 00:07 IST — five minutes later, past NFR §3.1's window. */
const AFTER_WINDOW = new Date('2026-08-31T18:37:00Z');
/** 2026-09-01 12:00 IST — an ordinary afternoon. */
const MIDDAY = new Date('2026-09-01T06:30:00Z');

async function emit(event: string, payload: unknown) {
  const handler = sockets.handlers.get(event);
  if (!handler) throw new Error(`the banner never subscribed to "${event}"`);
  await act(async () => {
    handler(payload);
  });
}

beforeEach(() => {
  sockets.handlers.clear();
  // Date and setInterval ONLY. setTimeout stays real, because waitFor polls on it —
  // faking it deadlocks every disappearance assertion, and framer-motion's exit
  // animation needs real ticks to unmount the node at all.
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('the window is computed in IST, not in the host timezone', () => {
  test('00:02 IST is inside; 00:07 IST and midday are not', () => {
    expect(inRolloverWindow(INSIDE_WINDOW)).toBe(true);
    expect(inRolloverWindow(AFTER_WINDOW)).toBe(false);
    expect(inRolloverWindow(MIDDAY)).toBe(false);
  });

  test('00:00 IST — the minute BEFORE the cron fires — is outside', () => {
    // The window opens at 00:01 because that is when `31 18 * * *` fires. A banner
    // at 00:00 would be claiming work that has not started.
    expect(inRolloverWindow(new Date('2026-08-31T18:30:00Z'))).toBe(false);
  });
});

describe('the banner', () => {
  test('is absent outside the window', () => {
    vi.setSystemTime(MIDDAY);
    render(<RolloverBanner />);
    expect(screen.queryByTestId('rollover-banner')).toBeNull();
  });

  test('appears during the window, and never blocks the page', () => {
    vi.setSystemTime(INSIDE_WINDOW);
    render(<RolloverBanner />);

    const banner = screen.getByTestId('rollover-banner');
    expect(banner.textContent).toContain('Preparing the new month');
    // NFR §3.1 says the API stays FULLY OPERATIONAL through the window, so this is
    // informational. pointer-events-none is what keeps it from becoming a gate.
    expect(banner.className).toContain('pointer-events-none');
  });

  test('⭐ clears when month_ready arrives, without waiting for the clock', async () => {
    vi.setSystemTime(INSIDE_WINDOW);
    render(<RolloverBanner />);
    expect(screen.getByTestId('rollover-banner')).not.toBeNull();

    // A TYPE over notify:new — not a `month_ready` event, which the server never
    // emits (the invariant pinned on useNotifySocket).
    await emit('notify:new', {
      id: 'mr-1',
      type: 'month_ready',
      title: 'September 2026 is ready',
      payload: { period: '2026-09' },
    });

    // waitFor polls on the REAL setTimeout (see beforeEach) and gives framer-motion
    // the ticks its exit animation needs before the node actually leaves the DOM.
    await waitFor(() => expect(screen.queryByTestId('rollover-banner')).toBeNull());
  });

  test('an unrelated notification does not clear it', async () => {
    vi.setSystemTime(INSIDE_WINDOW);
    render(<RolloverBanner />);

    await emit('notify:new', { id: 't-1', type: 'task_assigned', payload: {} });

    expect(screen.getByTestId('rollover-banner')).not.toBeNull();
  });

  test('clears on its own once the window closes, if month_ready never arrived', async () => {
    vi.setSystemTime(INSIDE_WINDOW);
    render(<RolloverBanner />);
    expect(screen.getByTestId('rollover-banner')).not.toBeNull();

    // The clock is the fallback half of the self-heal (ADR-022): a user whose
    // socket dropped at 00:01 must still lose the banner.
    vi.setSystemTime(AFTER_WINDOW);
    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });

    // waitFor polls on the REAL setTimeout (see beforeEach) and gives framer-motion
    // the ticks its exit animation needs before the node actually leaves the DOM.
    await waitFor(() => expect(screen.queryByTestId('rollover-banner')).toBeNull());
  });
});
