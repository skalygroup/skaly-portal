import { StaffPanel } from './staff-panel';

import { requirePanel } from '@/lib/settings-panels';

/**
 * Settings → Staff. Admin gets row actions; a manager gets the table and nothing
 * to click (Auth-Matrix §3, 👁 limited).
 *
 * `requirePanel` answers 403 on a typed URL, and hands back the profile so the
 * write gating below is derived from the SAME object that authorised the read —
 * not from a second `getStaffMe()` that could disagree with the first.
 */
export default async function StaffSettingsPage() {
  const me = await requirePanel('module.settings_staff.read');
  return <StaffPanel canWrite={me.permissions['module.settings_staff.write'] === true} />;
}
