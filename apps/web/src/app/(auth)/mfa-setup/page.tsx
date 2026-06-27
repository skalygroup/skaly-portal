'use client';

import { AlertCircle, Check, Copy, Download, Loader2, Lock } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { MfaEnrollResponse } from '@skaly/shared/schemas/auth';

import { AuthCanvasCard } from '@/components/auth/auth-canvas-card';
import { FormBanner } from '@/components/auth/form-controls';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { api, ApiError } from '@/lib/api';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

type Enrollment = MfaEnrollResponse;

/**
 * Admin/manager MFA enrollment (Sprint 1 STEP 13, AUTH-MATRIX §10), redesigned
 * on the brand canvas.
 *
 * On mount we POST /v1/auth/mfa/enroll to register a TOTP factor and mint the
 * recovery codes; the user scans the QR (or types the secret), and the 6-digit
 * code auto-verifies on the final digit. We verify the code against the user's
 * own Supabase session (the admin SDK can't validate it server-side), then call
 * /v1/auth/mfa/verify to flip staff.mfa_enrolled. Recovery codes are shown once,
 * gated behind an "I've saved these" acknowledgement before entering the portal.
 *
 * Backing out before verifying leaves the unverified factor in Supabase but
 * mfa_enrolled stays false — the next login re-routes here.
 */
