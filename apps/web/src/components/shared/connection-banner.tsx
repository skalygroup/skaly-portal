'use client';

import { AnimatePresence, motion } from 'framer-motion';

import { useConnectionState } from '@/lib/hooks/use-connection-state';

/**
 * The reconnection banner (09-ERROR-HANDLING §5.4).
 *
 * NON-BLOCKING, deliberately: amber, top of viewport, and it never takes pointer
 * events. Read-only use has to continue while disconnected — a modal here would stop
 * someone reading the grid they already have loaded, which is strictly worse than the
 * staleness it warns about.
 *
 * Mounted once in the (portal) layout beside the bell.
 */
export function ConnectionBanner() {
  const state = useConnectionState();
  const visible = state !== 'connected';

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          role="status"
          aria-live="polite"
          data-testid="connection-banner"
          data-state={state}
          initial={{ y: -32, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -32, opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          // pointer-events-none is the non-blocking half — the banner is never in the
          // way of the content it sits over.
          className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center px-4 py-2"
        >
          <span
            className="rounded-full px-3 py-1 text-xs font-medium shadow"
            style={{
              background: 'color-mix(in srgb, var(--status-amber, #f59e0b) 18%, var(--bg-surface, #14161a))',
              color: 'var(--status-amber, #f59e0b)',
              border: '1px solid color-mix(in srgb, var(--status-amber, #f59e0b) 40%, transparent)',
            }}
          >
            {state === 'offline' ? "You're offline — reconnecting when the network returns" : 'Reconnecting…'}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
