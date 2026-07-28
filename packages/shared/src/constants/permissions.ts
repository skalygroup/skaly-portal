/**
 * ROLE_DEFAULTS — the single source of truth for what each role can do BY
 * DEFAULT. This is the role-default layer of the three-layer model in
 * docs/08-AUTH-MATRIX.md (§2), and the exact constant AUTH-MATRIX §6.1 names:
 * "Apply role default from ROLE_DEFAULTS constant in
 * packages/shared/constants/permissions.ts".
 *
 * Pure data — NO resolver logic. The behavioural resolver
 * (`resolvePermission`) lands in Sprint 8 against its first consumer (the bot),
 * where the Redis `perms:{staffId}` read + DB fallback + cache-bust-on-override
 * (AUTH-MATRIX §6.3) can be verified end-to-end. For Sprint 8, write this down:
 *   resolvePermission(staffId, key) reads perms:{staffId} (Redis, 5-min TTL,
 *   JSON array of { permissionKey, value }), falls back to
 *   ROLE_DEFAULTS[key][role], and the admin override endpoint DELETES the Redis
 *   key on write.
 *
 * Symbol → boolean transcription (AUTH-MATRIX §3 legend):
 *   ✅ Full R/W          → true
 *   👁 Read-only         → read: true, write: false
 *   🔐 Own data only     → true  (record-level ownership — own attendance
 *                          column, assigned task, own shoot row — is enforced in
 *                          the tool/service layer, NOT in this capability gate)
 *   ❌ No access         → false
 *   🔧 Admin-configurable → false (default OFF, override-able via user_permissions)
 *
 * Key naming: AUTH-MATRIX §6.2. Module keys match the Sprint 1 baseline verbatim
 * so this stays the ONE map — apps/api/src/lib/permissions.ts derives from here.
 */
import type { Role } from '../schemas/auth';

/** Per-role default for a single permission key. */
export type RolePermissionDefaults = Record<Role, boolean>;