export default function MfaSetupPage() {
  const router = useRouter();
  const supabase = createClient();

  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'enroll' | 'recovery'>('enroll');
  const [savedAck, setSavedAck] = useState(false);
  const [copied, setCopied] = useState<'' | 'secret' | 'codes'>('');

  // Enrollment is a one-shot side effect; guard against React StrictMode's
  // double-invoke so we don't register two factors / two recovery-code sets.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    (async () => {
      try {
        const data = await api<MfaEnrollResponse>('/v1/auth/mfa/enroll', { method: 'POST' });
        setEnrollment(data);
      } catch (err) {
        // The installed admin SDK may not expose server-side enroll (501); fall
        // back to enrolling via the user's own Supabase session. Recovery codes
        // aren't minted on that path — the page handles an empty list.
        if (err instanceof ApiError && err.status === 501) {
          const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
          if (error || !data) {
            setEnrollError('Could not start MFA setup. Refresh to try again.');
            return;
          }
          setEnrollment({
            factorId: data.id,
            qrCodeDataUrl: data.totp.qr_code,
            secret: data.totp.secret,
            recoveryCodes: [],
          });
          return;
        }
        setEnrollError('Could not start MFA setup. Refresh to try again.');
      }
    })();
  }, [supabase]);

  const verify = useCallback(
    async (sixDigits: string) => {
      if (!enrollment || verifying) return;
      setVerifying(true);
      setVerifyError(null);

      try {
        // Validate the TOTP against the user's session — the admin SDK can't, so
        // this client challenge+verify is the real gate. A wrong code errors here.
        const challenge = await supabase.auth.mfa.challenge({ factorId: enrollment.factorId });
        if (challenge.error || !challenge.data) {
          setVerifyError('Incorrect code. Try again.');
          setCode('');
          return;
        }
        const { error: verifyErr } = await supabase.auth.mfa.verify({
          factorId: enrollment.factorId,
          challengeId: challenge.data.id,
          code: sixDigits,
        });
        if (verifyErr) {
          setVerifyError('Incorrect code. Try again.');
          setCode('');
          return;
        }

        // Code is good — record it server-side (flips staff.mfa_enrolled).
        await api('/v1/auth/mfa/verify', {
          method: 'POST',
          body: JSON.stringify({ factorId: enrollment.factorId, code: sixDigits }),
        });

        setPhase('recovery');
      } catch {
        setVerifyError('Something went wrong verifying that code. Try again.');
        setCode('');
      } finally {
        setVerifying(false);
      }
    },
    [enrollment, supabase, verifying],
  );

  // Auto-submit on the 6th digit (RULES: no extra submit button).
  function onCodeChange(value: string) {
    setCode(value);
    setVerifyError(null);
    if (value.length === 6) void verify(value);
  }

  async function copy(text: string, key: 'secret' | 'codes') {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard can be blocked (insecure context / permissions) — no-op.
    }
    setCopied(key);
    setTimeout(() => setCopied(''), 1600);
  }

  function downloadCodes() {
    if (!enrollment) return;
    const body = [
      'Skaly Business Portal — Recovery Codes',
      '',
      ...enrollment.recoveryCodes,
      '',
      'Keep these safe. Each code can be used once.',
      '',
    ].join('\n');
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'skaly-recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── Recovery codes step ────────────────────────────────────────────────
  if (phase === 'recovery' && enrollment) {
    const hasCodes = enrollment.recoveryCodes.length > 0;
    return (
      <AuthCanvasCard
        eyebrow="Setup complete"
        title="You’re protected"
        subtitle="One more thing before you head in — keep your recovery codes safe."
        maxWidth={560}
        footerRight="Two-factor authentication"
        badge={<SecureBadge />}
      >
        <div className="flex flex-col gap-5 px-8 pb-[30px] pt-[26px] [animation:skPop_0.25s_ease_both]">
          <FormBanner variant="success">
            Two-factor authentication is now active on your account.
          </FormBanner>

          <div className="flex flex-col gap-1.5">
            <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-text-primary">
              Save your recovery codes
            </h2>
            <p className="text-[13.5px] leading-[1.55] text-text-secondary">
              {hasCodes ? (
                <>
                  Each code works once if you lose your authenticator. Store them somewhere safe —{' '}
                  <strong className="font-semibold text-[#E4E4E7]">they won’t be shown again.</strong>
                </>
              ) : (
                'MFA is active. If you lose your device, ask an admin to reset your MFA.'
              )}
            </p>
          </div>

          {hasCodes && (
            <>
              <pre className="m-0 grid grid-cols-2 gap-x-6 gap-y-3.5 overflow-x-auto rounded-xl border border-[#232329] bg-[#101013] p-[18px] font-[family-name:var(--font-mono)] text-sm leading-none text-[#E4E4E7]">
                {enrollment.recoveryCodes.map((rc) => (
                  <span key={rc} className="tracking-[0.12em] text-[#D4D4D8]">
                    {rc}
                  </span>
                ))}
              </pre>

              <div className="flex flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={() => copy(enrollment.recoveryCodes.join('\n'), 'codes')}
                  className="flex h-10 items-center gap-[7px] rounded-[9px] border border-border-default bg-bg-elevated px-4 text-[13.5px] font-semibold text-[#E4E4E7] transition-colors hover:border-accent-gold hover:bg-bg-hover"
                >
                  {copied === 'codes' ? (
                    <Check size={15} className="text-accent-gold" />
                  ) : (
                    <Copy size={15} />
                  )}
                  {copied === 'codes' ? 'Copied all' : 'Copy all'}
                </button>
                <button
                  type="button"
                  onClick={downloadCodes}
                  className="flex h-10 items-center gap-[7px] rounded-[9px] border border-border-default bg-bg-elevated px-4 text-[13.5px] font-semibold text-[#E4E4E7] transition-colors hover:border-accent-gold hover:bg-bg-hover"
                >
                  <Download size={15} />
                  Download .txt
                </button>
              </div>

              <label className="flex cursor-pointer items-start gap-[11px] rounded-xl border border-[#232329] bg-[#101013] px-4 py-3.5">
                <input
                  type="checkbox"
                  checked={savedAck}
                  onChange={(e) => setSavedAck(e.target.checked)}
                  className="peer sr-only"
                />
                <span className="mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md border-[1.5px] border-border-strong transition-colors peer-checked:border-accent-gold peer-checked:bg-accent-gold">
                  {savedAck && <Check size={14} strokeWidth={3} className="text-bg-base" />}
                </span>
                <span className="text-sm leading-[1.45] text-[#D4D4D8]">
                  I’ve saved my recovery codes somewhere secure.
                </span>
              </label>
            </>
          )}

          <button
            type="button"
            disabled={hasCodes && !savedAck}
            onClick={() => router.push('/')}
            className="h-12 rounded-[10px] text-[15px] font-bold transition-[filter] enabled:bg-accent-gold enabled:text-bg-base enabled:hover:brightness-[1.06] disabled:cursor-not-allowed disabled:bg-bg-selected disabled:text-text-muted"
          >
            Continue to portal
          </button>
        </div>
      </AuthCanvasCard>
    );
  }

  // ── Enroll + verify step ───────────────────────────────────────────────
  return (
    <AuthCanvasCard
      eyebrow="Two-factor authentication"
      title="Secure your account"
      subtitle="Add an authenticator app so only you can sign in, even if your password is ever compromised."
      maxWidth={560}
      footerRight="Two-factor authentication"
      badge={<SecureBadge />}
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
                {/* QR is a data: URL from the API (not a static asset), so next/image
                    can't optimise it — a plain <img> is correct here. */}
                <img
                  src={enrollment.qrCodeDataUrl}
                  alt="MFA QR code"
                  width={184}
                  height={184}
                  className="h-[184px] w-[184px]"
                />
              </div>
              <div className="flex min-w-[200px] flex-1 flex-col gap-2">
                <StepBadge n={1} label="Scan to add" />
                <p className="text-sm leading-[1.55] text-[#D4D4D8]">
                  Open your authenticator app — Google Authenticator, 1Password, Authy — and scan this
                  code to register the Skaly portal.
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
                  onClick={() => copy(enrollment.secret, 'secret')}
                  aria-label="Copy setup code"
                  className="flex h-[34px] shrink-0 items-center gap-1.5 rounded-lg border border-border-default bg-bg-elevated px-3 text-[12.5px] font-semibold text-[#E4E4E7] transition-colors hover:border-accent-gold hover:bg-bg-hover"
                >
                  {copied === 'secret' ? (
                    <Check size={14} className="text-accent-gold" />
                  ) : (
                    <Copy size={14} />
                  )}
                  {copied === 'secret' ? 'Copied' : 'Copy'}
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
                containerClassName={cn(verifying && 'pointer-events-none', verifyError && '[animation:skShake_0.4s]')}
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
                  The code refreshes every 30 seconds — setup completes automatically once all six
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

/** Small "Secure" pill shown in the card header for the MFA flow. */
function SecureBadge() {
  return (
    <span className="flex items-center gap-[7px] font-[family-name:var(--font-mono)] text-[10px] tracking-[0.06em] text-border-strong">
      <Lock size={13} strokeWidth={1.8} className="text-accent-gold" />
      Secure
    </span>
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
