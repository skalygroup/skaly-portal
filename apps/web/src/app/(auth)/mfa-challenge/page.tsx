'use client';

import { AlertCircle, KeyRound, Loader2, Lock } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { MfaRecoveryRedeemResponse } from '@skaly/shared/schemas/auth';

import { AuthCanvasCard } from '@/components/auth/auth-canvas-card';
import { FormBanner } from '@/components/auth/form-controls';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { api, ApiError } from '@/lib/api';
import { authErrorMessage } from '@/lib/auth-errors';
import { setRecoveryNotice } from '@/lib/recovery-notice';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

/**
 * Login-time TOTP challenge (Sprint 8 STEP 8, AUTH-MATRIX §10). An enrolled
 * admin/manager signs in with their password (aal1) and lands here to step the
 * session up to aal2 before the portal lets them in. The middleware enforces the
 * same gate on every protected route, so this page can't be skipped by navigating
 * straight to `/`.
 *
 * The challenge + verify run entirely against the user's own Supabase session
 * (`challengeAndVerify`) — the admin service client can't validate a TOTP code.
 * A successful verify rotates the session token to aal2; the middleware then
 * passes.
 *
 * RECOVERY CODES (Sprint 11 STEP 8). The alternative for someone who no longer
 * has the authenticator. It cannot step the session up — only Supabase's own
 * verify mints `aal2`, and the API never sees a TOTP code — so a redeemed code
 * clears the factor instead and this page routes to `/mfa-setup` to enrol a new
 * authenticator. That is also what losing the device actually means: you need a
 * new one. See `AuthService.redeemRecoveryCode`.
 */
