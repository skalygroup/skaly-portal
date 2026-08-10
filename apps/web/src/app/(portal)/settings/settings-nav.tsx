'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
}

/**
 * Settings sidebar nav (client — needs usePathname for the active state). The
 * admin-only items are decided server-side in layout.tsx and passed in, so a
 * non-admin never receives the Signup Requests link in their HTML.
 */
export function SettingsNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    /**
     * The label is not decoration. Since the §4.1 sidebar landed there are TWO
     * navigation landmarks on a settings page, and WCAG requires multiple
     * landmarks of the same role to be distinguishable — a screen-reader user
     * otherwise gets "navigation" twice with no way to tell which is which.
     * It also un-breaks every `getByRole('navigation')` in the E2E suite, which
     * had been unambiguous for exactly as long as there was only one nav.
     */
    <nav aria-label="Settings panels" className="flex flex-col gap-1">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-2 text-sm transition-colors',
              active
                ? 'bg-[var(--accent-gold-dim)] font-semibold text-accent-gold'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
