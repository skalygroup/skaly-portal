'use client';

import { Loader2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';

import type { AuthError, EmailOtpType } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/client';

/**
 * Email-link verification endpoint (Supabase token_hash flow). The recovery /
 * invite / confirmation emails point here instead of straight at Supabase's
 * /auth/v1/verify, and verification runs CLIENT-SIDE in the effect below.
 *
 * Why: Supabase's one-time email tokens are single-use, and mail providers
 * (Gmail, Outlook, corporate security gateways) pre-fetch links to scan them —
 * that GET would consume the token, so the user's real click lands on
 * `otp_expired`. A scanner's GET here only renders the loading shell; it does
 * not run this JS, so the token survives until the human's browser executes it.
 *
 * On success we forward to `next` (e.g. /reset-password) with a `confirmed=1`
 * marker so the destination knows a fresh, real verification just happened.
 */
function ConfirmInner() {
  const router = useRouter();
  const params = useSearchParams();
  const ran = useRef(false);

  useEffect(() => {
    // Verify exactly once — the token is single-use; a double-invoke would burn it.
    if (ran.current) return;
    ran.current = true;

    const tokenHash = params.get('token_hash');
    const type = (params.get('type') ?? 'email') as EmailOtpType;
    const next = params.get('next') ?? '/';
    // Recovery failures belong on the reset page (which shows the expired state);
    // everything else (invite/signup/email change) belongs back at login.
    const failDest =
      type === 'recovery' ? '/reset-password?error=link_invalid' : '/login?error=link_invalid';

    if (!tokenHash) {
      router.replace(failDest);
      return;
    }

    createClient()
      .auth.verifyOtp({ type, token_hash: tokenHash })
      .then(({ error }: { error: AuthError | null }) => {
        if (error) {
          router.replace(failDest);
          return;
        }
        const sep = next.includes('?') ? '&' : '?';
        router.replace(`${next}${sep}confirmed=1`);
      });
  }, [params, router]);

  return (
    <div className="flex min-h-screen items-center justify-center gap-2 bg-bg-base text-text-secondary">
      <Loader2 size={18} className="animate-spin" />
      <span className="text-sm">Confirming your link…</span>
    </div>
  );
}

export default function ConfirmPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bg-base" />}>
      <ConfirmInner />
    </Suspense>
  );
}
