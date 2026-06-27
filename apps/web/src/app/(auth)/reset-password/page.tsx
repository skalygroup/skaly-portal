'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { PasswordResetConfirmSchema } from '@skaly/shared/schemas/auth';
import { ArrowRight, Check, Circle, Clock, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import type { AuthChangeEvent, Session } from '@supabase/supabase-js';


import { AuthCanvasCard } from '@/components/auth/auth-canvas-card';
import { PasswordField, SubmitButton, FormBanner } from '@/components/auth/form-controls';
import { createClient } from '@/lib/supabase/client';

/**
 * New-password form schema. Reuses the shared password *policy* (the same
 * newPassword rule PasswordResetConfirmSchema enforces) and adds a client-only
 * confirm field that must match. The recovery session — not a typed token —
 * authorises the change, so there's no `token` field here.
 */
const ResetFormSchema = z
  .object({
    newPassword: PasswordResetConfirmSchema.shape.newPassword,
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Passwords don’t match.',
    path: ['confirmPassword'],
  });

type ResetFormInput = z.infer<typeof ResetFormSchema>;

type View = 'checking' | 'ready' | 'invalid' | 'done';

// Live checklist, mirroring the shared PasswordSchema policy (10+ chars with an
// uppercase, a lowercase, a digit, and a special character).
const REQUIREMENTS: { label: string; test: (p: string) => boolean }[] = [
  { label: '10+ characters', test: (p) => p.length >= 10 },
  { label: 'Uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { label: 'Lowercase letter', test: (p) => /[a-z]/.test(p) },
  { label: 'Number', test: (p) => /\d/.test(p) },
  { label: 'Special character', test: (p) => /[^A-Za-z0-9]/.test(p) },
];

/**
 * Reset-password page (Sprint 1 STEP 13), redesigned on the brand canvas. Target
 * of Supabase's recovery email link: the @supabase/ssr client auto-consumes the
 * URL fragment (#access_token=…&type=recovery) on mount and establishes a
 * session. Once it exists we show the new-password form; updateUser sets the
 * password, then we sign out and bounce to /login so they re-authenticate.
 *
 * No session means the link expired or was already used → a dead-end pointing
 * back to request a fresh link. The email is never pre-filled — the session
 * already knows the user (RULES).
 */
export default function ResetPasswordPage() {
  const router = useRouter();
  const supabase = createClient();
  const [view, setView] = useState<View>('checking');

  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetFormInput>({
    resolver: zodResolver(ResetFormSchema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  });

  const pw = watch('newPassword');
  const confirm = watch('confirmPassword');
  const checks = REQUIREMENTS.map((r) => ({ label: r.label, ok: r.test(pw) }));
  const liveMismatch = confirm.length > 0 && pw !== confirm ? 'Passwords don’t match.' : undefined;
  const allValid = checks.every((c) => c.ok) && confirm.length > 0 && pw === confirm;

  useEffect(() => {
    let active = true;

    // The recovery session may land via either getSession (fragment already
    // consumed) or the PASSWORD_RECOVERY auth event (consumed just after mount).
    const { data: sub } = supabase.auth.onAuthStateChange(
      (_event: AuthChangeEvent, s: Session | null) => {
        if (active && s) setView((prev) => (prev === 'checking' || prev === 'invalid' ? 'ready' : prev));
      },
    );

    supabase.auth.getSession().then(({ data }: { data: { session: Session | null } }) => {
      if (active && data.session) setView((prev) => (prev === 'checking' ? 'ready' : prev));
    });

    // If neither path produces a session shortly after mount, the link is dead.
    const timer = setTimeout(() => {
      if (active) setView((prev) => (prev === 'checking' ? 'invalid' : prev));
    }, 2000);

    return () => {
      active = false;
      sub.subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, [supabase]);

  async function onSubmit({ newPassword }: ResetFormInput) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      // Supabase rejects reusing the current password and enforces its own
      // policy; surface a friendly inline message either way.
      setError('root', {
        message:
          error.message ||
          'Could not update your password. Try a different one or request a new link.',
      });
      return;
    }
    // Force a clean re-login with the new password; show the success state, then
    // bounce to /login (which toasts on ?reset=success).
    await supabase.auth.signOut();
    setView('done');
    setTimeout(() => router.push('/login?reset=success'), 1400);
  }

  // ── Checking ───────────────────────────────────────────────────────────
  if (view === 'checking') {
    return (
      <AuthCanvasCard eyebrow="Set a new password" title="Create a new password" footerRight="Account recovery">
        <div className="flex items-center justify-center gap-2 px-8 py-16 text-text-secondary">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">Verifying your reset link…</span>
        </div>
      </AuthCanvasCard>
    );
  }

  // ── Expired / invalid ──────────────────────────────────────────────────
  if (view === 'invalid') {
    return (
      <AuthCanvasCard eyebrow="Link expired" title="Link no longer valid" footerRight="Account recovery">
        <div className="flex flex-col items-center gap-[18px] px-8 pb-[30px] pt-7 text-center [animation:skPop_0.25s_ease_both]">
          <div className="flex h-16 w-16 items-center justify-center rounded-full border border-[#F87171]/30 bg-[#F87171]/10">
            <Clock size={28} strokeWidth={1.8} className="text-[#F87171]" />
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="font-[family-name:var(--font-display)] text-xl font-bold text-text-primary">
              This link has expired
            </h2>
            <p className="max-w-[340px] text-[14.5px] leading-[1.6] text-text-secondary">
              This reset link has expired or is invalid. Reset links are valid for 60 minutes and can
              be used once. Request a fresh link and we&apos;ll email you a new one.
            </p>
          </div>
          <Link
            href="/forgot-password"
            className="flex h-[46px] items-center justify-center gap-2 rounded-[10px] bg-accent-gold px-[22px] text-[14.5px] font-bold text-bg-base transition-[filter] hover:brightness-[1.06]"
          >
            Request a new link
            <ArrowRight size={16} strokeWidth={2.2} />
          </Link>
          <Link
            href="/login"
            className="text-[13.5px] text-text-secondary transition-colors hover:text-text-primary"
          >
            Back to login
          </Link>
        </div>
      </AuthCanvasCard>
    );
  }

  // ── Done ───────────────────────────────────────────────────────────────
  if (view === 'done') {
    return (
      <AuthCanvasCard eyebrow="Set a new password" title="Create a new password" footerRight="Account recovery">
        <div className="flex flex-col items-center gap-[18px] px-8 pb-[30px] pt-7 text-center [animation:skPop_0.25s_ease_both]">
          <div className="flex h-16 w-16 items-center justify-center rounded-full border border-status-green/35 bg-status-green/10">
            <Check size={30} strokeWidth={2} className="text-[#4ADE80]" />
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="font-[family-name:var(--font-display)] text-xl font-bold text-text-primary">
              Password updated
            </h2>
            <p className="max-w-[330px] text-[14.5px] leading-[1.6] text-text-secondary">
              For your security we&apos;ve signed you out everywhere. Sign in with your new password to
              continue.
            </p>
          </div>
          <div className="flex items-center gap-2 text-[13px] text-text-muted">
            <Loader2 size={15} className="animate-spin text-accent-gold" />
            Redirecting you to login…
          </div>
        </div>
      </AuthCanvasCard>
    );
  }

  // ── Form (valid recovery session) ──────────────────────────────────────
  return (
    <AuthCanvasCard eyebrow="Set a new password" title="Create a new password" footerRight="Account recovery">
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-[18px] px-8 pb-[30px] pt-6">
        <p className="text-[14.5px] leading-[1.55] text-text-secondary">
          Choose a new password for your account. You&apos;ll use it the next time you sign in.
        </p>

        {errors.root?.message && <FormBanner variant="error">{errors.root.message}</FormBanner>}

        <PasswordField
          label="New password"
          autoComplete="new-password"
          placeholder="Enter a new password"
          error={errors.newPassword?.message}
          {...register('newPassword')}
        />

        {/* Live requirements checklist */}
        <div className="flex flex-col gap-2 rounded-xl border border-[#232329] bg-[#101013] px-4 py-3.5">
          <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.14em] text-text-muted">
            Must include
          </span>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {checks.map((c) => (
              <span
                key={c.label}
                className={
                  'flex items-center gap-2 text-[13px] ' +
                  (c.ok ? 'text-[#4ADE80]' : 'text-text-muted')
                }
              >
                {c.ok ? (
                  <Check size={15} strokeWidth={2.4} className="text-[#4ADE80]" />
                ) : (
                  <Circle size={15} strokeWidth={2} className="text-border-strong" />
                )}
                {c.label}
              </span>
            ))}
          </div>
        </div>

        <PasswordField
          label="Confirm password"
          autoComplete="new-password"
          placeholder="Re-enter your new password"
          error={errors.confirmPassword?.message ?? liveMismatch}
          {...register('confirmPassword')}
        />

        <SubmitButton loading={isSubmitting} disabled={!allValid}>
          {isSubmitting ? 'Updating password…' : 'Update password'}
        </SubmitButton>
      </form>
    </AuthCanvasCard>
  );
}
