import { Kysely, sql } from 'kysely';

/**
 * Invite-based onboarding (Sprint 1 STEP 5) uses Supabase's invite email flow:
 * POST /v1/auth/invite calls inviteUserByEmail, which CREATES the Supabase auth
 * user up-front. Signup then sets that user's password (updateUserById) rather
 * than creating a second user. We store the created user's UUID on the invite
 * row so /signup/invite can resolve it from the token alone.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE invite_links ADD COLUMN supabase_uid UUID NULL`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE invite_links DROP COLUMN IF EXISTS supabase_uid`.execute(db);
}
