'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { SignupRequestSchema, type SignupRequestInput } from '@skaly/shared/schemas/auth';
import { Mail, User, Phone } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { AuthBackdrop } from '@/components/auth/auth-backdrop';
import { DatePickerField } from '@/components/auth/date-picker-field';
import {
  TextField,
  TextareaField,
  FileField,
  SubmitButton,
  GoogleButton,
  FormBanner,
} from '@/components/auth/form-controls';
import { SelectMenuField } from '@/components/auth/select-menu-field';
import { api, ApiError } from '@/lib/api';
import { currentIstDate } from '@/lib/hooks/use-month-context';
import { buildSignupFormData, validateCvFile, CV_ACCEPT, ROLE_OPTIONS } from '@/lib/signup-form';
import { createClient } from '@/lib/supabase/client';


// Display the mobile as the user types (+CC then grouped digits); the form
// value stays the schema-shaped raw `+<digits>` (no spaces).
function formatMobile(digits: string) {
  if (!digits) return '';
  const cc = digits.slice(0, 2);
  const rest = digits.slice(2);
  const groups: string[] = [];
  for (let i = 0; i < rest.length; i += 5) groups.push(rest.slice(i, i + 5));
  return '+' + cc + (groups.length ? ' ' + groups.join(' ') : '');
}