export const ROLE_DEFAULTS: Record<string, RolePermissionDefaults> = {
  // ─── §5 Bot tool permission matrix (all 23 tools) ─────────────────────────
  // Query tools
  'bot.tool.get_project_status':  { admin: true, manager: true,  team_member: true,  freelancer: false },
  'bot.tool.list_tasks':          { admin: true, manager: true,  team_member: true,  freelancer: false }, // team_member 🔐 own
  'bot.tool.list_overdue_tasks':  { admin: true, manager: true,  team_member: true,  freelancer: false }, // team_member 🔐 own
  'bot.tool.get_user_workload':   { admin: true, manager: true,  team_member: true,  freelancer: false }, // team_member 🔐 own
  'bot.tool.get_attendance':      { admin: true, manager: true,  team_member: true,  freelancer: false }, // team_member 🔐 own
  'bot.tool.get_shoot_schedule':  { admin: true, manager: true,  team_member: true,  freelancer: true  }, // freelancer 🔐 own
  'bot.tool.get_content_pipeline':{ admin: true, manager: true,  team_member: false, freelancer: false },
  'bot.tool.get_content_calendar':{ admin: true, manager: true,  team_member: true,  freelancer: false },
  'bot.tool.get_audit_log':       { admin: true, manager: false, team_member: false, freelancer: false },
  'bot.tool.get_holiday_list':    { admin: true, manager: true,  team_member: true,  freelancer: false },
  'bot.tool.get_client_summary':  { admin: true, manager: true,  team_member: false, freelancer: false },
  // Mutation tools
  'bot.tool.update_task_status':  { admin: true, manager: true,  team_member: false, freelancer: false }, // team_member 🔧 override-able via user_permissions
  'bot.tool.update_pipeline_stage':{ admin: true, manager: true, team_member: false, freelancer: false },
  'bot.tool.update_shoot_slot':   { admin: true, manager: true,  team_member: false, freelancer: false },
  'bot.tool.create_task':         { admin: true, manager: true,  team_member: false, freelancer: false },
  'bot.tool.set_deadline':        { admin: true, manager: true,  team_member: false, freelancer: false },
  'bot.tool.add_holiday':         { admin: true, manager: true,  team_member: false, freelancer: false },
  'bot.tool.remove_holiday':      { admin: true, manager: true,  team_member: false, freelancer: false },
  'bot.tool.assign_task':         { admin: true, manager: true,  team_member: false, freelancer: false },
  'bot.tool.update_calendar_cell':{ admin: true, manager: true,  team_member: false, freelancer: false },
  'bot.tool.add_client':          { admin: true, manager: true,  team_member: false, freelancer: false },
  'bot.tool.deactivate_client':   { admin: true, manager: false, team_member: false, freelancer: false },
  'bot.tool.reactivate_client':   { admin: true, manager: false, team_member: false, freelancer: false }, // ADR-026 §6: same gate as its destructive twin

  // ─── §3 / §4 Module access (module.{module}.read / .write) ────────────────
  'module.home.read':                    { admin: true, manager: true,  team_member: true,  freelancer: true  }, // freelancer: own widgets
  'module.attendance.read':              { admin: true, manager: true,  team_member: true,  freelancer: false }, // team_member 🔐 own column
  'module.attendance.write':             { admin: true, manager: true,  team_member: true,  freelancer: false }, // team_member 🔐 own column
  'module.tasks.read':                   { admin: true, manager: true,  team_member: true,  freelancer: false },
  'module.tasks.write':                  { admin: true, manager: true,  team_member: true,  freelancer: false }, // team_member 🔐 status+result on assigned
  'module.shoot_planner.read':           { admin: true, manager: true,  team_member: true,  freelancer: true  }, // freelancer 🔐 own rows
  'module.shoot_planner.write':          { admin: true, manager: true,  team_member: false, freelancer: false },
  'module.content_dropper.read':         { admin: true, manager: true,  team_member: false, freelancer: false },
  'module.content_dropper.write':        { admin: true, manager: true,  team_member: false, freelancer: false },
  'module.content_calendar.read':        { admin: true, manager: true,  team_member: true,  freelancer: false }, // team_member 👁 read-only
  'module.content_calendar.write':       { admin: true, manager: true,  team_member: false, freelancer: false },
  'module.dashboard.read':               { admin: true, manager: true,  team_member: true,  freelancer: true  }, // 🔐 own data
  'module.profile.read':                 { admin: true, manager: true,  team_member: true,  freelancer: true  },
  'module.profile.write':                { admin: true, manager: true,  team_member: true,  freelancer: true  },
  'module.settings_staff.read':          { admin: true, manager: true,  team_member: false, freelancer: false }, // manager 👁 limited
  'module.settings_staff.write':         { admin: true, manager: false, team_member: false, freelancer: false },
  'module.settings_clients.read':        { admin: true, manager: true,  team_member: false, freelancer: false },
  'module.settings_clients.write':       { admin: true, manager: true,  team_member: false, freelancer: false },
  'module.settings_permissions.read':    { admin: true, manager: false, team_member: false, freelancer: false },
  'module.settings_permissions.write':   { admin: true, manager: false, team_member: false, freelancer: false },
  'module.settings_signup_requests.read':{ admin: true, manager: false, team_member: false, freelancer: false },
  'module.settings_signup_requests.write':{ admin: true, manager: false, team_member: false, freelancer: false },
  'module.settings_holidays.read':       { admin: true, manager: true,  team_member: false, freelancer: false }, // admin + manager (FR-ATT-09)
  'module.settings_holidays.write':      { admin: true, manager: true,  team_member: false, freelancer: false }, // admin + manager (FR-ATT-09)
  'module.settings_months.read':         { admin: true, manager: false, team_member: false, freelancer: false },
  'module.settings_months.write':        { admin: true, manager: false, team_member: false, freelancer: false },
  'module.settings_audit_log.read':      { admin: true, manager: false, team_member: false, freelancer: false }, // read-only; audit_log is append-only
  'module.settings_reports.read':        { admin: true, manager: true,  team_member: false, freelancer: false },

  // ─── Standalone capability keys (§6.2) ────────────────────────────────────
  'chat.access':    { admin: true, manager: true, team_member: true,  freelancer: false }, // freelancer 🔧 blocked by default — override-able via user_permissions
  'report.generate':{ admin: true, manager: true, team_member: false, freelancer: false },
  'months.unlock':  { admin: true, manager: false, team_member: false, freelancer: false },
};

/** Every known permission key, derived from the map (no separate list to drift). */
export type PermissionKey = keyof typeof ROLE_DEFAULTS;
