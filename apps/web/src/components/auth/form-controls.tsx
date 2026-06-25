'use client';

import * as React from 'react';
import Image from 'next/image';
import { AlertCircle, ChevronDown, Eye, EyeOff, Loader2, Lock, Paperclip, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Shared auth form controls — the dark / gold-focus aesthetic of the login
 * redesign (APPFLOW §2), extracted so the signup, invite, and OAuth-complete
 * forms stay visually identical without copy-pasting class strings.
 *
 * Text fields forward their ref so they drop straight into react-hook-form via
 * `{...register('field')}`. The file field is controlled (uploads bypass RHF and
 * go into a FormData builder), so it takes `value`/`onChange` instead.
 */

const wrapBase =
  'relative flex h-[46px] items-center gap-2.5 rounded-md border bg-bg-elevated px-3 transition-colors';
const wrapIdle = 'border-border-default focus-within:border-accent-gold focus-within:shadow-[0_0_0_3px_var(--accent-gold-dim)]';
const wrapError = 'border-status-red/70 focus-within:border-status-red focus-within:shadow-[0_0_0_3px_rgba(239,68,68,0.12)]';
const controlEl =
  'h-full min-w-0 flex-1 border-none bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted focus-visible:outline-none disabled:cursor-not-allowed';

export const labelClass = 'mb-[7px] block text-[13px] font-semibold text-text-primary';
export const errorClass = 'mt-1.5 flex items-center gap-1 text-[12px] text-status-red';
export const hintClass = 'mt-1.5 text-[12px] text-text-muted';

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className={errorClass}>
      <AlertCircle size={12} className="shrink-0" aria-hidden />
      {message}
    </p>
  );
}

interface FieldShellProps {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  /** Right-aligned node beside the label (e.g. a char counter). */
  labelAccessory?: React.ReactNode;
  children: React.ReactNode;
}

/** Label row + control slot + hint/error — the consistent vertical rhythm. */
export function FieldShell({ id, label, error, hint, labelAccessory, children }: FieldShellProps) {
  return (
    <div className="mb-4">
      <div className="mb-[7px] flex items-center justify-between">
        <label htmlFor={id} className="text-[13px] font-semibold text-text-primary">
          {label}
        </label>
        {labelAccessory}
      </div>
      {children}
      {hint && !error && <p className={hintClass}>{hint}</p>}
      <FieldError message={error} />
    </div>
  );
}

// ─── Text field ────────────────────────────────────────────────────────────

interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
  icon?: React.ReactNode;
}

export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, error, hint, icon, id, className, ...rest },
  ref,
) {
  const fieldId = id ?? rest.name;
  return (
    <FieldShell id={fieldId!} label={label} error={error} hint={hint}>
      <div className={cn(wrapBase, error ? wrapError : wrapIdle)}>
        {icon && <span className="shrink-0 text-text-muted">{icon}</span>}
        <input
          id={fieldId}
          ref={ref}
          aria-invalid={!!error}
          className={cn(controlEl, className)}
          {...rest}
        />
      </div>
    </FieldShell>
  );
});

// ─── Password field (with show/hide toggle) ──────────────────────────────────

interface PasswordFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  error?: string;
  hint?: string;
}

export const PasswordField = React.forwardRef<HTMLInputElement, PasswordFieldProps>(
  function PasswordField({ label, error, hint, id, className, ...rest }, ref) {
    const [show, setShow] = React.useState(false);
    const fieldId = id ?? rest.name;
    return (
      <FieldShell id={fieldId!} label={label} error={error} hint={hint}>
        <div className={cn(wrapBase, error ? wrapError : wrapIdle)}>
          <Lock size={16} className="shrink-0 text-text-muted" aria-hidden />
          <input
            id={fieldId}
            ref={ref}
            type={show ? 'text' : 'password'}
            aria-invalid={!!error}
            className={cn(controlEl, className)}
            {...rest}
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? 'Hide password' : 'Show password'}
            className="inline-flex shrink-0 p-1 text-text-muted hover:text-text-secondary"
          >
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </FieldShell>
    );
  },
);

// ─── Date field (styled native input) ────────────────────────────────────────

interface DateFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  error?: string;
  hint?: string;
}

export const DateField = React.forwardRef<HTMLInputElement, DateFieldProps>(function DateField(
  { label, error, hint, id, className, ...rest },
  ref,
) {
  const fieldId = id ?? rest.name;
  return (
    <FieldShell id={fieldId!} label={label} error={error} hint={hint}>
      <div className={cn(wrapBase, error ? wrapError : wrapIdle)}>
        <input
          id={fieldId}
          ref={ref}
          type="date"
          aria-invalid={!!error}
          // color-scheme:dark themes the native picker + calendar indicator for
          // the dark UI (otherwise the indicator is invisible on bg-elevated).
          style={{ colorScheme: 'dark' }}
          className={cn(controlEl, className)}
          {...rest}
        />
      </div>
    </FieldShell>
  );
});

// ─── Select field (styled native select) ─────────────────────────────────────

interface SelectFieldProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  error?: string;
  hint?: string;
  options: { value: string; label: string }[];
}

