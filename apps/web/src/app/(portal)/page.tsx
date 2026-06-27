import { getStaffMe } from '@/lib/get-staff-me';

// Reads the session cookie to greet by name — must render per request, never
// be statically cached across users.
export const dynamic = 'force-dynamic';

/**
 * Post-login home (Sprint 1 placeholder). The middleware guarantees a session
 * before this renders, so we just greet the user by name. Sprint 11 replaces
 * this with the real module dashboard.
 */
export default async function PortalHomePage() {
  const me = await getStaffMe();
  const firstName = me?.name?.split(' ')[0] ?? 'there';

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-8 py-16">
      <p className="font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[0.18em] text-text-muted">
        Skaly Business Portal
      </p>
      <h1 className="mt-3 font-[family-name:var(--font-display)] text-[clamp(2rem,6vw,3rem)] font-extrabold leading-[0.98] tracking-[-0.01em] text-text-primary">
        Welcome, {firstName}
        <span className="text-accent-gold">.</span>
      </h1>
      <p className="mt-4 max-w-xl text-[15px] leading-[1.6] text-text-secondary">
        You&apos;re signed in. Module dashboards arrive in Sprint 11 — until then this is your
        landing pad.
      </p>
    </div>
  );
}
