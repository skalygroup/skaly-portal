'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/**
 * MonthContext (UIUX §6.1): the viewed period lives in the `?period=YYYY-MM`
 * URL param — bookmarkable, browser-back friendly, and every module query
 * re-keys off it. No store needed; the URL IS the state.
 *
 * Falls back to the current IST month, computed the same way the backend does
 * (BaseService.currentIstPeriod): Intl with the Asia/Kolkata zone, so client
 * and server always agree on "this month" regardless of the viewer's TZ.
 *
 * NOTE: useSearchParams requires a <Suspense> boundary in the page (Next 15).
 */

/** The current IST month as 'YYYY-MM' (en-CA formats exactly so). */
export function currentIstPeriod(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  }).format(now);
}

/**
 * Today as 'YYYY-MM-DD' in IST — the upper bound for any "not in the future"
 * date field.
 *
 * ⚠️ CALL THIS PER RENDER. NEVER `const today = …` AT MODULE SCOPE.
 *
 * It replaced `new Date().toISOString().slice(0, 10)`, which was wrong twice
 * over and shipped in all three signup forms:
 *
 *   1. `toISOString()` is UTC. Between 00:00 and 05:30 IST it returns
 *      YESTERDAY, so `max` sat a day behind the date picker — which compares in
 *      LOCAL time — and the picker's [Today] button silently did nothing. Not
 *      "showed an error": its guard is `if (t <= maxDate) pick(t)`, so a failed
 *      comparison skips the pick AND the close, leaving the click-outside
 *      overlay covering the form. The next field became unclickable.
 *   2. At module scope it is evaluated ONCE, when the module first loads. A
 *      production `next start` server that has been up since yesterday serves a
 *      `today` frozen at yesterday — so the same dead button appears at every
 *      midnight rollover and never clears until a redeploy.
 *
 * Caught by tests\auth\signup.ui.spec.ts, which passed at 19:30 and failed at
 * 00:52 against a byte-identical build.
 */
export function currentIstDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const PERIOD_RE = /^\d{4}-\d{2}$/;

export function useMonthContext(): { period: string; setPeriod: (period: string) => void } {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const raw = searchParams.get('period');
  const period = raw && PERIOD_RE.test(raw) ? raw : currentIstPeriod();

  const setPeriod = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('period', next);
      router.push(`${pathname}?${params.toString()}`);
    },
    [searchParams, pathname, router],
  );

  return { period, setPeriod };
}
