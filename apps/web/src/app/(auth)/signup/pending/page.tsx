'use client';

import { CheckCircle2, Clock, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';

import type { SignupStatusResponse } from '@skaly/shared/schemas/auth';

import { FormBanner } from '@/components/auth/form-controls';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/hooks/use-polling';
import { ROLE_OPTIONS } from '@/lib/signup-form';

// APPFLOW §2.6 cadence: 10s → 30s → 60s (then steady), capped at 10 minutes.
const POLL_DELAYS = [10_000, 30_000, 60_000];

function roleLabel(role: string | null) {
  return ROLE_OPTIONS.find((r) => r.value === role)?.label ?? null;
}

function formatTimestamp(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
}

function PendingInner() {
  const router = useRouter();
  const params = useSearchParams();
  const email = params.get('email') ?? '';
  const role = roleLabel(params.get('role'));
  const redirectedRef = useRef(false);

  const fetcher = useCallback(
    () =>
      api<SignupStatusResponse>(
        `/v1/auth/signup-requests/me/status?email=${encodeURIComponent(email)}`,
      ),
    [email],
  );
  const shouldStop = useCallback(
    (d: SignupStatusResponse) => d.status === 'approved' || d.status === 'rejected',
    [],
  );

  const { data, isPolling } = usePolling<SignupStatusResponse>(fetcher, POLL_DELAYS, shouldStop);

  // React to a terminal status. Approved → toast + bounce to login.
  useEffect(() => {
    if (data?.status === 'approved' && !redirectedRef.current) {
      redirectedRef.current = true;
      toast.success('Your account is ready!');
      const t = setTimeout(() => router.push('/login'), 2000);
      return () => clearTimeout(t);
    }
  }, [data?.status, router]);

  if (!email) {
    return (
      <div className="w-full">
        <h1 className="mb-3 font-[family-name:var(--font-display)] text-[28px] font-bold text-text-primary">
          Nothing to show
        </h1>
        <FormBanner variant="info" className="mb-5">
          We don&apos;t have a request to track here.
        </FormBanner>
        <Link
          href="/login"
          className="inline-flex h-[46px] w-full items-center justify-center rounded-md border border-border-default bg-bg-elevated text-[15px] font-semibold text-text-primary hover:border-border-strong hover:bg-bg-hover"
        >
          Back to login
        </Link>
      </div>
    );
  }

  const submittedAt = data?.submittedAt ? formatTimestamp(data.submittedAt) : null;
  const isRejected = data?.status === 'rejected';
  const isApproved = data?.status === 'approved';

  return (
    <div className="w-full py-2">
      {/* Status crest */}
      <div
        className={
          'mb-5 flex h-12 w-12 items-center justify-center rounded-full border ' +
          (isApproved
            ? 'border-status-green/40 bg-status-green/10 text-status-green'
            : isRejected
              ? 'border-status-red/40 bg-status-red/10 text-status-red'
              : 'border-accent-gold/40 bg-[var(--accent-gold-dim)] text-accent-gold')
        }
      >
        {isApproved ? <CheckCircle2 size={22} /> : <Clock size={22} />}
      </div>

      <h1 className="font-[family-name:var(--font-display)] text-[30px] font-bold leading-[1.08] text-text-primary">
        {isApproved ? 'You’re approved!' : isRejected ? 'Request reviewed' : 'Request received'}
      </h1>
      <p className="mt-1.5 text-sm text-text-muted">
        {isApproved
          ? 'Redirecting you to sign in…'
          : isRejected
            ? 'An admin has reviewed your request.'
            : 'Your request is under review. Typically reviewed the same working day.'}
      </p>

      {/* Detail card */}
      <dl className="mt-6 divide-y divide-border-subtle rounded-md border border-border-subtle bg-bg-elevated px-4">
        <div className="flex items-center justify-between py-3">
          <dt className="text-[13px] text-text-muted">Email</dt>
          <dd className="text-[13px] font-medium text-text-primary">{email}</dd>
        </div>
        {role && (
          <div className="flex items-center justify-between py-3">
            <dt className="text-[13px] text-text-muted">Role requested</dt>
            <dd className="text-[13px] font-medium text-text-primary">{role}</dd>
          </div>
        )}
        <div className="flex items-center justify-between py-3">
          <dt className="text-[13px] text-text-muted">Submitted</dt>
          <dd className="text-[13px] font-medium text-text-primary">
            {submittedAt ?? <span className="text-text-muted">—</span>}
          </dd>
        </div>
        <div className="flex items-center justify-between py-3">
          <dt className="text-[13px] text-text-muted">Status</dt>
          <dd className="flex items-center gap-1.5 text-[13px] font-medium text-text-primary">
            {isPolling && !isApproved && !isRejected && (
              <Loader2 size={12} className="animate-spin text-text-muted" aria-hidden />
            )}
            <span className="capitalize">{data?.status ?? 'pending'}</span>
          </dd>
        </div>
      </dl>

      {/* Rejected → public message only. The internal rejectionNote is NEVER
          read here (defense in depth, STEP 7 contract): the only field touched
          is publicRejectionMessage. */}
      {isRejected && (
        <FormBanner className="mt-5">
          {data?.publicRejectionMessage?.trim()
            ? data.publicRejectionMessage
            : 'Your request was not approved.'}
        </FormBanner>
      )}

      {/* Still waiting → reassure that the page keeps checking. */}
      {!isApproved && !isRejected && (
        <p className="mt-5 text-center text-[12px] text-text-muted">
          {isPolling
            ? 'This page checks automatically — keep it open.'
            : 'We’ll stop checking after a while. Refresh to check again.'}
        </p>
      )}

      {/* No "back to sign up" affordance by design: a pending applicant
          re-submitting would create duplicate requests for the admin to review.
          They wait here; the page redirects to /login once approved. */}
    </div>
  );
}

export default function PendingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex w-full items-center justify-center py-20 text-text-muted">
          <Loader2 size={20} className="animate-spin" />
        </div>
      }
    >
      <PendingInner />
    </Suspense>
  );
}
