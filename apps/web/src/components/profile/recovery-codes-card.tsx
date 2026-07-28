'use client';

import { AlertTriangle, Check, Copy, Download, KeyRound, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type {
  MfaRecoveryRegenerateResponse,
  MfaRecoveryStatusResponse,
} from '@skaly/shared/schemas/auth';

import { FormBanner } from '@/components/auth/form-controls';
import { api, ApiError } from '@/lib/api';

/**
 * Profile → recovery codes (Sprint 11 STEP 8).
 *
 * Shows how many unconsumed codes are left and regenerates the set. The count is
 * the only thing readable here — there is no endpoint that returns an existing
 * code, because a set of recovery codes readable from a live session is not a
 * second factor. Regenerating is the only way to see codes again, and it costs
 * you the old ones.
 */
export function RecoveryCodesCard() {
  const [remaining, setRemaining] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<MfaRecoveryStatusResponse>('/v1/auth/mfa/recovery');
      setRemaining(data.remainingCodes);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function regenerate() {
    setRegenerating(true);
    setRegenerateError(null);
    try {
      const data = await api<MfaRecoveryRegenerateResponse>('/v1/auth/mfa/recovery/regenerate', {
        method: 'POST',
      });
      setFresh(data.recoveryCodes);
      setRemaining(data.recoveryCodes.length);
      setConfirming(false);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      setRegenerateError(
        code === 'MFA_REQUIRED'
          ? 'Verify with your authenticator first, then try again.'
          : 'Could not regenerate your codes. Try again.',
      );
    } finally {
      setRegenerating(false);
    }
  }

  async function copyAll() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.join('\n'));
    } catch {
      // Clipboard can be blocked (insecure context / permissions) — no-op.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  function download() {
    if (!fresh) return;
    const body = [
      'Skaly Business Portal — Recovery Codes',
      '',
      ...fresh,
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

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border-default bg-bg-elevated p-5">
      <header className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 font-[family-name:var(--font-display)] text-lg font-bold text-text-primary">
          <KeyRound size={18} className="text-accent-gold" />
          Recovery codes
        </h2>
        <p className="text-[13.5px] leading-[1.55] text-text-secondary">
          Single-use codes that get you back in if you lose your authenticator.
        </p>
      </header>

      {loadError ? (
        <FormBanner variant="error">Could not load your recovery codes.</FormBanner>
      ) : remaining === null ? (
        <span className="flex items-center gap-2 text-[13px] text-text-secondary">
          <Loader2 size={15} className="animate-spin" />
          Checking…
        </span>
      ) : (
        <p className="text-sm text-[#D4D4D8]">
          <strong className="font-semibold">{remaining}</strong>{' '}
          {remaining === 1 ? 'code' : 'codes'} remaining.
        </p>
      )}

      {/* The nag. Two codes is not a crisis, but it is the last moment where
          regenerating is a calm decision rather than an urgent one. */}
      {remaining !== null && remaining <= 2 && !fresh && (
        <FormBanner variant="error">
          <span className="flex items-start gap-2">
            <AlertTriangle size={15} className="mt-px shrink-0" />
            You&apos;re nearly out of recovery codes. Regenerate them now so you have a way back
            in if you lose your authenticator.
          </span>
        </FormBanner>
      )}

      {fresh && (
        <div className="flex flex-col gap-3">
          <FormBanner variant="success">
            Your old codes no longer work. Save these —{' '}
            <strong className="font-semibold">they won&apos;t be shown again.</strong>
          </FormBanner>
          <pre className="m-0 grid grid-cols-2 gap-x-6 gap-y-3.5 overflow-x-auto rounded-xl border border-[#232329] bg-[#101013] p-[18px] font-[family-name:var(--font-mono)] text-sm leading-none text-[#E4E4E7]">
            {fresh.map((rc) => (
              <span key={rc} className="tracking-[0.12em] text-[#D4D4D8]">
                {rc}
              </span>
            ))}
          </pre>
          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={() => void copyAll()}
              className="flex h-10 items-center gap-[7px] rounded-[9px] border border-border-default bg-bg-elevated px-4 text-[13.5px] font-semibold text-[#E4E4E7] transition-colors hover:border-accent-gold hover:bg-bg-hover"
            >
              {copied ? <Check size={15} className="text-accent-gold" /> : <Copy size={15} />}
              {copied ? 'Copied all' : 'Copy all'}
            </button>
            <button
              type="button"
              onClick={download}
              className="flex h-10 items-center gap-[7px] rounded-[9px] border border-border-default bg-bg-elevated px-4 text-[13.5px] font-semibold text-[#E4E4E7] transition-colors hover:border-accent-gold hover:bg-bg-hover"
            >
              <Download size={15} />
              Download .txt
            </button>
          </div>
        </div>
      )}

      {regenerateError && <FormBanner variant="error">{regenerateError}</FormBanner>}

      {confirming ? (
        // The confirmation NAMES the consequence. "Are you sure?" is not a
        // confirmation, it is a speed bump — the thing a user needs to know is
        // that the printed sheet in their drawer stops working.
        <div className="flex flex-col gap-3 rounded-xl border border-status-red/30 bg-status-red/5 p-4">
          <p className="text-[13.5px] leading-[1.55] text-[#D4D4D8]">
            Every existing recovery code stops working immediately, including any you have
            printed or saved elsewhere. You&apos;ll get 10 new ones, shown once.
          </p>
          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              disabled={regenerating}
              onClick={() => void regenerate()}
              className="h-10 rounded-[9px] px-4 text-[13.5px] font-bold transition-[filter] enabled:bg-accent-gold enabled:text-bg-base enabled:hover:brightness-[1.06] disabled:cursor-not-allowed disabled:bg-bg-selected disabled:text-text-muted"
            >
              {regenerating ? 'Regenerating…' : 'Yes, replace my codes'}
            </button>
            <button
              type="button"
              disabled={regenerating}
              onClick={() => setConfirming(false)}
              className="h-10 rounded-[9px] border border-border-default px-4 text-[13.5px] font-semibold text-text-secondary transition-colors hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setConfirming(true);
            setRegenerateError(null);
          }}
          className="h-10 self-start rounded-[9px] border border-border-default bg-bg-elevated px-4 text-[13.5px] font-semibold text-[#E4E4E7] transition-colors hover:border-accent-gold hover:bg-bg-hover"
        >
          Regenerate codes
        </button>
      )}
    </section>
  );
}
