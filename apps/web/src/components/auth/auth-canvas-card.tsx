'use client';

import Image from 'next/image';
import * as React from 'react';

import { AuthBackdrop } from './auth-backdrop';

/**
 * Shared shell for the focused auth flows (forgot-password, reset-password,
 * mfa-setup) — a single centred card on the Skaly brand canvas. Ported from the
 * Claude Design templates; mirrors the signup redesign's "full-canvas takeover":
 * a fixed overlay that escapes the split-screen (auth) layout so these utility
 * screens stand on their own rather than beside the marketing brand panel.
 *
 * The card chrome (gold hairline, logo + wordmark header, eyebrow/title/subtitle,
 * footer) is identical across the three; pages supply only the per-view eyebrow,
 * title, optional subtitle/badge, and the body that follows the header.
 */
interface AuthCanvasCardProps {
  /** Mono uppercase kicker above the title (e.g. "Account recovery"). */
  eyebrow: string;
  /** Display heading; a gold full-stop is appended automatically. */
  title: string;
  /** Optional lede under the title. Forgot/reset keep their copy in the body. */
  subtitle?: string;
  /** Optional node on the right of the header row (e.g. the MFA "Secure" pill). */
  badge?: React.ReactNode;
  /** Card max width in px (460 for recovery, 560 for the wider MFA layout). */
  maxWidth?: number;
  /** Right-hand footer label after "Skaly Group ·". */
  footerRight: string;
  children: React.ReactNode;
}

export function AuthCanvasCard({
  eyebrow,
  title,
  subtitle,
  badge,
  maxWidth = 460,
  footerRight,
  children,
}: AuthCanvasCardProps) {
  return (
    <div className="dark sk-page fixed inset-0 z-20 overflow-y-auto bg-bg-base text-text-primary">
      <div className="pointer-events-none fixed inset-0">
        <AuthBackdrop variant="aurora" />
      </div>

      <div className="relative flex min-h-full flex-col items-center justify-center gap-6 px-5 py-14">
        <main
          className="w-full animate-[skRise_0.5s_cubic-bezier(0.2,0.7,0.2,1)_both]"
          style={{ maxWidth }}
        >
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
                {badge}
              </div>

              <div className="mt-6 flex items-center gap-2.5">
                <span className="h-1.5 w-1.5 rounded-full bg-accent-gold shadow-[0_0_10px_rgba(253,194,87,0.7)]" />
                <span className="font-[family-name:var(--font-mono)] text-[10.5px] uppercase tracking-[0.18em] text-text-secondary">
                  {eyebrow}
                </span>
              </div>
              <h1 className="mt-2.5 font-[family-name:var(--font-display)] text-[clamp(1.85rem,6vw,2.4rem)] font-extrabold leading-[0.97] tracking-[-0.01em] text-text-primary">
                {title}
                <span className="text-accent-gold">.</span>
              </h1>
              {subtitle && (
                <p className="mt-3.5 max-w-[440px] text-[14.5px] leading-[1.55] text-text-secondary">
                  {subtitle}
                </p>
              )}
            </header>

            {children}
          </div>

          <footer className="mt-5 flex items-center justify-center gap-2 font-[family-name:var(--font-mono)] text-[11px] text-border-strong">
            <span>Skaly Group</span>
            <span className="text-text-disabled">·</span>
            <span>{footerRight}</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
