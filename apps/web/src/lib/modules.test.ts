import { ROLE_DEFAULTS } from '@skaly/shared';
import { describe, expect, test } from 'vitest';

import { MODULES, visibleModules } from './modules';

import type { Role, StaffMeResponse } from '@skaly/shared/schemas/auth';

/**
 * The sidebar's visibility rules (UIUX §4.1, Auth-Matrix §3).
 *
 * ⚠️ THE PERMISSIONS ARE BUILT FROM `ROLE_DEFAULTS`, the same table the backend
 * resolves through — not hand-written per test. A hand-written map is a second
 * copy of the auth matrix that drifts silently: the day a module's default
 * changes, the product changes and this file keeps asserting the old world.
 */
function meAs(role: Role, overrides: Record<string, boolean> = {}): StaffMeResponse {
  const permissions: Record<string, boolean> = {};
  for (const [key, matrix] of Object.entries(ROLE_DEFAULTS)) {
    permissions[key] = (matrix as Record<Role, boolean>)[role];
  }
  return {
    id: 'staff-1',
    name: 'Test Person',
    email: 'test@skaly.in',
    role,
    dateOfBirth: null,
    mobileNumber: null,
    cvFileKey: null,
    avatarUrl: null,
    active: true,
    mfaEnrolled: false,
    createdAt: new Date().toISOString(),
    permissions: { ...permissions, ...overrides },
  };
}

const hrefs = (me: StaffMeResponse | null) => visibleModules(me).map((m) => m.href);

describe('the sidebar is derived from permissions, never from the role', () => {
  test('an admin sees every module, plus Settings', () => {
    const items = hrefs(meAs('admin'));
    for (const m of MODULES) expect(items, `admin should see ${m.href}`).toContain(m.href);
    expect(items).toContain('/settings');
  });

  test('a team member does NOT see the content dropper', () => {
    // module.content_dropper.read is admin+manager only (Auth-Matrix §3).
    expect(hrefs(meAs('team_member'))).not.toContain('/content-dropper');
  });

  test('a freelancer sees only what they hold — shoot planner in, attendance out', () => {
    const items = hrefs(meAs('freelancer'));
    expect(items).toContain('/shoot-planner'); // 🔐 own rows
    expect(items).not.toContain('/attendance');
    expect(items).not.toContain('/tasks');
    expect(items).not.toContain('/chat'); // blocked by default, override-able
  });

  test('⭐ an OVERRIDE reveals a module the role alone would hide', () => {
    // The assertion a `role === 'admin'` check in the component could never
    // pass: an override changes the key's value and cannot change the role, so
    // a role check leaves the module hidden from the person just granted it —
    // and ADR-029 pushes this change to an idle session, live.
    const freelancer = meAs('freelancer');
    expect(hrefs(freelancer)).not.toContain('/chat');

    const granted = meAs('freelancer', { 'chat.access': true });
    expect(hrefs(granted)).toContain('/chat');
  });

  test('⭐ a REVOKED module disappears even for an admin', () => {
    const revoked = meAs('admin', { 'module.attendance.read': false });
    expect(hrefs(revoked)).not.toContain('/attendance');
  });

  test('Settings appears only when at least one panel does', () => {
    // Settings has no key of its own — it is a shell over the panels, so its
    // visibility is derived. A link opening onto an empty nav is the failure.
    expect(hrefs(meAs('admin'))).toContain('/settings');
    expect(hrefs(meAs('team_member'))).not.toContain('/settings');
    expect(hrefs(meAs('freelancer'))).not.toContain('/settings');
  });

  test('the bot has no permission key, so every signed-in role sees it', () => {
    // Gating is per-TOOL (bot.tool.*) and a freelancer legitimately holds some,
    // so there is no single key to test against.
    for (const role of ['admin', 'manager', 'team_member', 'freelancer'] as const) {
      expect(hrefs(meAs(role)), role).toContain('/bot');
    }
  });

  test('a signed-out visitor gets nothing — the nav renders no links at all', () => {
    expect(visibleModules(null)).toEqual([]);
  });
});

describe('the list itself stays honest', () => {
  test('every module names a permission key that EXISTS in the registry', () => {
    // A typo'd key reads as `undefined !== true` — the module silently vanishes
    // for everyone, which looks like a permissions bug and is a spelling one.
    for (const m of MODULES) {
      if (m.read === null) continue;
      expect(Object.keys(ROLE_DEFAULTS), `${m.href} → ${m.read}`).toContain(m.read);
    }
  });

  test('no duplicate hrefs', () => {
    const seen = MODULES.map((m) => m.href);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