export const SelectField = React.forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, error, hint, options, id, className, ...rest },
  ref,
) {
  const fieldId = id ?? rest.name;
  return (
    <FieldShell id={fieldId!} label={label} error={error} hint={hint}>
      <div className={cn(wrapBase, 'pr-2', error ? wrapError : wrapIdle)}>
        <select
          id={fieldId}
          ref={ref}
          aria-invalid={!!error}
          style={{ colorScheme: 'dark' }}
          className={cn(controlEl, 'cursor-pointer appearance-none pr-6 text-text-primary', className)}
          {...rest}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown
          size={16}
          className="pointer-events-none absolute right-3 text-text-muted"
          aria-hidden
        />
      </div>
    </FieldShell>
  );
});

// ─── Textarea field ──────────────────────────────────────────────────────────

interface TextareaFieldProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  error?: string;
  hint?: string;
  /** Current length + max → renders a counter beside the label. */
  count?: { current: number; max: number };
}

export const TextareaField = React.forwardRef<HTMLTextAreaElement, TextareaFieldProps>(
  function TextareaField({ label, error, hint, count, id, className, ...rest }, ref) {
    const fieldId = id ?? rest.name;
    return (
      <FieldShell
        id={fieldId!}
        label={label}
        error={error}
        hint={hint}
        labelAccessory={
          count && (
            <span
              className={cn(
                'font-[family-name:var(--font-mono)] text-[11px]',
                count.current > count.max ? 'text-status-red' : 'text-text-muted',
              )}
            >
              {count.current}/{count.max}
            </span>
          )
        }
      >
        <div className={cn('rounded-md border bg-bg-elevated px-3 py-2.5 transition-colors', error ? wrapError : wrapIdle)}>
          <textarea
            id={fieldId}
            ref={ref}
            aria-invalid={!!error}
            className={cn(
              'min-h-[84px] w-full resize-y border-none bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted focus-visible:outline-none',
              className,
            )}
            {...rest}
          />
        </div>
      </FieldShell>
    );
  },
);

// ─── File field (controlled — CV upload) ─────────────────────────────────────

interface FileFieldProps {
  label: string;
  id: string;
  value: File | null;
  onChange: (file: File | null) => void;
  error?: string;
  hint?: string;
  accept?: string;
  disabled?: boolean;
}

export function FileField({
  label,
  id,
  value,
  onChange,
  error,
  hint,
  accept,
  disabled,
}: FileFieldProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <FieldShell id={id} label={label} error={error} hint={hint}>
      <input
        id={id}
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={disabled}
        className="sr-only"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
      {value ? (
        <div className={cn(wrapBase, error ? wrapError : wrapIdle, 'justify-between')}>
          <span className="flex min-w-0 items-center gap-2.5 text-sm text-text-primary">
            <Paperclip size={16} className="shrink-0 text-accent-gold" aria-hidden />
            <span className="truncate">{value.name}</span>
            <span className="shrink-0 text-[12px] text-text-muted">
              {(value.size / 1024 / 1024).toFixed(1)} MB
            </span>
          </span>
          <button
            type="button"
            onClick={() => {
              onChange(null);
              if (inputRef.current) inputRef.current.value = '';
            }}
            aria-label="Remove file"
            className="inline-flex shrink-0 p-1 text-text-muted hover:text-text-secondary"
          >
            <X size={16} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className={cn(
            'flex h-[46px] w-full items-center gap-2.5 rounded-md border border-dashed px-3 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60',
            error
              ? 'border-status-red/70 text-status-red'
              : 'border-border-default text-text-muted hover:border-border-strong hover:bg-bg-hover',
          )}
        >
          <Paperclip size={16} className="shrink-0" aria-hidden />
          Upload a file
        </button>
      )}
    </FieldShell>
  );
}

// ─── Buttons + banners ───────────────────────────────────────────────────────

interface SubmitButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
}

export function SubmitButton({ loading, children, className, disabled, ...rest }: SubmitButtonProps) {
  return (
    <button
      type="submit"
      disabled={disabled || loading}
      className={cn(
        'mt-1.5 flex h-[46px] w-full items-center justify-center gap-2.5 rounded-md bg-accent-gold text-[15px] font-semibold text-bg-base transition-[background,transform] hover:bg-accent-gold-hover active:scale-[0.985] disabled:opacity-60',
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 size={16} className="animate-spin" />}
      {children}
    </button>
  );
}

interface GoogleButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
}

export function GoogleButton({ loading, children, disabled, ...rest }: GoogleButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className="flex h-[46px] w-full items-center justify-center gap-2.5 rounded-md border border-border-default bg-bg-elevated text-[15px] font-semibold text-text-primary transition-colors hover:border-border-strong hover:bg-bg-hover active:scale-[0.985] disabled:opacity-60"
      {...rest}
    >
      {loading ? (
        <Loader2 size={16} className="animate-spin" />
      ) : (
        <Image src="/brand/google-g.svg" alt="" width={18} height={18} unoptimized />
      )}
      {children}
    </button>
  );
}

/** Inline alert banner. `variant` maps to the status palette. */
export function FormBanner({
  variant = 'error',
  children,
  className,
}: {
  variant?: 'error' | 'info' | 'success';
  children: React.ReactNode;
  className?: string;
}) {
  const styles = {
    error: 'border-status-red/30 bg-status-red/10 text-status-red',
    info: 'border-border-default bg-bg-elevated text-text-secondary',
    success: 'border-status-green/30 bg-status-green/10 text-status-green',
  }[variant];
  return (
    <div
      role="alert"
      className={cn('rounded-md border px-3.5 py-2.5 text-[13px]', styles, className)}
    >
      {children}
    </div>
  );
}
