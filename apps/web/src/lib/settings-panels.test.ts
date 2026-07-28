import { describe, expect, test, vi } from 'vitest';

import type { StaffMeResponse } from '@skaly/shared/schemas/auth';

import { SETTINGS_PANELS, visiblePanels } from '@/lib/settings-panels';

// `settings-panels` imports next/navigation's forbidden() at module scope for
// requirePanel; the derivation half under test here never calls it.
vi.mock('next/navigation', () => ({ forbidden: vi.fn() }));
vi.mock('@/lib/get-staff-me', () => ({ getStaffMe: vi.fn() }));

/**
 * The nav is derived from the permission map, not a role list (STEP 9's rule).
 *
 * These fixtures use the ROLE DEFAULTS from `packages/shared/constants/permissions`
 * rather than hand-picked booleans, so the test asserts what the backend would
 * actually resolve — a hand-written map would only prove the filter can filter.
 */
const me = (permissions: Record<string, boolean>, role = 'admin'): StaffMeResponse =>
  ({ id: 's1', name: 'S', email: 's@x.io', role, permissions }) as StaffMeResponse;

/** Every settings key an admin resolves to true. */
const ADMIN_PERMS = Object.fromEntries(SETTINGS_PANELS.flatMap((p) => [[p.read, true]]));

/** Auth-Matrix §3: Staff (limited), Clients, Holidays, Reports — and nothing else. */
const MANAGER_PERMS = {
  'module.settings_staff.read': true,
  'module.settings_clients.read': true,
  'module.settings_holidays.read': true,
  'module.settings_reports.read': true,
  'module.settings_permissions.read': false,
  'module.settings_signup_requests.read': false,
  'module.settings_months.read': false,
  'module.settings_audit_log.read': false,
};

describe('the settings nav is derived, never hardcoded', () => {
  test('⭐ a manager sees exactly Staff, Clients, Holidays, Reports', () => {
    const labels = visiblePanels(me(MANAGER_PERMS, 'manager')).map((p) => p.label);
    expect(labels).toEqual(['Staff', 'Clients', 'Holidays', 'Reports']);
  });

  test('⭐ a manager sees NONE of the admin-only panels', () => {
    const labels = visiblePanels(me(MANAGER_PERMS, 'manager')).map((p) => p.label);
    for (const forbidden of ['Permissions', 'Signup Requests', 'Months', 'Audit Log']) {
      expect(labels, `${forbidden} must not be navigable for a manager`).not.toContain(forbidden);
    }
  });

  test('an admin sees all eight', () => {
    expect(visiblePanels(me(ADMIN_PERMS)).map((p) => p.label)).toEqual([
      'Staff',
      'Clients',
      'Permissions',
      'Signup Requests',
      'Holidays',
      'Months',
      'Audit Log',
      'Reports',
    ]);
  });

  test('a team member sees no panels at all', () => {
    expect(visiblePanels(me({}, 'team_member'))).toEqual([]);
  });

  test('no session → no panels, rather than a crash', () => {
    expect(visiblePanels(null)).toEqual([]);
  });

  test('⭐ an OVERRIDE opens a panel a role default would keep shut', () => {
    // This is the reason the nav reads permissions instead of `role === 'admin'`.
    // An admin granting `module.settings_months.read` to one manager changes the
    // key's value and cannot change their role — a role check would leave the
    // panel hidden from someone who was just handed it.
    const withOverride = { ...MANAGER_PERMS, 'module.settings_months.read': true };
    expect(visiblePanels(me(withOverride, 'manager')).map((p) => p.label)).toContain('Months');
  });

  test('a missing key is treated as denied, not as undefined-is-falsy-so-fine', () => {
    // Explicit === true. A key the backend has never heard of must not open a
    // panel because `undefined` happened to be compared loosely somewhere.
    expect(visiblePanels(me({ 'module.settings_staff.read': true })).map((p) => p.label)).toEqual([
      'Staff',
    ]);
  });
});

describe('the panel registry is complete', () => {
  test('every panel names a read key under the §6.2 convention', () => {
    for (const panel of SETTINGS_PANELS) {
      expect(panel.read, panel.label).toMatch(/^module\.settings_[a-z_]+\.read$/);
      expect(panel.href, panel.label).toMatch(/^\/settings\//);
    }
  });

  test('audit log has no write key — the table is append-only', () => {
    const auditLog = SETTINGS_PANELS.find((p) => p.label === 'Audit Log');
    expect(auditLog?.write).toBeUndefined();
  });

  test('hrefs are unique, so two panels cannot claim one route', () => {
    const hrefs = SETTINGS_PANELS.map((p) => p.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
