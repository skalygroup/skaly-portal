import type { DB } from '@skaly/shared';
import type { Role } from '@skaly/shared/schemas/auth';
import type { Kysely } from 'kysely';

/**
 * Sprint 1 permission baseline — the role-default layer of the three-layer
 * model in docs/08-AUTH-MATRIX.md. Per-user overrides (the user_permissions
 * table + perms:{staffId} cache, AUTH-MATRIX §6) arrive in Sprint 11; that work
 * will WRAP getEffectivePermissions, merging overrides on top of this baseline.
 * Keep this file the single source of the hard-coded defaults so the override
 * layer has exactly one thing to wrap.
 *
 * Key naming follows AUTH-MATRIX §6.2. A "🔐 own data only" cell still counts
 * as `true` at this capability layer — record-level ownership (own attendance
 * column, assigned task, own shoot row) is enforced in the service layer, not
 * here.
 */

// permissionKey → roles that get it by default (transcribed from §3 + §4).
const BASELINE: Record<string, Role[]> = {
  'module.home.read': ['admin', 'manager', 'team_member', 'freelancer'],
  'module.attendance.read': ['admin', 'manager', 'team_member'],
  'module.attendance.write': ['admin', 'manager', 'team_member'],
  'module.tasks.read': ['admin', 'manager', 'team_member'],
  'module.tasks.write': ['admin', 'manager', 'team_member'],
  'module.shoot_planner.read': ['admin', 'manager', 'team_member', 'freelancer'],
  'module.shoot_planner.write': ['admin', 'manager'],
  'module.content_dropper.read': ['admin', 'manager'],
  'module.content_dropper.write': ['admin', 'manager'],
  'module.content_calendar.read': ['admin', 'manager', 'team_member'],
  'module.content_calendar.write': ['admin', 'manager'],
  'module.dashboard.read': ['admin', 'manager', 'team_member', 'freelancer'],
  'module.profile.read': ['admin', 'manager', 'team_member', 'freelancer'],
  'module.profile.write': ['admin', 'manager', 'team_member', 'freelancer'],
  'module.settings_staff.read': ['admin', 'manager'],
  'module.settings_staff.write': ['admin'],
  'module.settings_clients.read': ['admin', 'manager'],
  'module.settings_clients.write': ['admin', 'manager'],
  'module.settings_permissions.read': ['admin'],
  'module.settings_permissions.write': ['admin'],
  'module.settings_signup_requests.read': ['admin'],
  'module.settings_signup_requests.write': ['admin'],
  'module.settings_holidays.read': ['admin', 'manager'],
  'module.settings_holidays.write': ['admin', 'manager'],
  'module.settings_months.read': ['admin'],
  'module.settings_months.write': ['admin'],
  'module.settings_audit_log.read': ['admin'],
  'module.settings_reports.read': ['admin', 'manager'],
  'chat.access': ['admin', 'manager', 'team_member'],
  'report.generate': ['admin', 'manager'],
  'months.unlock': ['admin'],
};

/**
 * The role-default permission map for a role. Pure + synchronous so it can be
 * reused anywhere (e.g. the frontend sidebar) without a DB round-trip.
 */
export function roleBaselinePermissions(role: Role): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key in BASELINE) {
    out[key] = BASELINE[key]!.includes(role);
  }
  return out;
}

/**
 * Effective permissions for a staff member. Sprint 1: the role baseline only.
 * Sprint 11 wraps this to layer per-user overrides from user_permissions on top
 * (overrides always win — AUTH-MATRIX §6.1).
 */
export async function getEffectivePermissions(
  db: Kysely<DB>,
  staffId: string,
): Promise<Record<string, boolean>> {
  const row = await db
    .selectFrom('staff')
    .select('role')
    .where('id', '=', staffId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row) return {};
  return roleBaselinePermissions(row.role as Role);
}
