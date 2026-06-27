import { SettingsNav } from './settings-nav';

import type { ReactNode } from 'react';

import { getStaffMe } from '@/lib/get-staff-me';

/**
 * Settings shell with a left nav. Admin-only entries (Signup Requests) are
 * gated server-side: a non-admin's HTML never contains the link. The backend
 * still enforces admin on the route itself — this is just navigation.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const me = await getStaffMe();
  const isAdmin = me?.role === 'admin';

  const items = [
    { href: '/settings', label: 'General' },
    ...(isAdmin ? [{ href: '/settings/signup-requests', label: 'Signup Requests' }] : []),
  ];

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
