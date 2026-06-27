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
    <nav className="flex flex-col gap-1">
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
