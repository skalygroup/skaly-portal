import { ROLE_DEFAULTS } from '@skaly/shared';

import type { DB } from '@skaly/shared';
import type { Role } from '@skaly/shared/schemas/auth';
import type { Kysely } from 'kysely';

/**
 * Role-default permission layer of the three-layer model in
 * docs/08-AUTH-MATRIX.md. The defaults themselves live in ONE place —
 * `ROLE_DEFAULTS` in packages/shared/src/constants/permissions.ts (the constant
 * AUTH-MATRIX §6.1 names) — so the API and the frontend read the same map. This
 * module just projects that map for a role and (Sprint 8) will WRAP the result
 * with per-user overrides (user_permissions + perms:{staffId} cache, §6).
 *
 * A "🔐 own data only" cell still counts as `true` here — record-level ownership
 * (own attendance column, assigned task, own shoot row) is enforced in the
 * service layer, not in this capability gate.
 */

/**
 * The role-default permission map for a role. Pure + synchronous so it can be
 * reused anywhere (e.g. the frontend sidebar) without a DB round-trip.
 */
export function roleBaselinePermissions(role: Role): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key in ROLE_DEFAULTS) {
    out[key] = ROLE_DEFAULTS[key]![role];
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
