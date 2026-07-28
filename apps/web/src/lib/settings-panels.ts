import { forbidden } from 'next/navigation';

import type { StaffMeResponse } from '@skaly/shared/schemas/auth';

import { getStaffMe } from '@/lib/get-staff-me';

/**
 * The settings panels, as data (Auth-Matrix §3).
 *
 * ONE list, read by the nav AND by each panel's server guard. Two lists is how a
 * panel ends up hidden from the nav but reachable by URL, or the reverse — and
 * the reverse is worse, because it looks like a bug in the nav rather than a
 * hole in the gate.
 *
 * `read` is the SAME permission key the backend resolves through
 * `PermissionService`, not a role check. A hardcoded `role === 'admin'` in the
 * component drifts the moment an admin grants an override, because the override
 * changes the key's value and cannot change the role.
 */
export interface SettingsPanel {
  href: string;
  label: string;
  /** Governs whether the panel is navigable AND reachable. */
  read: string;
  /** Governs whether its mutations render. Absent ⇒ the panel is read-only. */
  write?: string;
}

export const SETTINGS_PANELS: SettingsPanel[] = [
  {
    href: '/settings/staff',
    label: 'Staff',
    read: 'module.settings_staff.read',
    write: 'module.settings_staff.write',
  },
  {
    href: '/settings/clients',
    label: 'Clients',
    read: 'module.settings_clients.read',
    write: 'module.settings_clients.write',
  },
  {
    href: '/settings/permissions',
    label: 'Permissions',
    read: 'module.settings_permissions.read',
    write: 'module.settings_permissions.write',
  },
  {
    href: '/settings/signup-requests',
    label: 'Signup Requests',
    read: 'module.settings_signup_requests.read',
    write: 'module.settings_signup_requests.write',
  },
  {
    href: '/settings/holidays',
    label: 'Holidays',
    read: 'module.settings_holidays.read',
    write: 'module.settings_holidays.write',
  },
  {
    href: '/settings/months',
    label: 'Months',
    read: 'module.settings_months.read',
    write: 'module.settings_months.write',
  },
  {
    href: '/settings/audit-log',
    label: 'Audit Log',
    // No write key: audit_log is append-only, so there is no mutation to gate.
    read: 'module.settings_audit_log.read',
  },
  {
    href: '/settings/reports',
    label: 'Reports',
    read: 'module.settings_reports.read',
  },
];

export const visiblePanels = (me: StaffMeResponse | null): SettingsPanel[] =>
  me ? SETTINGS_PANELS.filter((p) => me.permissions[p.read] === true) : [];

/**
 * Server guard for a settings panel page. Returns the profile so the caller can
 * derive its own write-gating from the same object it was authorised by.
 *
 * 403, NOT a redirect — Auth-Matrix §3 is explicit, and it is the right answer
 * on the merits: a redirect tells a manager who typed /settings/months that the
 * page moved, when what happened is that they may not have it. `forbidden()`
 * renders `app/forbidden.tsx` with a real 403 status (Next's `authInterrupts`),
 * so the wire agrees with the screen.
 *
 * This is navigation-layer enforcement. The API enforces the same rule on every
 * endpoint underneath — a hidden panel whose endpoints are open is not gated.
 */
export async function requirePanel(read: string): Promise<StaffMeResponse> {
  const me = await getStaffMe();
  if (!me || me.permissions[read] !== true) forbidden();
  return me;
}
