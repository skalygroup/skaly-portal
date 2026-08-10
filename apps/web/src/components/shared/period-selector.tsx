'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Lock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';
import { currentIstPeriod, useMonthContext } from '@/lib/hooks/use-month-context';

/**
 * The period selector (UIUX §6.1) — top of the sidebar, below the logo.
 *
 * The URL is the state: `setPeriod` pushes `?period=YYYY-MM`, MonthContext reads
 * it back, and every module query re-keys off it. Nothing is stored here, which
 * is what makes a period bookmarkable and the browser's back button correct.
 *
 * ⚠️ THE LIST IS A 12-MONTH WINDOW ENDING AT THE CURRENT MONTH, not "the last 12
 * rows". `months` accumulates fixture rows in both directions — 2090-06 and
 * 2094-07 ahead (this repo's own rollover tests), 2000-09 and 2001-01 behind
 * (Sprint 5's) — and either offers a month with no data behind it, so choosing
 * one lands on an empty grid that looks like data loss. A row-count cap does not
 * help: sorted newest-first it just fills the tail with the ancient ones.
 * A year of history is a picker; three years is a filing cabinet.
 */
const HISTORY_MONTHS = 12;

/** 'YYYY-MM' shifted by `delta` months. */
function shiftPeriod(period: string, delta: number): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 'June 2026' from '2026-06'.
 *
 * A fallback, not the source: `months.label` is authoritative and the rollover
 * writes a proper one. But test fixtures across this repo insert `label: period`,
 * so a dev database is full of rows labelled "2026-08" — deriving when the label
 * is indistinguishable from the period keeps the picker readable without
 * pretending the column does not exist.
 */
function humanLabel(period: string, label: string): string {
  if (label !== period) return label;
  const [y, m] = [Number(period.slice(0, 4)), Number(period.slice(5, 7))];
  const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  });
  return `${name} ${y}`;
}

interface MonthItem {
  period: string;
  label: string;
  locked: boolean;
}

export function PeriodSelector() {
  const { period, setPeriod } = useMonthContext();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const current = currentIstPeriod();

  const { data: months = [] } = useQuery({
    queryKey: ['months'],
    queryFn: async () => (await api<{ data: MonthItem[] }>('/v1/months')).data,
    // The list changes once a month, at rollover. Refetching it per navigation
    // would be a request on every page for a value that is stable for weeks.
    staleTime: 5 * 60_000,
  });

  const earliest = shiftPeriod(current, -(HISTORY_MONTHS - 1));
  const selectable = months
    .filter((m) => m.period <= current && m.period >= earliest)
    .sort((a, b) => b.period.localeCompare(a.period));

  const viewing = selectable.find((m) => m.period === period);
  // Fall back to the period itself rather than "—": a period in the URL but
  // outside the window is a real state (a bookmark, a fixture month), and showing
  // it is how someone works out what they are looking at.
  const label = viewing ? humanLabel(viewing.period, viewing.label) : period;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={boxRef} className="relative mb-3 px-2 xl:px-4" data-testid="period-selector">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Period: ${label}. Change period`}
        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors"
        style={{ background: 'var(--bg-elevated, #1a1d23)' }}
      >
        <span
          className="truncate text-[13px]"
          style={{
            // Gold + DM Mono for the CURRENT month (§6.1); a past month is grey,
            // so the colour itself tells you that you are not looking at now.
            fontFamily: 'var(--font-mono)',
            color: period === current ? 'var(--accent-gold)' : 'var(--text-secondary)',
          }}
        >
          {/* At 56px there is no room for "August 2026" — the period reads fine. */}
          <span className="xl:hidden">{period.slice(2)}</span>
          <span className="hidden xl:inline">{label}</span>
        </span>
        <ChevronDown
          size={14}
          aria-hidden
          className="hidden shrink-0 transition-transform xl:block"
          style={{
            color: 'var(--text-muted)',
            transform: open ? 'rotate(180deg)' : undefined,
          }}
        />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label="Select period"
          className="absolute left-2 right-2 z-50 mt-1 max-h-64 overflow-y-auto rounded-md border py-1 shadow-xl xl:left-4 xl:right-4"
          style={{
            background: 'var(--bg-surface, #14161a)',
            borderColor: 'var(--border-subtle, #262b33)',
          }}
        >
          {selectable.length === 0 && (
            <li className="px-3 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              No periods yet
            </li>
          )}
          {selectable.map((m) => {
            const active = m.period === period;
            return (
              <li key={m.period}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    setPeriod(m.period);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] transition-colors"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    color: active
                      ? 'var(--accent-gold)'
                      : m.period === current
                        ? 'var(--text-primary)'
                        : 'var(--text-secondary)',
                    background: active ? 'var(--accent-gold-dim)' : undefined,
                  }}
                >
                  <span className="truncate">{humanLabel(m.period, m.label)}</span>
                  {/* A locked month is read-only everywhere; saying so HERE stops
                      the trip to a grid whose cells silently refuse to edit. */}
                  {m.locked && <Lock size={12} aria-label="Locked" style={{ color: 'var(--text-muted)' }} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * "You are viewing a past month" (§6.1) — a gold bar with a way back.
 *
 * Separate from the selector because it belongs to the CONTENT column, not the
 * sidebar: it has to sit over whatever grid is showing stale-looking data, and
 * the whole point is that it is impossible to miss while you wonder why today's
 * row is absent.
 */
export function PastPeriodBanner() {
  const { period, setPeriod } = useMonthContext();
  const current = currentIstPeriod();
  if (period >= current) return null;

  return (
    <div
      data-testid="past-period-banner"
      className="flex items-center justify-center gap-3 px-4 py-1.5 text-xs"
      style={{
        background: 'color-mix(in srgb, var(--accent-gold) 12%, transparent)',
        borderBottom: '1px solid color-mix(in srgb, var(--accent-gold) 30%, transparent)',
        color: 'var(--accent-gold)',
      }}
    >
      <span style={{ fontFamily: 'var(--font-mono)' }}>Viewing {period}</span>
      <button
        type="button"
        onClick={() => setPeriod(current)}
        className="underline underline-offset-2"
        style={{ color: 'var(--accent-gold)' }}
      >
        Back to current
      </button>
    </div>
  );
}