export default function MfaChallengePage() {
  const router = useRouter();
  const supabase = createClient();

  const [factorId, setFactorId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  // One-shot mount effect; guard StrictMode's double-invoke.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    (async () => {
      // Already stepped up (e.g. just finished enrollment) → no challenge owed.
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.currentLevel === 'aal2') {
        router.replace('/');
        return;
      }
      const { data, error } = await supabase.auth.mfa.listFactors();
      const totp = data?.totp?.[0];
      if (error || !totp) {
        // A transport failure is not a missing factor. If the auth host never
        // answered, telling someone whose account is fine to go get their MFA
        // reset sends them to an admin for a problem they do not have — so only
        // claim "no authenticator" when the call actually came back.
        setLoadError(
          authErrorMessage(
            error,
            'We couldn’t find an authenticator on your account. Ask an admin to reset your MFA.',
          ),
        );
        return;
      }
      setFactorId(totp.id);
    })();
  }, [router, supabase]);

  const verify = useCallback(
    async (sixDigits: string) => {
      if (!factorId || verifying) return;
      setVerifying(true);
      setVerifyError(null);

      try {
        // challengeAndVerify against the user's session — a good code rotates the
        // token to aal2. A wrong / expired code errors here.
        const { error } = await supabase.auth.mfa.challengeAndVerify({
          factorId,
          code: sixDigits,
        });
        if (error) {
          // The API never sees this code, so a failure only reaches the SHARED
          // MFA failure budget if we report it. Without this the "3 attempts"
          // in AUTH-MATRIX §10 would quietly mean three per credential type.
          // Best-effort: a failed report must not mask the failed code.
          void api('/v1/auth/mfa/failure', { method: 'POST' }).catch(() => {});

          const locked = /too many|rate|locked|attempts/i.test(error.message);
          setVerifyError(
            locked
              ? 'Too many attempts. Please wait a few minutes and try again.'
              : 'Incorrect code. Try again.',
          );
          setCode('');
          return;
        }
        // Session is now aal2; the middleware will pass.
        router.push('/');
      } catch (err) {
        setVerifyError(authErrorMessage(err, 'Something went wrong verifying that code. Try again.'));
        setCode('');
      } finally {
        setVerifying(false);
      }
    },
    [factorId, supabase, verifying, router],
  );

  // Auto-submit on the 6th digit — no separate submit button.
  function onCodeChange(value: string) {
    setCode(value);
    setVerifyError(null);
    if (value.length === 6) void verify(value);
  }

  const redeem = useCallback(async () => {
    if (redeeming || !recoveryCode.trim()) return;
    setRedeeming(true);
    setRecoveryError(null);

    try {
      const { remainingCodes } = await api<MfaRecoveryRedeemResponse>('/v1/auth/mfa/recovery', {
        method: 'POST',
        body: JSON.stringify({ code: recoveryCode }),
      });
      // The account is now unenrolled, so the middleware's enrolment rule takes
      // over from its aal2 rule and /mfa-setup is where it would send us anyway.
      setRecoveryNotice(remainingCodes);
      router.push('/mfa-setup');
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      setRecoveryError(
        code === 'MFA_LOCKED'
          ? 'Too many failed attempts. Try again in 15 minutes.'
          : code === 'MFA_FAILED'
            ? 'That recovery code isn’t valid, or it has already been used.'
            : authErrorMessage(err),
      );
      setRecoveryCode('');
    } finally {
      setRedeeming(false);
    }
  }, [recoveryCode, redeeming, router]);

  return (
    <AuthCanvasCard
      eyebrow="Two-factor authentication"
      title="Verify it’s you"
      subtitle="Enter the 6-digit code from your authenticator app to finish signing in."
      maxWidth={480}
      footerRight="Two-factor authentication"
      badge={<SecureBadge />}
    >
      <div className="flex flex-col gap-[22px] px-8 pb-[30px] pt-[26px]">
        {loadError && <FormBanner variant="error">{loadError}</FormBanner>}

        {mode === 'totp' && !factorId && !loadError && (
          <div className="flex items-center justify-center gap-2 py-14 text-text-secondary">
            <Loader2 size={18} className="animate-spin" />
            <span className="text-sm">Loading your authenticator…</span>
          </div>
        )}

        {mode === 'recovery' && (
          <div className="flex flex-col gap-3">
            <p className="text-[13.5px] leading-[1.55] text-text-secondary">
              Enter one of the recovery codes you saved when you set up two-factor
              authentication. Each code works once, and using one will ask you to set up a new
              authenticator app.
            </p>
            <input
              type="text"
              inputMode="text"
              autoComplete="one-time-code"
              autoFocus
              spellCheck={false}
              value={recoveryCode}
              disabled={redeeming}
              onChange={(e) => {
                setRecoveryCode(e.target.value);
                setRecoveryError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void redeem();
              }}
              aria-label="Recovery code"
              aria-invalid={!!recoveryError}
              placeholder="e.g. 4f2a9c1e7b"
              className={cn(
                'h-12 rounded-[10px] border bg-[#101013] px-4 font-[family-name:var(--font-mono)] text-[15px] tracking-[0.14em] text-[#E4E4E7] outline-none transition-colors placeholder:tracking-normal placeholder:text-text-muted focus:border-accent-gold',
                recoveryError ? 'border-status-red/60 [animation:skShake_0.4s]' : 'border-[#232329]',
              )}
            />

            {recoveryError ? (
              <span className="flex items-center gap-[7px] text-[13px] text-[#F87171]">
                <AlertCircle size={15} />
                {recoveryError}
              </span>
            ) : null}

            <button
              type="button"
              disabled={redeeming || !recoveryCode.trim()}
              onClick={() => void redeem()}
              className="h-12 rounded-[10px] text-[15px] font-bold transition-[filter] enabled:bg-accent-gold enabled:text-bg-base enabled:hover:brightness-[1.06] disabled:cursor-not-allowed disabled:bg-bg-selected disabled:text-text-muted"
            >
              {redeeming ? 'Checking your code…' : 'Use recovery code'}
            </button>

            <button
              type="button"
              onClick={() => {
                setMode('totp');
                setRecoveryError(null);
                setRecoveryCode('');
              }}
              className="self-center text-[13.5px] text-text-secondary transition-colors hover:text-text-primary"
            >
              Back to the authenticator code
            </button>
          </div>
        )}

        {mode === 'totp' && factorId && (
          <div className="flex flex-col gap-3">
            <InputOTP
              maxLength={6}
              value={code}
              onChange={onCodeChange}
              disabled={verifying}
              autoFocus
              aria-label="6-digit verification code"
              containerClassName={cn(
                verifying && 'pointer-events-none',
                verifyError && '[animation:skShake_0.4s]',
              )}
            >
              <InputOTPGroup>
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <InputOTPSlot key={i} index={i} invalid={!!verifyError} />
                ))}
              </InputOTPGroup>
            </InputOTP>

            {verifyError ? (
              <span className="flex items-center gap-[7px] text-[13px] text-[#F87171]">
                <AlertCircle size={15} />
                {verifyError}
              </span>
            ) : verifying ? (
              <span className="flex items-center gap-2 text-[13px] text-text-secondary">
                <Loader2 size={15} className="animate-spin text-accent-gold" />
                Verifying your code…
              </span>
            ) : (
              <span className="text-[12.5px] text-text-muted">
                The code refreshes every 30 seconds — you’re signed in automatically once all six
                digits are in.
              </span>
            )}
          </div>
        )}

        {/* Reachable even when the factor lookup failed — "we couldn't find an
            authenticator on your account" is precisely when someone needs this. */}
        {mode === 'totp' && (
          <button
            type="button"
            onClick={() => {
              setMode('recovery');
              setVerifyError(null);
              setCode('');
            }}
            className="flex items-center justify-center gap-[7px] self-center text-[13.5px] text-text-secondary transition-colors hover:text-text-primary"
          >
            <KeyRound size={15} />
            Lost your authenticator? Use a recovery code
          </button>
        )}

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

/** Small "Secure" pill shown in the card header. */
function SecureBadge() {
  return (
    <span className="flex items-center gap-[7px] font-[family-name:var(--font-mono)] text-[10px] tracking-[0.06em] text-border-strong">
      <Lock size={13} strokeWidth={1.8} className="text-accent-gold" />
      Secure
    </span>
  );
}
