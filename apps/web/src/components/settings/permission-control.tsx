'use client';

import { cn } from '@/lib/utils';

/**
 * THE permission control. One control with three values — not three components,
 * and not a toggle with a reset button bolted beside it.
 *
 * ── Why three ────────────────────────────────────────────────────────────────
 * AUTH-MATRIX §6.1 resolves a permission as "explicit row wins, otherwise the
 * role default". Inheritance is therefore expressible ONLY as the ABSENCE of a
 * row, which is why the API's third verb is a DELETE and not a third value.
 *
 * A two-state toggle cannot express that. Its `false` position has to write a
 * Deny row, so the moment an admin touches any key, that key is pinned for that
 * user forever: change the role default later and this person alone does not
 * move. The default becomes unreachable through the product — and unreachable in
 * the direction nobody notices, because the screen still reads "off".
 *
 * ── Why a radiogroup ─────────────────────────────────────────────────────────
 * Three mutually exclusive values IS a radio group. The native element gives
 * arrow-key navigation, one tab stop for the group, and the right thing said to
 * a screen reader, none of which we would get right by hand on a div with
 * onClick. The segmented look is CSS over real inputs, not a re-implementation.
 */
export type PermissionState = boolean | null;

const OPTIONS: { value: PermissionState; label: string; key: string }[] = [
  { value: true, label: 'Allow', key: 'allow' },
  { value: false, label: 'Deny', key: 'deny' },
  { value: null, label: 'Inherit', key: 'inherit' },
];

export function PermissionControl({
  permissionKey,
  label,
  value,
  roleDefault,
  disabled = false,
  onChange,
}: {
  permissionKey: string;
  /** Human label for the key; the key itself stays visible for §6.2 verification. */
  label: string;
  /** The OVERRIDE: true = allow, false = deny, null = no row (inherit). */
  value: PermissionState;
  /** ROLE_DEFAULTS[key][role] — what Inherit resolves to for this person. */
  roleDefault: boolean;
  disabled?: boolean;
  onChange: (next: PermissionState) => void;
}) {
  // §6.1's precedence, on screen. Showing it is what lets an admin verify a
  // change without logging in as the person it applies to.
  const effective = value ?? roleDefault;
  const inheritHint = roleDefault ? 'allowed by role' : 'denied by role';

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-4 py-3 last:border-0">
      <div className="min-w-0">
        <p className="text-[13.5px] font-medium text-text-primary">{label}</p>
        <p className="mt-0.5 font-[family-name:var(--font-mono)] text-[11px] text-text-muted">
          {permissionKey}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <span
          data-testid={`effective-${permissionKey}`}
          className={cn(
            'rounded-full px-2.5 py-0.5 text-[11px] font-medium',
            effective ? 'bg-status-green/10 text-status-green' : 'bg-status-red/10 text-status-red',
          )}
        >
          {effective ? 'Allowed' : 'Denied'}
        </span>

        <fieldset
          disabled={disabled}
          className="inline-flex rounded-lg border border-border-subtle bg-bg-elevated p-0.5 disabled:opacity-60"
        >
          <legend className="sr-only">{label}</legend>
          {OPTIONS.map((opt) => {
            const selected = value === opt.value;
            const id = `${permissionKey}-${opt.key}`;
            return (
              <label
                key={opt.key}
                htmlFor={id}
                title={opt.value === null ? `Inherit — ${inheritHint}` : undefined}
                className={cn(
                  'cursor-pointer rounded-md px-2.5 py-1 text-[12.5px] font-semibold transition-colors',
                  selected
                    ? 'bg-[var(--accent-gold-dim)] text-accent-gold'
                    : 'text-text-muted hover:text-text-primary',
                  disabled && 'cursor-not-allowed',
                )}
              >
                <input
                  id={id}
                  type="radio"
                  name={permissionKey}
                  className="sr-only"
                  checked={selected}
                  onChange={() => onChange(opt.value)}
                />
                {/* Inherit says what it resolves to, so "Inherit" is never a
                    state whose meaning the admin has to go and look up. */}
                {opt.value === null && selected ? `Inherit — ${inheritHint}` : opt.label}
              </label>
            );
          })}
        </fieldset>
      </div>
    </div>
  );
}