export default function SignupPage() {
  const router = useRouter();
  const supabase = createClient();
  const [oauthPending, setOauthPending] = useState(false);
  const [mobileDisplay, setMobileDisplay] = useState('');
  const [cv, setCv] = useState<File | null>(null);
  const [cvError, setCvError] = useState<string | undefined>();
  const [alreadyExists, setAlreadyExists] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
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

  const dob = watch('dateOfBirth');
  const role = watch('roleRequested');
  const messageLen = (watch('message') ?? '').length;

  function onCvChange(file: File | null) {
    setCv(file);
    setCvError(file ? validateCvFile(file) ?? undefined : undefined);
  }

  function onMobileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 14);
    setMobileDisplay(formatMobile(digits));
    setValue('mobileNumber', digits ? '+' + digits : '', { shouldValidate: !!errors.mobileNumber });
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
      await api('/v1/auth/signup/request', { method: 'POST', body: buildSignupFormData(values, cv) });
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
    // Full-canvas takeover — the redesign is a single-column card on the brand
    // canvas, so it escapes the split-screen auth layout via a fixed overlay.
    <div className="dark sk-page fixed inset-0 z-20 overflow-y-auto bg-bg-base text-text-primary">
      <div className="pointer-events-none fixed inset-0">
        <AuthBackdrop variant="aurora" />
      </div>

      <div className="relative flex min-h-full flex-col items-center justify-center gap-6 px-5 py-14">
        <main className="w-full max-w-[600px] animate-[skRise_0.5s_cubic-bezier(0.2,0.7,0.2,1)_both]">
          <div className="sk-card relative rounded-[18px] border border-border-subtle bg-bg-surface shadow-[0_1px_0_rgba(255,255,255,0.03)_inset,0_30px_70px_-30px_rgba(0,0,0,0.85)] transition-[box-shadow,border-color] duration-200 hover:border-[#34343B] hover:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_36px_80px_-30px_rgba(0,0,0,0.9),0_0_0_1px_rgba(253,194,87,0.12)]">
            {/* Gold hairline */}
            <div
              aria-hidden
              className="absolute left-6 right-6 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(253,194,87,0.55),transparent)]"
            />

            {/* Header */}
            <header className="rounded-t-[18px] border-b border-[#232329] bg-[linear-gradient(180deg,#17171B_0%,#141417_100%)] px-8 pb-6 pt-[30px]">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3.5">
                  <Image
                    src="/brand/skaly-logo.png"
                    alt="Skaly Group"
                    width={46}
                    height={46}
                    priority
                    unoptimized
                    className="sk-logo shrink-0 rounded-full transition-[filter] duration-200 hover:drop-shadow-[0_0_12px_rgba(253,194,87,0.55)]"
                  />
                  <span className="h-[34px] w-px bg-border-default" />
                  <span className="flex flex-col leading-none">
                    <span className="font-[family-name:var(--font-display)] text-xl font-bold tracking-[0.01em] text-text-primary">
                      Business Portal
                    </span>
                    <span className="mt-1.5 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.16em] text-text-muted">
                      Operations platform
                    </span>
                  </span>
                </div>
                <span className="font-[family-name:var(--font-mono)] text-[11px] tracking-[0.06em] text-border-strong">
                  v2.1
                </span>
              </div>

              <div className="mt-6 flex items-center gap-2.5">
                <span className="h-1.5 w-1.5 rounded-full bg-accent-gold shadow-[0_0_10px_rgba(253,194,87,0.7)]" />
                <span className="font-[family-name:var(--font-mono)] text-[10.5px] uppercase tracking-[0.18em] text-text-secondary">
                  Request access
                </span>
              </div>
              <h1 className="mt-2.5 font-[family-name:var(--font-display)] text-[clamp(2rem,7vw,2.6rem)] font-extrabold leading-[0.96] tracking-[-0.01em] text-text-primary">
                Join the workspace<span className="text-accent-gold">.</span>
              </h1>
              <p className="mt-3.5 max-w-[440px] text-[14.5px] leading-[1.55] text-text-secondary">
                Tell us a little about you. An admin reviews every request — you&apos;ll get an email
                the moment you&apos;re approved.
              </p>
            </header>

            {/* Form */}
            {/* method="post" so a pre-hydration native submit cannot put the password
                in the query string — see the note on the login form. */}
            <form onSubmit={handleSubmit(onSubmit)} method="post" noValidate className="flex flex-col gap-[18px] px-8 pb-[30px] pt-[26px]">
              {alreadyExists && (
                <FormBanner>
                  An account or request already exists for this email.{' '}
                  <Link href="/login" className="font-semibold underline underline-offset-2">
                    Sign in →
                  </Link>
                </FormBanner>
              )}
              {errors.root?.message && <FormBanner>{errors.root.message}</FormBanner>}

              {/* PATH A — Google */}
              <GoogleButton onClick={onGoogle} loading={oauthPending} disabled={busy}>
                Continue with Google
              </GoogleButton>
              <div className="flex items-center gap-3.5">
                <span className="h-px flex-1 bg-border-subtle" />
                <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.17em] text-text-muted">
                  Or fill in the form
                </span>
                <span className="h-px flex-1 bg-border-subtle" />
              </div>

              {/* PATH B — form */}
              <div className="grid grid-cols-1 items-start gap-[18px] sm:grid-cols-2">
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
              </div>

              <div className="grid grid-cols-1 items-start gap-[18px] sm:grid-cols-2">
                <DatePickerField
                  label="Date of birth"
                  value={dob}
                  onChange={(v) => setValue('dateOfBirth', v, { shouldValidate: !!errors.dateOfBirth })}
                  max={currentIstDate()}
                  disabled={busy}
                  error={errors.dateOfBirth?.message}
                />
                <TextField
                  id="mobileNumber"
                  label="Mobile number"
                  type="tel"
                  inputMode="tel"
                  icon={<Phone size={16} aria-hidden />}
                  placeholder="+91 98765 43210"
                  hint="Include your country code, e.g. +91 for India."
                  value={mobileDisplay}
                  onChange={onMobileChange}
                  disabled={busy}
                  error={errors.mobileNumber?.message}
                />
              </div>

              <SelectMenuField
                label="Role requested"
                value={role}
                onChange={(v) =>
                  setValue('roleRequested', v as SignupRequestInput['roleRequested'], {
                    shouldValidate: true,
                  })
                }
                options={ROLE_OPTIONS}
                disabled={busy}
                error={errors.roleRequested?.message}
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

              <p className="mt-0.5 text-center text-sm text-text-secondary">
                Already have an account?{' '}
                <Link
                  href="/login"
                  className="sk-link-cta font-semibold text-accent-gold transition-colors hover:text-accent-gold-hover"
                >
                  Sign in
                </Link>
              </p>
            </form>
          </div>

          <footer className="mt-5 flex items-center justify-center gap-2 font-[family-name:var(--font-mono)] text-[11px] text-border-strong">
            <span>Skaly Group</span>
            <span className="text-text-disabled">·</span>
            <span>Internal Portal</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
