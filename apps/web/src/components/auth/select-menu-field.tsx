'use client';

import { Check, ChevronDown } from 'lucide-react';
import * as React from 'react';

import { FieldShell } from './form-controls';

import { cn } from '@/lib/utils';


/**
 * On-brand select (signup redesign) — a styled dropdown menu instead of a
 * native <select>, so the open list matches the dark/gold theme. Controlled.
 */
interface SelectOption {
  value: string;
  label: string;
}

interface SelectMenuFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  error?: string;
  hint?: string;
  disabled?: boolean;
  id?: string;
}

export function SelectMenuField({
  label,
  value,
  onChange,
  options,
  error,
  hint,
  disabled,
  id = 'select',
}: SelectMenuFieldProps) {
  const [open, setOpen] = React.useState(false);
  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <FieldShell id={id} label={label} error={error} hint={hint}>
      <div className="relative">
        <button
          type="button"
          id={id}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          suppressHydrationWarning
          className={cn(
            'flex h-[46px] w-full items-center gap-2.5 rounded-md border bg-bg-elevated px-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60',
            error
              ? 'border-status-red/70'
              : 'border-border-default hover:border-border-strong focus-visible:border-accent-gold',
          )}
        >
          <span className="flex-1 text-text-primary">{current?.label}</span>
          <ChevronDown
            size={16}
            className={cn('shrink-0 text-text-muted transition-transform', open && 'rotate-180')}
            aria-hidden
          />
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
            <div
              role="listbox"
              className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 flex animate-[skPop_0.14s_ease_both] flex-col gap-0.5 rounded-xl border border-border-default bg-bg-elevated p-1.5 shadow-[0_18px_42px_-14px_rgba(0,0,0,0.78)]"
            >
              {options.map((opt) => {
                const isSelected = opt.value === value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    className="flex h-10 w-full items-center justify-between gap-2 rounded-lg px-3 text-left text-sm text-text-primary hover:bg-bg-hover"
                  >
                    <span>{opt.label}</span>
                    {isSelected && <Check size={15} className="text-accent-gold" aria-hidden />}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </FieldShell>
  );
}
