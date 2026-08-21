'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  LoginEmailSchema,
  type LoginEmailInput,
  type StaffMeResponse,
} from '@skaly/shared/schemas/auth';
import { Loader2, Mail, Lock, Eye, EyeOff } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api';
import { authErrorMessage } from '@/lib/auth-errors';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [oauthPending, setOauthPending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // After a completed password reset we redirect here with ?reset=success.
  // Read it from the URL (rather than useSearchParams, which would force a
  // Suspense boundary), toast once, then strip the param so a refresh is clean.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('reset') === 'success') {
      toast.success('Password updated. Sign in with your new password.');
      window.history.replaceState(null, '', '/login');
    }
  }, []);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginEmailInput>({
    resolver: zodResolver(LoginEmailSchema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit({ email, password }: LoginEmailInput) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      // Supabase returns generic messages; authErrorMessage maps the known ones
      // to friendly copy — including the unreachable-host case, which used to
      // land on "Something went wrong" and leave the user retrying blind.
      setError('root', { message: authErrorMessage(error) });
      return;
    }

    // Signed in with Supabase — now confirm portal access via our API.
    try {
      const me = await api<StaffMeResponse>('/v1/staff/me');

      // Admin/manager must enrol MFA before entering the portal (AUTH-MATRIX §10).
      if ((me.role === 'admin' || me.role === 'manager') && !me.mfaEnrolled) {
        router.push('/mfa-setup');
        return;
      }

      // Enrolled users owe an AAL2 TOTP challenge before entering. Supabase reports
      // it via the assurance level: a verified factor makes nextLevel 'aal2' while a
      // fresh password sign-in is still 'aal1'. The middleware enforces this too —
      // this is the friendly path that sends them straight to the challenge.
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
        router.push('/mfa-challenge');
        return;
      }

      router.push('/');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ACCOUNT_DEACTIVATED') {
        await supabase.auth.signOut();
        setError('root', { message: 'Account deactivated. Contact your admin.' });
        return;
      }
      if (err instanceof ApiError && err.code === 'NO_STAFF_ROW') {
        await supabase.auth.signOut();
        setError('root', {
          message:
            'No portal access for this account. If you signed up, your request may still be pending review.',
        });
        return;
      }
      if (err instanceof ApiError && err.code === 'NETWORK_ERROR') {
        setError('root', {
          message: 'Signed in, but the portal API is not responding. Try again in a moment.',
        });
        return;
      }
      setError('root', { message: 'Could not load your profile. Try again.' });
    }
  }

  async function onGoogle() {
    setOauthPending(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/auth/callback' },
    });
    if (error) {
      // On success the browser navigates away to Google; only reset on failure.
      setOauthPending(false);
      setError('root', {
        message: authErrorMessage(error, 'Could not start Google sign-in. Try again.'),
      });
    }
  }

  const busy = isSubmitting || oauthPending;
  const inputWrap =
    'relative flex h-[46px] items-center gap-2.5 rounded-md border border-border-default bg-bg-elevated px-3 transition-colors focus-within:border-accent-gold focus-within:shadow-[0_0_0_3px_var(--accent-gold-dim)]';
  const inputEl =
    'h-full min-w-0 flex-1 border-none bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted focus-visible:outline-none disabled:cursor-not-allowed';

  return (
    <div className="w-full">
      {/* Mobile-only mark (brand panel is hidden below md) */}
      <Image
        src="/brand/skaly-logo.png"
        alt="Skaly Group"
        width={52}
        height={52}
        priority
        unoptimized
        className="mb-6 md:hidden"
      />

      <div className="mb-7">
        <h1 className="font-[family-name:var(--font-display)] text-[34px] font-bold leading-[1.05] text-text-primary">
          Welcome back
        </h1>
        <p className="mt-1.5 text-sm text-text-muted">Sign in to the Skaly Business Portal.</p>
      </div>

      {errors.root?.message && (
        <div
          role="alert"
          className="mb-5 rounded-md border border-status-red/30 bg-status-red/10 px-3.5 py-2.5 text-[13px] text-status-red"
        >
          {errors.root.message}
        </div>
      )}

      {/* method="post" is a safety net, not a route: nothing serves POST /login.
          A form with no method defaults to GET, so if this is submitted BEFORE React
          hydrates — slow network, a failed chunk, JS disabled — the browser performs a
          native submit and puts every field in the query string. That was observed:
          `/login?email=…&password=E2eAdmin!2026-Skaly`, i.e. the password written into
          browser history, the server access log and any outbound Referer. POST keeps
          the credentials in a body that simply 405s. */}
      <form onSubmit={handleSubmit(onSubmit)} method="post" noValidate>
        {/* Email */}
        <div className="mb-4">
          <label htmlFor="email" className="mb-[7px] block text-[13px] font-semibold text-text-primary">
            Email
          </label>
          <div className={inputWrap}>
            <Mail size={16} className="shrink-0 text-text-muted" aria-hidden />
            <input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@skalygroup.com"
              disabled={busy}
              className={inputEl}
              aria-invalid={!!errors.email}
              suppressHydrationWarning
              {...register('email')}
            />
          </div>
          {errors.email?.message && (
            <p className="mt-1.5 text-[12px] text-status-red">{errors.email.message}</p>
          )}
        </div>

        {/* Password */}
        <div className="mb-4">
          <div className="mb-[7px] flex items-center justify-between">
            <label htmlFor="password" className="text-[13px] font-semibold text-text-primary">
              Password
            </label>
            <Link
              href="/forgot-password"
              className="text-[12px] font-medium text-accent-gold hover:text-accent-gold-hover"
            >
              Forgot password?
            </Link>
          </div>
          <div className={inputWrap}>
            <Lock size={16} className="shrink-0 text-text-muted" aria-hidden />
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="Enter your password"
              disabled={busy}
              className={inputEl}
              aria-invalid={!!errors.password}
              suppressHydrationWarning
              {...register('password')}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="inline-flex shrink-0 p-1 text-text-muted hover:text-text-secondary"
              suppressHydrationWarning
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {errors.password?.message && (
            <p className="mt-1.5 text-[12px] text-status-red">{errors.password.message}</p>
          )}
        </div>

        {/* Sign in */}
        <button
          type="submit"
          disabled={busy}
          className="mt-1.5 flex h-[46px] w-full items-center justify-center gap-2.5 rounded-md bg-accent-gold text-[15px] font-semibold text-bg-base transition-[background,transform] hover:bg-accent-gold-hover active:scale-[0.985] disabled:opacity-60"
          suppressHydrationWarning
        >
          {isSubmitting && <Loader2 size={16} className="animate-spin" />}
          Sign in
        </button>
      </form>

      {/* Divider */}
      <div className="my-[22px] flex items-center gap-3.5">
        <span className="h-px flex-1 bg-border-subtle" />
        <span className="font-[family-name:var(--font-mono)] text-[11px] tracking-[0.1em] text-text-muted">
          OR
        </span>
        <span className="h-px flex-1 bg-border-subtle" />
      </div>

      {/* Google */}
      <button
        type="button"
        onClick={onGoogle}
        disabled={busy}
        className="flex h-[46px] w-full items-center justify-center gap-2.5 rounded-md border border-border-default bg-bg-elevated text-[15px] font-semibold text-text-primary transition-colors hover:border-border-strong hover:bg-bg-hover active:scale-[0.985] disabled:opacity-60"
        suppressHydrationWarning
      >
        {oauthPending ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <Image src="/brand/google-g.svg" alt="" width={18} height={18} unoptimized />
        )}
        Continue with Google
      </button>

      {/* Request access */}
      <p className="mt-[26px] text-center text-[13.5px] text-text-muted">
        Need an account?{' '}
        <Link href="/signup" className="font-semibold text-accent-gold hover:text-accent-gold-hover">
          Request access →
        </Link>
      </p>
    </div>
  );
}
