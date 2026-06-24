import Image from 'next/image';
import { CalendarCheck, Camera, UserRoundCheck, type LucideIcon } from 'lucide-react';

/**
 * Left brand panel for the auth split-screen (redesign — docs login kit).
 * Black field with a gold-tint radial wash and a faded dot grid, the Skaly
 * monogram + wordmark, the "Operations, organised." pitch, three product
 * highlights, and a mono footer. Hidden below md (the layout shows the form
 * full-width on mobile).
 */
const FEATURES: { icon: LucideIcon; lead: string; rest: string }[] = [
  { icon: CalendarCheck, lead: 'Content calendar', rest: 'across all clients at a glance' },
  { icon: Camera, lead: 'Shoot planning', rest: 'with assignees and slots' },
  { icon: UserRoundCheck, lead: 'Attendance & tasks', rest: 'tracked in real time' },
];

export function BrandPanel() {
  return (
    <div className="relative flex h-full flex-col justify-between overflow-hidden bg-bg-base px-14 py-11">
      {/* Gold-tint radial wash (decorative) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 90% at 8% 6%, rgba(253,194,87,0.10) 0%, rgba(253,194,87,0) 42%),' +
            'radial-gradient(90% 70% at 100% 100%, rgba(253,194,87,0.05) 0%, rgba(253,194,87,0) 50%)',
        }}
      />
      {/* Faint dot grid, faded toward the bottom */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.035) 1px, transparent 1px)',
          backgroundSize: '26px 26px',
          WebkitMaskImage: 'linear-gradient(180deg, #000 0%, transparent 78%)',
          maskImage: 'linear-gradient(180deg, #000 0%, transparent 78%)',
        }}
      />

      {/* Logo */}
      <div className="relative flex items-center gap-4">
        <Image
          src="/brand/skaly-mark.svg"
          alt="Skaly"
          width={56}
          height={56}
          priority
          unoptimized
          className="rounded-[14px]"
        />
        <span className="h-10 w-px bg-border-default" />
        <div className="flex flex-col">
          <span className="font-[family-name:var(--font-display)] text-2xl font-bold leading-none tracking-tight text-accent-gold">
            SKALY
          </span>
          <span className="mt-1.5 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[0.14em] text-text-muted">
            Business Portal
          </span>
        </div>
      </div>

      {/* Pitch + highlights */}
      <div className="relative max-w-[440px]">
        <h1 className="font-[family-name:var(--font-display)] text-[clamp(2.75rem,5vw,3.75rem)] font-extrabold leading-[0.98] tracking-tight text-text-primary">
          Operations,
          <br />
          <span className="text-accent-gold">organised.</span>
        </h1>
        <p className="mt-[18px] max-w-[400px] text-[15px] leading-relaxed text-text-secondary">
          Attendance, shoots, content pipelines and chat — every team, every client, every day, in
          one dark, fast workspace.
        </p>
        <div className="mt-7 flex flex-col gap-3.5">
          {FEATURES.map(({ icon: Icon, lead, rest }) => (
            <div key={lead} className="flex items-center gap-3.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-accent-gold/15 text-accent-gold">
                <Icon size={18} />
              </span>
              <span className="text-[13.5px] text-text-secondary">
                <b className="font-semibold text-text-primary">{lead}</b> {rest}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="relative flex items-center justify-between font-[family-name:var(--font-mono)] text-[11px] text-text-muted">
        <span>
          Skaly Group <span className="text-text-disabled">·</span> Internal Portal
        </span>
        <span>v2.1</span>
      </div>
    </div>
  );
}
