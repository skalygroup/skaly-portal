'use client';

import { OTPInput, OTPInputContext } from 'input-otp';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * shadcn InputOTP, re-skinned to the auth dark/gold palette (login redesign,
 * APPFLOW §2). Wraps the `input-otp` package: one hidden input drives a row of
 * styled slots, so it keeps real <input> semantics (paste, autofill, mobile
 * numeric keyboard) while we render the boxes ourselves.
 */
function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & { containerClassName?: string }) {
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={cn(
        'flex items-center gap-2 has-[:disabled]:opacity-50',
        containerClassName,
      )}
      className={cn('disabled:cursor-not-allowed', className)}
      {...props}
    />
  );
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="input-otp-group" className={cn('flex items-center gap-2.5', className)} {...props} />
  );
}

function InputOTPSlot({
  index,
  invalid,
  className,
  ...props
}: React.ComponentProps<'div'> & { index: number; invalid?: boolean }) {
  const context = React.useContext(OTPInputContext);
  const { char, hasFakeCaret, isActive } = context?.slots[index] ?? {};

  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      data-invalid={invalid}
      className={cn(
        'relative flex h-14 w-[46px] items-center justify-center rounded-[10px] border-[1.5px] bg-bg-elevated text-[22px] font-bold text-text-primary transition-[color,border,box-shadow]',
        'font-[family-name:var(--font-mono)] tabular-nums',
        invalid
          ? 'border-[#7F1D1D]'
          : isActive
            ? 'z-10 border-accent-gold shadow-[0_0_0_3px_var(--accent-gold-dim)]'
            : char
              ? 'border-accent-gold'
              : 'border-border-default',
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-6 w-px animate-caret-blink bg-accent-gold duration-1000" />
        </div>
      )}
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSlot };
