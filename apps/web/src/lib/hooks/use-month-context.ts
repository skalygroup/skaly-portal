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
