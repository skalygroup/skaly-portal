'use client';

import * as Icons from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense } from 'react';

import type { ModuleNavItem } from '@/lib/modules';

import { PeriodSelector } from '@/components/shared/period-selector';


/**
 * The portal navigation sidebar (UIUX §4.1).
 *
 * 220px expanded, 56px icon-only from 768–1279px per §4.1. The active marker is
 * `box-shadow: inset 3px 0 0` and NOT a border-left, which §4.1 calls out
 * explicitly — a border changes the element's box and shifts every label by 3px
 * as you move between items, which reads as the text twitching.
 *
 * Items arrive already filtered by the server layout, so a person's HTML never
 * contains a link to a module they cannot open. That is navigation-layer
 * gating only; the API enforces the same rule on every request underneath
 * (see `lib/modules.ts`).
 *
 * Client component purely for `usePathname` — the active state is the only thing
 * here that needs the browser.
 */
export function AppSidebar({ items }: { items: ModuleNavItem[] }) {
  const pathname = usePathname();

  if (items.length === 0) return null;

  return (
    <nav
      aria-label="Modules"
      data-testid="app-sidebar"
      className="fixed inset-y-0 left-0 z-40 flex w-14 shrink-0 flex-col gap-1 overflow-y-auto border-r py-4 xl:w-[220px]"
      style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
    >
      <Link
        href="/home"
        className="mb-4 flex h-8 items-center justify-center xl:justify-start xl:px-4"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 18,
          color: 'var(--accent-gold)',
          fontWeight: 700,
        }}
      >
        {/* The mark alone when collapsed — the full word would clip at 56px. */}
        <span className="xl:hidden">S</span>
        <span className="hidden xl:inline">SKALY</span>
      </Link>

      {/* §6.1: top of the sidebar, below the logo. Suspense because it reads
          ?period= via useSearchParams, which Next 15 requires a boundary for —
          without one the whole route opts out of static rendering. */}
      <Suspense fallback={<div className="mb-3 h-8" />}>
        <PeriodSelector />
      </Suspense>

      {items.map((item) => {
        // Prefix match, so /settings/staff keeps Settings lit and /tasks?period=…
        // keeps Tasks lit. Exact equality would drop the highlight the moment a
        // module navigated anywhere inside itself, which reads as a broken nav.
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon =
          (Icons as unknown as Record<string, typeof Icons.House>)[item.icon] ?? Icons.Circle;

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            title={item.label}
            data-active={active}
            className="flex h-10 items-center gap-3 transition-colors xl:px-4"
            style={{
              boxShadow: active ? 'inset 3px 0 0 var(--accent-gold)' : undefined,
              background: active ? 'var(--accent-gold-dim)' : undefined,
              color: active ? 'var(--accent-gold)' : 'var(--text-secondary)',
              fontFamily: 'var(--font-body)',
              fontSize: 14,
              fontWeight: active ? 600 : 400,
            }}
          >
            <span className="grid w-14 shrink-0 place-items-center xl:w-5">
              <Icon size={20} aria-hidden />
            </span>
            <span className="hidden truncate xl:inline">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
