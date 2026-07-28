import { MonthsPanel } from './months-panel';

import { requirePanel } from '@/lib/settings-panels';

/** Settings → Months. Lock/unlock the period every other module reads. */
export default async function MonthsSettingsPage() {
  const me = await requirePanel('module.settings_months.read');
  return <MonthsPanel canWrite={me.permissions['module.settings_months.write'] === true} />;
}
