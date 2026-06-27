import Image from 'next/image';

/**
 * Left brand panel for the auth split-screen (redesign — docs login kit).
 * Black field with a gold-tint radial wash and a faded dot grid, the circular
 * Skaly logo paired with the "Business Portal / Operations platform" lockup,
 * the "Operations, organised." pitch, and a mono footer. Hidden below md (the
 * layout shows the form full-width on mobile).
 */
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
          src="/brand/skaly-logo.png"
          alt="Skaly Group"
          width={78}
          height={78}
          priority
          unoptimized
          className="shrink-0"
        />
        <span className="h-10 w-px bg-border-default" />
        <div className="flex flex-col">
          <span className="font-[family-name:var(--font-display)] text-2xl font-bold leading-none tracking-[0.01em] text-text-primary">
            Business Portal
          </span>
          <span className="mt-1.5 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[0.14em] text-text-muted">
            Operations platform
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
