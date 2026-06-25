'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Mail, User, Phone } from 'lucide-react';
import { SignupRequestSchema, type SignupRequestInput } from '@skaly/shared/schemas/auth';
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
  GoogleButton,
  FormBanner,
} from '@/components/auth/form-controls';

const today = new Date().toISOString().slice(0, 10);

export default function SignupPage() {
  const router = useRouter();
  const supabase = createClient();
  const [oauthPending, setOauthPending] = useState(false);
  const [cv, setCv] = useState<File | null>(null);
  const [cvError, setCvError] = useState<string | undefined>();
  const [alreadyExists, setAlreadyExists] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SignupRequestInput>({
    resolver: zodResolver(SignupRequestSchema),
    defaultValues: {
      name: '',
      email: '',
      dateOfBirth: '',
      mobileNumber: '',
      roleRequested: 'team_member',
      message: '',
    },
  });

  const messageLen = (watch('message') ?? '').length;

  function onCvChange(file: File | null) {
    setCv(file);
    setCvError(file ? validateCvFile(file) ?? undefined : undefined);
  }

  async function onSubmit(values: SignupRequestInput) {
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
        body: buildSignupFormData(values, cv),
      });
      router.push(
        `/signup/pending?email=${encodeURIComponent(values.email)}&role=${values.roleRequested}`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ALREADY_PROCESSED') {
        setAlreadyExists(true);
        return;
      }
      setError('root', { message: 'Something went wrong submitting your request. Try again.' });
    }
  }

  async function onGoogle() {
    setOauthPending(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/signup/oauth-complete' },
    });
    if (error) {
      setOauthPending(false);
      setError('root', { message: 'Could not start Google sign-up. Try again.' });
    }
  }

  const busy = isSubmitting || oauthPending;

  return (
    <div className="w-full py-2">
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
          Request access
        </h1>
        <p className="mt-1.5 text-sm text-text-muted">
          Tell us a little about you. An admin reviews every request.
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

      {/* PATH A — Google */}
      <GoogleButton onClick={onGoogle} loading={oauthPending} disabled={busy}>
        Continue with Google
      </GoogleButton>

      {/* Divider */}
      <div className="my-[22px] flex items-center gap-3.5">
        <span className="h-px flex-1 bg-border-subtle" />
        <span className="font-[family-name:var(--font-mono)] text-[11px] tracking-[0.1em] text-text-muted">
          OR FILL IN THE FORM
        </span>
        <span className="h-px flex-1 bg-border-subtle" />
      </div>

      {/* PATH B — form */}
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <TextField
          label="Full name"
          icon={<User size={16} aria-hidden />}
          placeholder="Jane Doe"
          autoComplete="name"
          disabled={busy}
          error={errors.name?.message}
          {...register('name')}
        />

        <TextField
          label="Email"
          type="email"
          icon={<Mail size={16} aria-hidden />}
          placeholder="you@skalygroup.com"
          autoComplete="email"
          disabled={busy}
          error={errors.email?.message}
          {...register('email')}
        />

        <DateField
          label="Date of birth"
          max={today}
          disabled={busy}
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
          disabled={busy}
          error={errors.mobileNumber?.message}
          {...register('mobileNumber')}
        />

        <SelectField
          label="Role requested"
          options={ROLE_OPTIONS}
          disabled={busy}
          error={errors.roleRequested?.message}
          {...register('roleRequested')}
        />

        <TextareaField
          label="Message (optional)"
          placeholder="Anything we should know about your request?"
          maxLength={500}
          count={{ current: messageLen, max: 500 }}
          disabled={busy}
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
          disabled={busy}
        />

        <SubmitButton loading={isSubmitting} disabled={busy}>
          Submit request
        </SubmitButton>
      </form>

      <p className="mt-[26px] text-center text-[13.5px] text-text-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-semibold text-accent-gold hover:text-accent-gold-hover">
          Sign in
        </Link>
      </p>
    </div>
  );
}
