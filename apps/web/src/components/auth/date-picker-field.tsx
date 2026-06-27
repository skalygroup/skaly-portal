'use client';

import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import * as React from 'react';

import { FieldShell } from './form-controls';

import { cn } from '@/lib/utils';


/**
 * On-brand calendar date picker (signup redesign). Controlled: `value` is the
 * canonical `YYYY-MM-DD` string the form/schema expects (or '' for empty);
 * the trigger displays `dd-mm-yyyy`. The month/year header toggles a scrollable
 * year picker (current year back ~110 years) so a birth year is one tap away
 * instead of paging month-by-month. Optional `max` (YYYY-MM-DD) disables later
 * days — used to block future dates of birth.
 */

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const YEAR_SPAN = 110;
const pad = (n: number) => String(n).padStart(2, '0');
const toYMD = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYMD = (s: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
};
const sameDay = (a: Date | null, b: Date | null) =>
  !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

interface DatePickerFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  disabled?: boolean;
  /** Latest selectable day (YYYY-MM-DD); later days are disabled. */
  max?: string;
  id?: string;
}

export function DatePickerField({
  label,
  value,
  onChange,
  error,
  hint,
  disabled,
  max,
  id = 'date',
}: DatePickerFieldProps) {
  const selected = parseYMD(value);
  const maxDate = max ? parseYMD(max) : null;
  const [open, setOpen] = React.useState(false);
  const [yearView, setYearView] = React.useState(false);
  const initial = selected ?? new Date();
  const [viewY, setViewY] = React.useState(initial.getFullYear());
  const [viewM, setViewM] = React.useState(initial.getMonth());

  // Re-centre the calendar on the selected month (and reset to day view)
  // whenever it opens.
  React.useEffect(() => {
    if (open) {
      const base = parseYMD(value) ?? new Date();
      setViewY(base.getFullYear());
      setViewM(base.getMonth());
      setYearView(false);
    }
  }, [open, value]);

  const close = () => {
    setOpen(false);
    setYearView(false);
  };

  const display = selected
    ? `${pad(selected.getDate())}-${pad(selected.getMonth() + 1)}-${selected.getFullYear()}`
    : '';

  const prevMonth = () =>
    setViewM((m) => {
      if (m === 0) {
        setViewY((y) => y - 1);
        return 11;
      }
      return m - 1;
    });
  const nextMonth = () =>
    setViewM((m) => {
      if (m === 11) {
        setViewY((y) => y + 1);
        return 0;
      }
      return m + 1;
    });

  const pick = (d: Date) => {
    onChange(toYMD(d));
    close();
  };

  const today = new Date();
  const monthLabel =
    new Date(viewY, viewM, 1).toLocaleString('en-US', { month: 'long' }) + `, ${viewY}`;

  const first = new Date(viewY, viewM, 1);
  const start = new Date(viewY, viewM, 1 - first.getDay());
  const days: React.ReactNode[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const inMonth = d.getMonth() === viewM;
    const isSelected = sameDay(d, selected);
    const isToday = sameDay(d, today);
    const isDisabled = !!maxDate && d.getTime() > maxDate.getTime();
    days.push(
      <button
        key={i}
        type="button"
        disabled={isDisabled}
        onClick={() => pick(d)}
        className={cn(
          'flex h-[34px] items-center justify-center rounded-lg text-[13px] transition-colors',
          isDisabled && 'cursor-not-allowed opacity-30',
          isSelected
            ? 'bg-accent-gold font-bold text-bg-base'
            : cn(
                inMonth ? 'text-text-primary' : 'text-text-disabled',
                !isDisabled && 'hover:bg-bg-hover',
                isToday && 'border border-accent-gold/55',
              ),
        )}
      >
        {d.getDate()}
      </button>,
    );
  }

  // Year grid — most recent year first, ~110 years back (date-of-birth range).
  const thisYear = today.getFullYear();
  const years: React.ReactNode[] = [];
  for (let y = thisYear; y >= thisYear - YEAR_SPAN; y--) {
    const isSelected = y === viewY;
    years.push(
      <button
        key={y}
        type="button"
        onClick={() => {
          setViewY(y);
          setYearView(false);
        }}
        className={cn(
          'flex h-[38px] items-center justify-center rounded-lg border text-[13.5px] transition-colors',
          isSelected
            ? 'border-transparent bg-accent-gold font-bold text-bg-base'
            : 'border-border-subtle text-text-primary hover:border-border-default hover:bg-bg-hover',
        )}
      >
        {y}
      </button>,
    );
  }

  return (
    <FieldShell id={id} label={label} error={error} hint={hint}>
      <div className="relative">
        <button
          type="button"
          id={id}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={open}
          suppressHydrationWarning
          className={cn(
            'flex h-[46px] w-full items-center gap-2.5 rounded-md border bg-bg-elevated px-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60',
            error
              ? 'border-status-red/70'
              : 'border-border-default hover:border-border-strong focus-visible:border-accent-gold',
          )}
        >
          <Calendar size={16} className="shrink-0 text-text-muted" aria-hidden />
          <span className={cn('flex-1', display ? 'text-text-primary' : 'text-text-muted')}>
            {display || 'dd-mm-yyyy'}
          </span>
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={close} aria-hidden />
            <div
              role="dialog"
              className="absolute left-0 top-[calc(100%+8px)] z-50 w-[296px] max-w-[84vw] animate-[skPop_0.14s_ease_both] rounded-2xl border border-border-default bg-bg-elevated p-3.5 shadow-[0_22px_50px_-16px_rgba(0,0,0,0.8)]"
            >
              <div className="mb-3 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setYearView((v) => !v)}
                  className="-ml-2 flex items-center gap-1.5 rounded-lg px-2 py-1 font-[family-name:var(--font-display)] text-base font-bold text-text-primary hover:bg-bg-hover"
                >
                  <span>{monthLabel}</span>
                  <ChevronDown
                    size={14}
                    className={cn('text-accent-gold transition-transform', yearView && 'rotate-180')}
                    aria-hidden
                  />
                </button>
                <span className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => !yearView && prevMonth()}
                    aria-label="Previous month"
                    className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-border-subtle text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
                    disabled={yearView}
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => !yearView && nextMonth()}
                    aria-label="Next month"
                    className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-border-subtle text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
                    disabled={yearView}
                  >
                    <ChevronRight size={15} />
                  </button>
                </span>
              </div>

              {yearView ? (
                <div className="sk-page grid max-h-[236px] grid-cols-4 gap-1.5 overflow-y-auto pr-1">
                  {years}
                </div>
              ) : (
                <>
                  <div className="mb-1 grid grid-cols-7 gap-0.5">
                    {WEEKDAYS.map((wd) => (
                      <span
                        key={wd}
                        className="py-1 text-center font-[family-name:var(--font-mono)] text-[10.5px] text-text-muted"
                      >
                        {wd}
                      </span>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-0.5">{days}</div>
                </>
              )}

              <div className="mt-3 flex items-center justify-between border-t border-border-subtle pt-2.5">
                <button
                  type="button"
                  onClick={() => onChange('')}
                  className="text-[13px] font-medium text-text-secondary hover:text-text-primary"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const t = new Date();
                    t.setHours(0, 0, 0, 0);
                    if (!maxDate || t.getTime() <= maxDate.getTime()) pick(t);
                  }}
                  className="text-[13px] font-semibold text-accent-gold hover:text-accent-gold-hover"
                >
                  Today
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </FieldShell>
  );
}
