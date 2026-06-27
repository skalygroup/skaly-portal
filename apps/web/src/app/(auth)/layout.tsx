import type { ReactNode } from 'react';

import { BrandPanel } from '@/components/auth/brand-panel';

/**
 * Shared layout for every auth route (/login, /signup, /signup/invite,
 * /signup/pending, /forgot-password, /reset-password, /mfa-setup).
 *
 * Split-screen (login redesign): brand panel on the left (~1.05fr), the form
 * column on the right (1fr) on a dark `bg-surface`, vertically centred and
 * capped at 368px. Below md the brand panel is hidden and the form fills the
 * screen.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen grid-cols-1 md:[grid-template-columns:1.05fr_1fr]">
      {/* Desktop brand panel */}
      <aside className="hidden border-r border-border-subtle md:block">
        <BrandPanel />
      </aside>

      {/* Form column */}
      <main className="flex items-center justify-center bg-bg-surface px-8 py-10">
        <div className="w-full max-w-[368px]">{children}</div>
      </main>
    </div>
  );
}
