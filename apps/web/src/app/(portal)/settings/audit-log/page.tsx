import { AuditLogPanel } from './audit-log-panel';

import { requirePanel } from '@/lib/settings-panels';

/**
 * Settings → Audit Log.
 *
 * No `canWrite` prop, and the registry entry has no write key: `audit_log` is
 * append-only at the DB role level (migration 026 revokes UPDATE and DELETE from
 * the app role), so there is no mutation for a permission to gate.
 *
 * `/v1/activity-feed` (Sprint 9) is the role-filtered surface everyone else
 * gets. That split is canonical (PRD FR-SET-07), not an accident of two sprints.
 */
export default async function AuditLogSettingsPage() {
  await requirePanel('module.settings_audit_log.read');
  return <AuditLogPanel />;
}
