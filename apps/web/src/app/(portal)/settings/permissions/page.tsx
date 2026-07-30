import { PermissionsPanel } from './permissions-panel';

import { requirePanel } from '@/lib/settings-panels';

/**
 * Settings → Permissions (admin only by role default, and reachable by anyone an
 * admin grants `module.settings_permissions.read` to — which is the point of
 * gating on the key rather than the role).
 */
export default async function PermissionsSettingsPage() {
  const me = await requirePanel('module.settings_permissions.read');
  return (
    <PermissionsPanel canWrite={me.permissions['module.settings_permissions.write'] === true} />
  );
}
