import { Suspense } from 'react';

import { HolidaysPanel } from './holidays-panel';

import { requirePanel } from '@/lib/settings-panels';

/**
 * Settings → Holidays (admin + manager, FR-ATT-09 — the one panel in STEP 10
 * that is not admin-only).
 *
 * The Suspense boundary is Next 15's requirement for `useSearchParams`, which
 * `useMonthContext` reads to keep the period in the URL.
 */
export default async function HolidaysSettingsPage() {
  const me = await requirePanel('module.settings_holidays.read');
  return (
    <Suspense fallback={<p className="py-16 text-sm text-text-muted">Loading holidays…</p>}>
      <HolidaysPanel canWrite={me.permissions['module.settings_holidays.write'] === true} />
    </Suspense>
  );
}
