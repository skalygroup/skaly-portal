'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { PasswordResetConfirmSchema } from '@skaly/shared/schemas/auth';
import { AlertCircle, ArrowRight, Check, Circle, Clock, Copy, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import type { Factor, Session } from '@supabase/supabase-js';

import { AuthCanvasCard } from '@/components/auth/auth-canvas-card';
import { PasswordField, SubmitButton, FormBanner } from '@/components/auth/form-controls';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { api, ApiError } from '@/lib/api';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

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

// Every reset passes an authenticator gate before the password form:
//   'challenge' — account already has a verified TOTP factor → enter a code.
//   'enroll'    — account has no factor → scan a QR, then enter a code.
// Both end at AAL2, which Supabase requires to change the password of an
// MFA-protected account and which we now require of everyone (RULES).
type View = 'checking' | 'challenge' | 'enroll' | 'ready' | 'invalid' | 'done';

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
 * Reset-password page (Sprint 1 STEP 13/14). Target of Supabase's recovery link
 * (delivered via /auth/confirm, which establishes the recovery session). Flow:
 *
 *   verified link → authenticator step (challenge OR setup) → new-password form → done
 *
 * The authenticator step is mandatory for *everyone*: enrolled users pass a TOTP
 * challenge; users without a factor set one up on the spot. Either way the
 * session is raised to aal2 — Supabase refuses updateUser({password}) on an
 * account with a verified factor below aal2 ("reauthentication required"), and a
 * recovery session starts at aal1. A dead/expired link is a dead-end pointing
 * back to /forgot-password. The email is never pre-filled — the session knows
 * the user (RULES).
 */
export default function ResetPasswordPage() {
  const router = useRouter();
  const supabase = createClient();
  const [view, setView] = useState<View>('checking');

  // Authenticator step state (shared by the challenge + enroll variants).
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<{ qrCodeDataUrl: string; secret: string } | null>(
    null,
  );
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
    // Enrollment mints a factor; guard against React StrictMode's double-invoke
    // (and the duplicate auth events Supabase can emit) creating two factors.
    let enrollStarted = false;

    // Mint a fresh TOTP factor for an un-enrolled user. max_factors=1 means a
    // stale unverified factor from an abandoned attempt blocks re-enroll — clear
    // it and retry so the user always gets a scannable QR.
    async function startEnroll() {
      if (enrollStarted) return;
      enrollStarted = true;
      try {
        let res = await supabase.auth.mfa.enroll({ factorType: 'totp' });
        if (res.error) {
          const { data: f } = await supabase.auth.mfa.listFactors();
          const stale = f?.totp?.find((x: Factor) => x.status === 'unverified');
          if (stale) {
            await supabase.auth.mfa.unenroll({ factorId: stale.id });
            res = await supabase.auth.mfa.enroll({ factorType: 'totp' });
          }
        }
        if (!active) return;
        if (res.error || !res.data) {
          setEnrollError('Could not start authenticator setup. Request a new link to try again.');
          return;
        }
        setFactorId(res.data.id);
        setEnrollment({ qrCodeDataUrl: res.data.totp.qr_code, secret: res.data.totp.secret });
      } catch {
        if (active) {
          setEnrollError('Could not start authenticator setup. Request a new link to try again.');
        }
      }
    }

    // Once a recovery session exists, route through the authenticator gate:
    // a verified factor → challenge; otherwise → set one up.
    async function gateAfterSession() {
      const { data: factors } = await supabase.auth.mfa.listFactors();
      if (!active) return;
      const verified = factors?.totp?.find((f: Factor) => f.status === 'verified');
      if (verified) {
        setFactorId(verified.id);
        setView('challenge');
      } else {
        setView('enroll');
        void startEnroll();
      }
    }

    const search = window.location.search;
    const hash = window.location.hash;
    const params = new URLSearchParams(search);

    if (/error=|error_code=/.test(hash + search)) {
      // A dead link (expired/used/invalid) — show it even if a stale, non-recovery
      // login session is still in storage. This is the bug behind "otp_expired"
      // landing on the form: a leftover session must NOT unlock the flow.
      setView('invalid');
    } else if (params.get('confirmed') === '1') {
      // Arrived from /auth/confirm, which already ran verifyOtp client-side and
      // established the recovery session (the prefetch-safe path).
      supabase.auth.getSession().then(({ data }: { data: { session: Session | null } }) => {
        if (!active) return;
        window.history.replaceState(null, '', '/reset-password');
        if (data.session) void gateAfterSession();
        else setView('invalid');
      });
    } else {
      // Supabase's default (implicit) recovery template lands here with the
      // tokens in the URL hash (#access_token=…&refresh_token=…). Our browser
      // client uses PKCE, which only consumes a ?code= query param and ignores
      // implicit hash tokens — so detectSessionInUrl/PASSWORD_RECOVERY never
      // fire. Establish the recovery session explicitly from the hash.
      const hashParams = new URLSearchParams(hash.replace(/^#/, ''));
      const accessToken = hashParams.get('access_token');
      const refreshToken = hashParams.get('refresh_token');
      if (accessToken && refreshToken) {
        supabase.auth
          .setSession({ access_token: accessToken, refresh_token: refreshToken })
          .then(({ data, error }: { data: { session: Session | null }; error: unknown }) => {
            if (!active) return;
            window.history.replaceState(null, '', '/reset-password'); // strip tokens from URL
            if (!error && data.session) void gateAfterSession();
            else setView('invalid');
          });
      } else {
        setView('invalid');
      }
    }

    return () => {
      active = false;
    };
  }, [supabase]);

  // ── Authenticator verify: challenge + verify the 6-digit TOTP. On the enroll
  //    path we also persist staff.mfa_enrolled (mirrors /mfa-setup). Either way a
  //    success raises the session to aal2 so the password form can complete. ──
  const verifyMfa = useCallback(
    async (sixDigits: string) => {
      if (!factorId || verifying) return;
      setVerifying(true);
      setMfaError(null);
      try {
        const challenge = await supabase.auth.mfa.challenge({ factorId });
        if (challenge.error || !challenge.data) {
          setMfaError('Incorrect code. Try again.');
          setCode('');
          return;
        }
        const { error } = await supabase.auth.mfa.verify({
          factorId,
          challengeId: challenge.data.id,
          code: sixDigits,
        });
        if (error) {
          setMfaError('Incorrect code. Try again.');
          setCode('');
          return;
        }
        // The factor is now verified in Supabase. If we just enrolled it, flip
        // staff.mfa_enrolled so the rest of the system agrees (non-fatal if it
        // fails — the Supabase factor stands regardless).
        if (view === 'enroll') {
          try {
            await api('/v1/auth/mfa/verify', {
              method: 'POST',
              body: JSON.stringify({ factorId, code: sixDigits }),
            });
          } catch {
            // Ignore — the password reset can still proceed on the aal2 session.
          }
        }
        // Session is now aal2 → the password form can complete updateUser.
        setCode('');
        setView('ready');
      } catch {
        setMfaError('Something went wrong verifying that code. Try again.');
        setCode('');
      } finally {
        setVerifying(false);
      }
    },
    [factorId, supabase, verifying, view],
  );

  function onCodeChange(value: string) {
    setCode(value);
    setMfaError(null);
    if (value.length === 6) void verifyMfa(value);
  }

  async function copySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
    } catch {
      // Clipboard can be blocked (insecure context / permissions) — no-op.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  async function onSubmit({ newPassword }: ResetFormInput) {
    // The password change runs server-side via the Supabase Admin API, NOT the
    // client SDK. With "Secure password change" enabled, client updateUser
    // demands reauthentication once the authenticator step-up makes `totp` the
    // most-recent auth method (the recovery exemption is consumed server-side).
    // The backend endpoint is gated on this same aal2 session and writes with
    // the service role, which isn't subject to that reauthentication gate.
    try {
      await api('/v1/auth/password/update', {
        method: 'POST',
        body: JSON.stringify({ newPassword }),
      });
    } catch (err) {
      setError('root', {
        message:
          (err instanceof ApiError && err.message) ||
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

  // ── Authenticator setup (no factor yet): scan a QR, then enter a code ─────
  if (view === 'enroll') {
    return (
      <AuthCanvasCard
        eyebrow="Two-factor authentication"
        title="Verify it’s you"
        subtitle="For your security, set up an authenticator app before choosing a new password."
        maxWidth={560}
        footerRight="Account recovery"
      >
        <div className="flex flex-col gap-[22px] px-8 pb-[30px] pt-[26px]">
          {enrollError && <FormBanner variant="error">{enrollError}</FormBanner>}

          {!enrollment && !enrollError && (
            <div className="flex items-center justify-center gap-2 py-14 text-text-secondary">
              <Loader2 size={18} className="animate-spin" />
              <span className="text-sm">Generating your secure code…</span>
            </div>
          )}

          {enrollment && (
            <>
              {/* Step 1 — scan */}
              <div className="flex flex-wrap items-start gap-5">
                <div className="flex min-h-[204px] min-w-[204px] shrink-0 items-center justify-center rounded-[14px] bg-white p-2.5 shadow-[0_8px_24px_-10px_rgba(0,0,0,0.6)]">
                  {/* QR is a data: URL from Supabase (not a static asset), so
                      next/image can't optimise it — a plain <img> is correct. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={enrollment.qrCodeDataUrl}
                    alt="Authenticator QR code"
                    width={184}
                    height={184}
                    className="h-[184px] w-[184px]"
                  />
                </div>
                <div className="flex min-w-[200px] flex-1 flex-col gap-2">
                  <StepBadge n={1} label="Scan to add" />
                  <p className="text-sm leading-[1.55] text-[#D4D4D8]">
                    Open your authenticator app — Google Authenticator, 1Password, Authy — and scan
                    this code to register the Skaly portal.
                  </p>
                </div>
              </div>

              {/* Manual secret */}
              <div className="flex flex-col gap-2 rounded-xl border border-[#232329] bg-[#101013] p-4">
                <span className="text-[12.5px] text-text-secondary">
                  Can&apos;t scan? Enter this code manually in your authenticator app:
                </span>
                <div className="flex items-center gap-2.5">
                  <code className="flex-1 select-all break-all font-[family-name:var(--font-mono)] text-[15px] tracking-[0.18em] text-accent-gold">
                    {enrollment.secret}
                  </code>
                  <button
                    type="button"
                    onClick={() => copySecret(enrollment.secret)}
                    aria-label="Copy setup code"
                    className="flex h-[34px] shrink-0 items-center gap-1.5 rounded-lg border border-border-default bg-bg-elevated px-3 text-[12.5px] font-semibold text-[#E4E4E7] transition-colors hover:border-accent-gold hover:bg-bg-hover"
                  >
                    {copied ? <Check size={14} className="text-accent-gold" /> : <Copy size={14} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              {/* Step 2 — verify */}
              <div className="flex flex-col gap-3">
                <StepBadge n={2} label="Enter the 6-digit code" />
                <InputOTP
                  maxLength={6}
                  value={code}
                  onChange={onCodeChange}
                  disabled={verifying}
                  autoFocus
                  aria-label="6-digit verification code"
                  containerClassName={cn(
                    verifying && 'pointer-events-none',
                    mfaError && '[animation:skShake_0.4s]',
                  )}
                >
                  <InputOTPGroup>
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <InputOTPSlot key={i} index={i} invalid={!!mfaError} />
                    ))}
                  </InputOTPGroup>
                </InputOTP>

                {mfaError ? (
                  <span className="flex items-center gap-[7px] text-[13px] text-[#F87171]">
                    <AlertCircle size={15} />
                    {mfaError}
                  </span>
                ) : verifying ? (
                  <span className="flex items-center gap-2 text-[13px] text-text-secondary">
                    <Loader2 size={15} className="animate-spin text-accent-gold" />
                    Verifying your code…
                  </span>
                ) : (
                  <span className="text-[12.5px] text-text-muted">
                    The code refreshes every 30 seconds — we continue automatically once all six
                    digits are in.
                  </span>
                )}
              </div>

              <Link
                href="/login"
                className="self-center text-[13.5px] text-text-secondary transition-colors hover:text-text-primary"
              >
                Cancel and return to login
              </Link>
            </>
          )}
        </div>
      </AuthCanvasCard>
    );
  }

  // ── Authenticator challenge (factor already verified): enter a code ───────
  if (view === 'challenge') {
    return (
      <AuthCanvasCard
        eyebrow="Two-factor authentication"
        title="Verify it’s you"
        subtitle="Enter the 6-digit code from your authenticator app to keep resetting your password."
        footerRight="Account recovery"
      >
        <div className="flex flex-col gap-4 px-8 pb-[30px] pt-6">
          <InputOTP
            maxLength={6}
            value={code}
            onChange={onCodeChange}
            disabled={verifying}
            autoFocus
            aria-label="6-digit verification code"
            containerClassName={cn(verifying && 'pointer-events-none', mfaError && '[animation:skShake_0.4s]')}
          >
            <InputOTPGroup>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <InputOTPSlot key={i} index={i} invalid={!!mfaError} />
              ))}
            </InputOTPGroup>
          </InputOTP>

          <div className="min-h-[20px] text-[13px]">
            {verifying ? (
              <span className="flex items-center gap-2 text-text-secondary">
                <Loader2 size={15} className="animate-spin text-accent-gold" />
                Verifying your code…
              </span>
            ) : mfaError ? (
              <span className="flex items-center gap-[7px] text-[#F87171]">
                <AlertCircle size={15} />
                {mfaError}
              </span>
            ) : (
              <span className="text-text-muted">The code refreshes in your app every 30 seconds.</span>
            )}
          </div>

          <Link
            href="/login"
            className="self-center text-[13.5px] text-text-secondary transition-colors hover:text-text-primary"
          >
            Cancel and return to login
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

  // ── Form (valid recovery session, AAL satisfied) ─────────────────────────
  return (
    <AuthCanvasCard eyebrow="Set a new password" title="Create a new password" footerRight="Account recovery">
      {/* method="post" so a pre-hydration native submit cannot put the new password
          in the query string — see the note on the login form. */}
      <form onSubmit={handleSubmit(onSubmit)} method="post" noValidate className="flex flex-col gap-[18px] px-8 pb-[30px] pt-6">
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

/** Numbered step kicker (gold disc + mono uppercase label). */
function StepBadge({ n, label }: { n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.14em] text-text-muted">
      <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[var(--accent-gold-dim)] text-[10px] font-bold text-accent-gold">
        {n}
      </span>
      {label}
    </span>
  );
}
