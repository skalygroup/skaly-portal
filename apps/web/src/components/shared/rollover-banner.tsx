'use client';

import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

import { useNotifySocket } from '@/lib/socket';

/**
 * The rollover-window banner (NFR §3.1, Sprint 13 STEP 7).
 *
 * NFR §3.1's requirement is that the API stays FULLY OPERATIONAL during
 * 00:01–00:05 IST — which Tier 2's `CONCURRENTLY` refresh is what actually
 * delivers. So this banner is informational only, and shaped exactly like
 * ConnectionBanner: amber, top of viewport, `pointer-events-none`. It must never
 * become a read-only gate, because there is nothing to gate — a night-owl user
 * mid-edit at 00:02 is doing something the system fully supports.
 *
 * It clears on `month_ready`, which rides the same self-heal as every other
 * real-time state (ADR-022): the socket is the fast path and the clock is the
 * fallback, so a user who was asleep through the window never sees it and a user
 * whose socket dropped still loses it at 00:05.
 */
const START_MINUTE = 1; // 00:01 IST — the cron's fire time
const END_MINUTE = 5; // 00:05 IST — NFR §3.1's stated window

/** Minutes past IST midnight, computed via Intl so it is right in any host TZ. */
function istMinutesPastMidnight(now: Date = new Date()): number {
  const [h = 0, m = 0] = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(now)
    .split(':')
    .map(Number);
  return h * 60 + m;
}

export function inRolloverWindow(now: Date = new Date()): boolean {
  const minutes = istMinutesPastMidnight(now);
  return minutes >= START_MINUTE && minutes < END_MINUTE;
}

interface NotifyNewPayload {
  type: string;
}

export function RolloverBanner() {
  const [inWindow, setInWindow] = useState(() => inRolloverWindow());
  // Latched separately from the clock: month_ready means the rollover is DONE, and
  // re-deriving from the clock a second later would bring the banner back for the
  // remaining minutes of a window whose work has finished.
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // A 30s tick, not a 1s one: the banner's edges are minute boundaries, so a
    // sub-minute cadence buys nothing but wakeups on an idle tab.
    const id = setInterval(() => {
      const next = inRolloverWindow();
      setInWindow(next);
      if (!next) setDismissed(false); // re-arm for the next night
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  useNotifySocket<NotifyNewPayload>('notify:new', (payload) => {
    // ⚠️ A TYPE IS NOT AN EVENT (lib/socket.ts). `month_ready` arrives as the
    // `type` of a notify:new row — subscribing to 'month_ready' would register a
    // handler for something the server never sends.
    if (payload?.type === 'month_ready') setDismissed(true);
  });

  if (!inWindow || dismissed) return null;

  // Entrance animation only — deliberately NO AnimatePresence, unlike
  // ConnectionBanner. An exit animation keeps the node mounted for its duration,
  // and the thing this banner exits on is `month_ready`: the moment the new month
  // is ready, a banner still saying "preparing the new month" is wrong, not
  // tastefully fading. It also makes the disappearance assertable without faking a
  // clock that framer's own animation loop reads.
  return (
    <motion.div
      role="status"
      aria-live="polite"
      data-testid="rollover-banner"
      initial={{ y: -32, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="pointer-events-none fixed inset-x-0 top-0 z-[59] flex justify-center px-4 py-2"
    >
      <span
        className="rounded-full px-3 py-1 text-xs font-medium shadow"
        style={{
          background: 'color-mix(in srgb, var(--status-amber, #f59e0b) 18%, var(--bg-surface, #14161a))',
          color: 'var(--status-amber, #f59e0b)',
          border: '1px solid color-mix(in srgb, var(--status-amber, #f59e0b) 40%, transparent)',
        }}
      >
        Preparing the new month — some data may update momentarily.
      </span>
    </motion.div>
  );
}
