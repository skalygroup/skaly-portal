'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  SignupViaInviteSchema,
  type InviteCheckResponse,
} from '@skaly/shared/schemas/auth';
import { Loader2, Mail, User, Phone } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import type { z } from 'zod';


import {
  TextField,
  PasswordField,
  DateField,
  SubmitButton,
  FormBanner,
} from '@/components/auth/form-controls';
import { api, ApiError } from '@/lib/api';
import { createClient } from '@/lib/supabase/client';

// Token comes from the URL, not the form.
const InviteFormSchema = SignupViaInviteSchema.omit({ token: true });
type InviteFormInput = z.infer<typeof InviteFormSchema>;

const today = new Date().toISOString().slice(0, 10);

/** Full-page terminal states for an unusable token. */
function InviteErrorPage({ title, body }: { title: string; body: string }) {
  return (
    <div className="w-full">
      <h1 className="mb-3 font-[family-name:var(--font-display)] text-[28px] font-bold leading-tight text-text-primary">
        {title}
      </h1>
      <FormBanner className="mb-5">{body}</FormBanner>
      <Link
        href="/login"
        className="inline-flex h-[46px] w-full items-center justify-center rounded-md border border-border-default bg-bg-elevated text-[15px] font-semibold text-text-primary hover:border-border-strong hover:bg-bg-hover"
      >
        Go to sign in
      </Link>
    </div>
  );
}

function InviteInner() {
  const router = useRouter();
  const supabase = createClient();
  const params = useSearchParams();
  const token = params.get('token') ?? '';

  const [checking, setChecking] = useState(true);
  const [invite, setInvite] = useState<InviteCheckResponse | null>(null);
  const [tokenError, setTokenError] = useState<ApiError | 'missing' | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<InviteFormInput>({
    resolver: zodResolver(InviteFormSchema),
    defaultValues: { name: '', password: '', dateOfBirth: '', mobileNumber: '' },
  });

  // Pre-validate the token on mount so expired/used links fail fast and we can
  // show the scoped email read-only + use it to auto-login after redeem.
  useEffect(() => {
    if (!token) {
      setTokenError('missing');
      setChecking(false);
      return;
    }
    let active = true;
    api<InviteCheckResponse>(`/v1/auth/invite/${encodeURIComponent(token)}/check`)
      .then((res) => active && setInvite(res))
      .catch((err) => active && setTokenError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN')))
      .finally(() => active && setChecking(false));
    return () => {
      active = false;
    };
  }, [token]);

  async function onSubmit(values: InviteFormInput) {
    if (!invite) return;
    try {
      await api('/v1/auth/signup/invite', {
        method: 'POST',
        body: JSON.stringify({ token, ...values }),
      });
    } catch (err) {
      if (err instanceof ApiError) {
        // Token went stale between check and submit → surface as a terminal page.
        if (['INVITE_EXPIRED', 'INVITE_ALREADY_USED', 'INVITE_NOT_FOUND'].includes(err.code)) {
          setTokenError(err);
          return;
        }
        if (err.code === 'ALREADY_PROCESSED') {
          setError('root', { message: 'This account has already been set up. Try signing in.' });
          return;
        }
      }
      setError('root', { message: 'Could not accept the invite. Try again.' });
      return;
    }

    // Created with email_confirm:true (STEP 5) — no confirmation step, so log in
    // immediately with the password just set and enter the portal.
    const { error } = await supabase.auth.signInWithPassword({
      email: invite.email,
      password: values.password,
    });
    if (error) {
      // Account exists; just send them to login to sign in manually.
      router.push('/login');
      return;
    }
    router.push('/');
  }

  if (checking) {
    return (
      <div className="flex w-full items-center justify-center py-20 text-text-muted">
        <Loader2 size={20} className="animate-spin" />
        <span className="ml-2.5 text-sm">Checking your invite…</span>
      </div>
    );
  }

  if (tokenError === 'missing') {
    return (
      <InviteErrorPage
        title="Invalid link"
        body="This invite link is missing its token. The link may be incomplete."
      />
    );
  }
  if (tokenError instanceof ApiError) {
    if (tokenError.code === 'INVITE_EXPIRED') {
      return (
        <InviteErrorPage
          title="Invite expired"
          body="This invite has expired. Contact your admin for a new one."
        />
      );
    }
    if (tokenError.code === 'INVITE_ALREADY_USED') {
      return (
        <InviteErrorPage
          title="Invite already used"
          body="This invite has already been used. Try signing in instead."
        />
      );
    }
    return (
      <InviteErrorPage
        title="Invite not found"
        body="We could not find this invite. The link may be invalid."
      />
    );
  }

  return (
    <div className="w-full py-2">
      <div className="mb-7">
        <h1 className="font-[family-name:var(--font-display)] text-[34px] font-bold leading-[1.05] text-text-primary">
          Accept your invite
        </h1>
        <p className="mt-1.5 text-sm text-text-muted">
          You&apos;ve been invited to the Skaly Business Portal. Set your details to get started.
        </p>
      </div>

      {errors.root?.message && <FormBanner className="mb-5">{errors.root.message}</FormBanner>}

      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        {/* Email — scoped to the invite, read-only */}
        <TextField id="email" label="Email" icon={<Mail size={16} aria-hidden />} value={invite?.email ?? ''} readOnly disabled />

        <TextField
          label="Full name"
          icon={<User size={16} aria-hidden />}
          placeholder="Jane Doe"
          autoComplete="name"
          disabled={isSubmitting}
          error={errors.name?.message}
          {...register('name')}
        />

        <PasswordField
          label="Password"
          placeholder="Create a password"
          autoComplete="new-password"
          hint="At least 10 characters, with upper & lower case, a digit, and a symbol."
          disabled={isSubmitting}
          error={errors.password?.message}
          {...register('password')}
        />

        <DateField
          label="Date of birth"
          max={today}
          disabled={isSubmitting}
          error={errors.dateOfBirth?.message}
          {...register('dateOfBirth')}
        />

        <TextField
          label="Mobile number"
          type="tel"
          icon={<Phone size={16} aria-hidden />}
          placeholder="+919876543210"
          hint="Include your country code, e.g. +91 for India."
          autoComplete="tel"
          disabled={isSubmitting}
          error={errors.mobileNumber?.message}
          {...register('mobileNumber')}
        />

        <SubmitButton loading={isSubmitting} disabled={isSubmitting}>
          Accept invite & continue
        </SubmitButton>
      </form>
    </div>
  );
}

export default function InvitePage() {
  return (
    <Suspense
      fallback={
        <div className="flex w-full items-center justify-center py-20 text-text-muted">
          <Loader2 size={20} className="animate-spin" />
        </div>
      }
    >
      <InviteInner />
    </Suspense>
  );
}
