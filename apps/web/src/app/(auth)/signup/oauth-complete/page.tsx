'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';
import { Loader2, Phone } from 'lucide-react';
import { SignupRequestSchema } from '@skaly/shared/schemas/auth';
import { createClient } from '@/lib/supabase/client';
import { api, ApiError } from '@/lib/api';
import {
  buildSignupFormData,
  validateCvFile,
  CV_ACCEPT,
  ROLE_OPTIONS,
} from '@/lib/signup-form';
import {
  TextField,
  DateField,
  SelectField,
  TextareaField,
  FileField,
  SubmitButton,
  FormBanner,
} from '@/components/auth/form-controls';

// Only the fields the user still fills in — name/email/googleUid come from the
// Google session.
const OauthRestSchema = SignupRequestSchema.pick({
  dateOfBirth: true,
  mobileNumber: true,
  roleRequested: true,
  message: true,
});
type OauthRest = z.infer<typeof OauthRestSchema>;

interface OauthProfile {
  name: string;
  email: string;
  googleUid: string;
}

const today = new Date().toISOString().slice(0, 10);

export default function OAuthCompletePage() {
  const router = useRouter();
  const supabase = createClient();
  const [profile, setProfile] = useState<OauthProfile | null>(null);
  const profileRef = useRef<OauthProfile | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [cv, setCv] = useState<File | null>(null);
  const [cvError, setCvError] = useState<string | undefined>();
  const [alreadyExists, setAlreadyExists] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<OauthRest>({
    resolver: zodResolver(OauthRestSchema),
    defaultValues: { dateOfBirth: '', mobileNumber: '', roleRequested: 'team_member', message: '' },
  });

  // Read the OAuth session (the browser client auto-exchanges the code in the
  // URL). getSession may resolve before that completes, so we also listen for
  // the SIGNED_IN event, with a timeout fallback.
  useEffect(() => {
    let active = true;
    const set = (user: User) => {
      const p: OauthProfile = {
        name:
          (user.user_metadata?.full_name as string) ||
          (user.user_metadata?.name as string) ||
          '',
        email: user.email ?? '',
        googleUid: user.id,
      };
      profileRef.current = p;
      if (active) setProfile(p);
    };

    supabase.auth.getSession().then(({ data }: { data: { session: Session | null } }) => {
      if (data.session?.user && active && !profileRef.current) set(data.session.user);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
      if (session?.user && active && !profileRef.current) set(session.user);
    });
    const timeout = setTimeout(() => {
      if (active && !profileRef.current) setLoadError(true);
    }, 7000);

    return () => {
      active = false;
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [supabase]);

  const messageLen = (watch('message') ?? '').length;

  function onCvChange(file: File | null) {
    setCv(file);
    setCvError(file ? validateCvFile(file) ?? undefined : undefined);
  }

  async function onSubmit(rest: OauthRest) {
    if (!profile) return;
    setAlreadyExists(false);
    if (cv) {
      const err = validateCvFile(cv);
      if (err) {
        setCvError(err);
        return;
      }
    }

    try {
      await api('/v1/auth/signup/request', {
        method: 'POST',
        body: buildSignupFormData(
          {
            name: profile.name,
            email: profile.email,
            googleUid: profile.googleUid,
            ...rest,
          },
          cv,
        ),
      });
    } catch (err) {
      // Always tear down the OAuth session below; surface the known case first.
      if (err instanceof ApiError && err.code === 'ALREADY_PROCESSED') {
        await supabase.auth.signOut();
        setAlreadyExists(true);
        return;
      }
      setError('root', { message: 'Something went wrong submitting your request. Try again.' });
      return;
    }

    // CRITICAL (APPFLOW §2.6): a partially-onboarded user must NOT keep a live
    // session — they can't enter the portal until an admin approves them.
    await supabase.auth.signOut();
    router.push(
      `/signup/pending?email=${encodeURIComponent(profile.email)}&role=${rest.roleRequested}`,
    );
  }

  if (loadError) {
    return (
      <div className="w-full">
        <h1 className="mb-3 font-[family-name:var(--font-display)] text-[28px] font-bold text-text-primary">
          Sign-in expired
        </h1>
        <FormBanner className="mb-5">
          We couldn&apos;t read your Google sign-in. Please start again.
        </FormBanner>
        <Link
          href="/signup"
          className="inline-flex h-[46px] w-full items-center justify-center rounded-md bg-accent-gold text-[15px] font-semibold text-bg-base hover:bg-accent-gold-hover"
        >
          Back to sign-up
        </Link>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="flex w-full items-center justify-center py-20 text-text-muted">
        <Loader2 size={20} className="animate-spin" />
        <span className="ml-2.5 text-sm">Reading your Google account…</span>
      </div>
    );
  }

  return (
    <div className="w-full py-2">
      <div className="mb-7">
        <h1 className="font-[family-name:var(--font-display)] text-[34px] font-bold leading-[1.05] text-text-primary">
          Almost there
        </h1>
        <p className="mt-1.5 text-sm text-text-muted">
          We pulled your name and email from Google. Add a few details to finish.
        </p>
      </div>

      {alreadyExists && (
        <FormBanner className="mb-5">
          An account or request already exists for this email.{' '}
          <Link href="/login" className="font-semibold underline underline-offset-2">
            Sign in →
          </Link>
        </FormBanner>
      )}
      {errors.root?.message && <FormBanner className="mb-5">{errors.root.message}</FormBanner>}

      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        {/* Read-only, from Google */}
        <TextField id="name" label="Full name" value={profile.name} readOnly disabled />
        <TextField id="email" label="Email" value={profile.email} readOnly disabled />

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

        <SelectField
          label="Role requested"
          options={ROLE_OPTIONS}
          disabled={isSubmitting}
          error={errors.roleRequested?.message}
          {...register('roleRequested')}
        />

        <TextareaField
          label="Message (optional)"
          placeholder="Anything we should know about your request?"
          maxLength={500}
          count={{ current: messageLen, max: 500 }}
          disabled={isSubmitting}
          error={errors.message?.message}
          {...register('message')}
        />

        <FileField
          label="CV (optional)"
          id="cv"
          value={cv}
          onChange={onCvChange}
          accept={CV_ACCEPT}
          hint="PDF, DOC, or DOCX — up to 5 MB."
          error={cvError}
          disabled={isSubmitting}
        />

        <SubmitButton loading={isSubmitting} disabled={isSubmitting}>
          Submit request
        </SubmitButton>
      </form>
    </div>
  );
}
