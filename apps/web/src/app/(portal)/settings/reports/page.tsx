import { Suspense } from 'react';

import { ReportsPanel } from './reports-panel';

import { requirePanel } from '@/lib/settings-panels';

/**
 * Settings → Reports (admin + manager).
 *
 * No `canWrite` prop: `module.settings_reports` has no write key. Generating is
 * gated by `report.generate` on the API, and a manager holds it — the panel and
 * the capability are the same thing here, so a second client-side gate would
 * only be able to disagree with the server.
 *
 * Suspense is Next 15's requirement for `useSearchParams`, which the panel reads
 * to highlight the report a `report_ready` notification deep-linked to.
 */
export default async function ReportsSettingsPage() {
  await requirePanel('module.settings_reports.read');
  return (
    <Suspense fallback={<p className="py-16 text-sm text-text-muted">Loading reports…</p>}>
      <ReportsPanel />
    </Suspense>
  );
}
