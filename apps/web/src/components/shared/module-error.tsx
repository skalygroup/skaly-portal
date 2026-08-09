'use client';

import { useEffect } from 'react';

import { ApiError } from '@/lib/api';
import { captureError, initSentry } from '@/lib/observability';

/**
 * The module error boundary body (09-ERROR-HANDLING §5.2).
 *
 * ⚠️ THE ISOLATION IS NEXT'S, NOT OURS. A React error boundary is a class
 * component with componentDidCatch — and the App Router already ships one per
 * route segment: an `error.tsx` in a segment wraps that segment's subtree and
 * nothing else. So each module gets its own boundary by placing a four-line
 * `error.tsx` beside its page, and a thrown error in Tasks provably cannot take
 * Attendance down, because they are different segments of the same tree.
 *
 * Writing our own boundary class would have re-implemented that, and would have
 * had to be threaded manually through every module to get the same isolation the
 * file system gives for free.
 *
 * This component is only the BODY — the shared §5.2 presentation. The boundary
 * itself is the file that renders it.
 */
export interface ModuleErrorProps {
  /** Module name, as a person says it: "Attendance", "Shoot Planner". */
  module: string;
  error: Error & { digest?: string };
  /** Next's boundary reset — re-renders the segment, which refetches the query. */
  reset: () => void;
}

export function ModuleError({ module, error, reset }: ModuleErrorProps) {
  // Report ADDITIVELY (H-07): a no-op without NEXT_PUBLIC_SENTRY_DSN, and the
  // boundary renders and isolates identically either way. Initialised here rather
  // than in the root layout because this is the only place the web SDK is used —
  // a boundary that never fires costs nothing, and a layout-level init would run
  // the SDK on every page load to catch errors this component already has.
  useEffect(() => {
    initSentry();
    captureError(error, { module });
  }, [error, module]);

  // §5.2 wants the traceId from the API envelope's error.details. It is only there
  // when the failure came from the API at all; a render-time TypeError has none, and
  // Next's own `digest` is the closest equivalent for those.
  const traceId =
    (error instanceof ApiError && typeof error.details?.traceId === 'string'
      ? error.details.traceId
      : undefined) ?? error.digest;

  return (
    <div
      role="alert"
      data-testid="module-error"
      data-module={module}
      className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center"
    >
      {/* The Skaly mark at 48px, white/30 (§5.2). Inline rather than an <img>: the
          boundary must render even when the failure is the network. */}
      <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden className="opacity-30">
        <path
          d="M24 4 L44 24 L24 44 L4 24 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinejoin="round"
        />
      </svg>

      <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary, #e8eaed)' }}>
        Something went wrong loading {module}
      </h2>
      <p className="text-sm" style={{ color: 'var(--text-secondary, #9aa3ad)' }}>
        This may be a temporary issue.
      </p>

      <button
        type="button"
        onClick={reset}
        data-testid="module-error-retry"
        className="mt-1 rounded px-4 py-2 text-sm font-medium"
        style={{ background: 'var(--accent-gold)', color: 'var(--bg-base, #0b0d10)' }}
      >
        Try again
      </button>

      {traceId && (
        <p
          className="mt-4 text-[11px]"
          style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted, #6b7280)' }}
        >
          {traceId}
        </p>
      )}
    </div>
  );
}
