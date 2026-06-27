'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  PasswordResetRequestSchema,
  type PasswordResetRequestInput,
} from '@skaly/shared/schemas/auth';
import { ArrowLeft, Mail } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { AuthCanvasCard } from '@/components/auth/auth-canvas-card';
import { TextField, SubmitButton } from '@/components/auth/form-controls';
import { api } from '@/lib/api';

/**
 * Forgot-password request (Sprint 1 STEP 13), redesigned on the brand canvas.
 *
 * Submits to POST /v1/auth/password-reset, which is anti-enumeration: it always
 * returns 200 whether or not the email maps to an account. The UI mirrors that —
 * the same neutral confirmation shows in every case, so it never reveals which
 * addresses exist (the echoed email is just the value the visitor typed).
 */
export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [sentEmail, setSentEmail] = useState('');

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<PasswordResetRequestInput>({
    resolver: zodResolver(PasswordResetRequestSchema),
    defaultValues: { email: '' },
  });

  async function onSubmit({ email }: PasswordResetRequestInput) {
    try {
      await api('/v1/auth/password-reset', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
    } catch {
      // Anti-enumeration: never surface a failure differently. Even a transient
      // network error collapses to the same neutral confirmation.
    }
    setSentEmail(email);
    setSent(true);
  }

  return (
    <AuthCanvasCard eyebrow="Account recovery" title="Reset your password" footerRight="Account recovery">
      {sent ? (
        <div className="flex flex-col items-center gap-[18px] px-8 pb-[30px] pt-7 text-center [animation:skPop_0.25s_ease_both]">
          <div className="flex h-16 w-16 items-center justify-center rounded-full border border-accent-gold/30 bg-[var(--accent-gold-dim)]">
            <Mail size={30} strokeWidth={1.7} className="text-accent-gold" />
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="font-[family-name:var(--font-display)] text-xl font-bold text-text-primary">
              Check your inbox
            </h2>
            <p className="max-w-[340px] text-[14.5px] leading-[1.6] text-text-secondary">
              If an account exists for{' '}
              <strong className="font-semibold text-[#E4E4E7]">{sentEmail}</strong>, a reset link is
              on its way. The link expires in 60 minutes.
            </p>
          </div>
          <div className="my-1 h-px w-full bg-[#232329]" />
          <p className="text-[13px] text-text-muted">
            Didn&apos;t get it? Check spam, or{' '}
            <button
              type="button"
              onClick={() => setSent(false)}
              className="border-none bg-none p-0 text-[13px] font-semibold text-accent-gold"
            >
              try a different email
            </button>
            .
          </p>
          <Link
            href="/login"
            className="flex items-center justify-center gap-[7px] text-sm text-text-secondary transition-colors hover:text-text-primary"
          >
            <ArrowLeft size={15} />
            Back to login
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-[18px] px-8 pb-[30px] pt-6">
          <p className="text-[14.5px] leading-[1.55] text-text-secondary">
            Enter the email tied to your account and we&apos;ll send a link to set a new password.
          </p>

          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="you@skalygroup.com"
            icon={<Mail size={16} aria-hidden />}
            error={errors.email?.message}
            {...register('email')}
          />

          <SubmitButton loading={isSubmitting}>
            {isSubmitting ? 'Sending link…' : 'Send reset link'}
          </SubmitButton>

          <Link
            href="/login"
            className="flex items-center justify-center gap-[7px] text-sm text-text-secondary transition-colors hover:text-text-primary"
          >
            <ArrowLeft size={15} />
            Back to login
          </Link>
        </form>
      )}
    </AuthCanvasCard>
  );
}
