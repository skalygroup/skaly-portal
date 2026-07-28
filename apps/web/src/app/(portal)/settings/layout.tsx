import { SettingsNav } from './settings-nav';

import type { ReactNode } from 'react';

import { getStaffMe } from '@/lib/get-staff-me';
import { visiblePanels } from '@/lib/settings-panels';

/**
 * Settings shell with a left nav.
 *
 * The nav is DERIVED from `me.permissions` — the same resolved map the backend
 * gates on — not from a role check in this component. A role check would be
 * wrong the moment an admin grants an override: the override changes the key's
 * value and cannot change the role, so the panel would stay hidden from someone
 * who was just given it.
 *
 * Gating happens twice on purpose, and neither is redundant. Here it decides
 * what is NAVIGABLE (a non-admin's HTML never contains the link). Each panel
 * page calls `requirePanel`, which decides what is REACHABLE and answers 403 on
 * a typed URL. The API enforces the same rule a third time on every endpoint,
 * which is the only one of the three an attacker cannot skip.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const me = await getStaffMe();
  const items = [{ href: '/settings', label: 'General' }, ...visiblePanels(me)];

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[220px_1fr] gap-10 px-8 py-12">
      <aside>
        <h2 className="mb-4 px-3 font-[family-name:var(--font-display)] text-lg font-bold text-text-primary">
          Settings
        </h2>
        <SettingsNav items={items} />
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
}
