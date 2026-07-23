'use client';

import { AlertCircle, Loader2, Lock } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AuthCanvasCard } from '@/components/auth/auth-canvas-card';
import { FormBanner } from '@/components/auth/form-controls';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
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
 * // TODO(recovery redeem): allow a one-time recovery code as an alternative to a
 * // TOTP code here (backend redeem path against mfa_recovery_codes). Enrollment +
 * // the primary TOTP challenge are the launch gate; recovery redeem is a follow-up.
 */
export default function MfaChallengePage() {
  const router = useRouter();
  const supabase = createClient();

  const [factorId, setFactorId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

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
        setLoadError(
          'We couldn’t find an authenticator on your account. Ask an admin to reset your MFA.',
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
      } catch {
        setVerifyError('Something went wrong verifying that code. Try again.');
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

        {!factorId && !loadError && (
          <div className="flex items-center justify-center gap-2 py-14 text-text-secondary">
            <Loader2 size={18} className="animate-spin" />
            <span className="text-sm">Loading your authenticator…</span>
          </div>
        )}

        {factorId && (
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
