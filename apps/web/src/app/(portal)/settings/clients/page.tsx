import { ClientsPanel } from './clients-panel';

import { requirePanel } from '@/lib/settings-panels';

/**
 * Settings → Clients (admin + manager).
 *
 * ⚠️ GATE THE PANEL, NEVER THE LOOKUP. `GET /v1/clients` is deliberately open to
 * all four roles — it is the shared list every grid's client filter reads, and
 * closing it would break Tasks, Attendance and the Content modules for a team
 * member. What is admin+manager here is the PANEL: the `includeInactive` view
 * and the mutations. The same split holds for anything client-scoped in Sprints
 * 12–13; a 403 on the lookup asserts a behaviour the product does not want.
 */
export default async function ClientsSettingsPage() {
  const me = await requirePanel('module.settings_clients.read');
  return (
    <ClientsPanel
      canWrite={me.permissions['module.settings_clients.write'] === true}
      isAdmin={me.role === 'admin'}
    />
  );
}
