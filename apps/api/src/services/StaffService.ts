/**
 * StaffService — read side (07-API-CONTRACT §4). Field filtering is enforced
 * HERE (server-side), never by trusting the client. Every SELECT goes through
 * softDeletable (audit H-02).
 */
import { sql } from 'kysely';

import { presenceService } from './PresenceService.js';
import { softDeletable } from '../lib/queries.js';

import type { Executor } from './BaseService.js';
import type { Role } from '@skaly/shared/schemas/auth';

/** GET /v1/staff — the limited fields safe for dropdowns / @mention lists. */
export interface StaffListItem {
  id: string;
  name: string;
  role: Role;
  avatarUrl: string | null;
  isOnline: boolean;
}

/** GET /v1/staff/:id and /me — the full profile. */
export interface StaffFullProfile {
  id: string;
  name: string;
  email: string;
  role: Role;
  dateOfBirth: string | null;
  mobileNumber: string | null;
  cvFileKey: string | null;
  avatarUrl: string | null;
  active: boolean;
  mfaEnrolled: boolean;
  createdAt: string;
}

/** GET /v1/staff/:id/profile — the public-safe subset. */
export interface StaffPublicProfile {
  id: string;
  name: string;
  role: Role;
  avatarUrl: string | null;
}

export class StaffService {
  /** Limited fields for all roles, name-ascending, with live presence. */
  async listLimited(trx: Executor): Promise<StaffListItem[]> {
    const rows = await softDeletable(
      trx.selectFrom('staff').select(['id', 'name', 'role', 'avatar_url']),
    )
      .orderBy('name', 'asc')
      .execute();

    // ADR-011/ADR-023: presence is reported AGAINST the rows this caller already
    // fetched and is authorised for, never as a standalone roster. There is no
    // overload that returns everyone, so a future caller cannot accidentally turn
    // presence into a staff directory.
    const online = await presenceService.getOnlineAmong(rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role as Role,
      avatarUrl: r.avatar_url,
      isOnline: online.has(r.id),
    }));
  }

  /** Full profile for one staff member, or undefined if absent/soft-deleted. */
  async getFullProfile(staffId: string, trx: Executor): Promise<StaffFullProfile | undefined> {
    const row = await softDeletable(
      trx
        .selectFrom('staff')
        .select([
          'id',
          'name',
          'email',
          'role',
          // Format the DATE column server-side so it can't shift across TZ when
          // node-pg parses it into a JS Date.
          sql<string | null>`to_char(date_of_birth, 'YYYY-MM-DD')`.as('date_of_birth'),
          'mobile_number',
          'cv_file_key',
          'avatar_url',
          'active',
          'mfa_enrolled',
          'created_at',
        ]),
    )
      .where('id', '=', staffId)
      .executeTakeFirst();

    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role as Role,
      dateOfBirth: row.date_of_birth,
      mobileNumber: row.mobile_number,
      cvFileKey: row.cv_file_key,
      avatarUrl: row.avatar_url,
      active: row.active,
      mfaEnrolled: row.mfa_enrolled,
      createdAt: row.created_at.toISOString(),
    };
  }

  /** Public-safe profile, or undefined if absent/soft-deleted. */
  async getPublicProfile(staffId: string, trx: Executor): Promise<StaffPublicProfile | undefined> {
    const row = await softDeletable(
      trx.selectFrom('staff').select(['id', 'name', 'role', 'avatar_url']),
    )
      .where('id', '=', staffId)
      .executeTakeFirst();

    if (!row) return undefined;
    return { id: row.id, name: row.name, role: row.role as Role, avatarUrl: row.avatar_url };
  }
}