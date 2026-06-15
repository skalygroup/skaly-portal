import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE staff (
      id              UUID          NOT NULL DEFAULT gen_random_uuid(),
      supabase_uid    UUID          UNIQUE,
      name            VARCHAR(255)  NOT NULL,
      email           VARCHAR(255)  NOT NULL,
      role            VARCHAR(30)   NOT NULL,
      date_of_birth   DATE          NULL,
      mobile_number   VARCHAR(20)   NULL,
      cv_file_key     TEXT          NULL,
      avatar_url      TEXT,
      active          BOOLEAN       NOT NULL DEFAULT TRUE,
      mfa_enrolled    BOOLEAN       NOT NULL DEFAULT FALSE,
      push_token      TEXT          NULL,
      push_platform   VARCHAR(10)   NULL,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      deleted_at      TIMESTAMPTZ,
      CONSTRAINT staff_pkey           PRIMARY KEY (id),
      CONSTRAINT staff_email_unique   UNIQUE (email),
      CONSTRAINT staff_role_check     CHECK (role IN ('admin','manager','team_member','freelancer')),
      CONSTRAINT staff_push_platform  CHECK (push_platform IN ('ios','android') OR push_platform IS NULL)
    )
  `.execute(db);

  await sql`CREATE INDEX idx_staff_role_active ON staff(role) WHERE active = TRUE AND deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX idx_staff_email       ON staff(email)`.execute(db);
  await sql`CREATE INDEX idx_staff_supabase    ON staff(supabase_uid) WHERE supabase_uid IS NOT NULL`.execute(db);

  // Add FK references from months to staff now that staff exists
  await sql`ALTER TABLE months ADD CONSTRAINT months_locked_by_fk FOREIGN KEY (locked_by) REFERENCES staff(id)`.execute(db);
  await sql`ALTER TABLE months ADD CONSTRAINT months_unlocked_by_fk FOREIGN KEY (unlocked_by) REFERENCES staff(id)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE months DROP CONSTRAINT IF EXISTS months_unlocked_by_fk`.execute(db);
  await sql`ALTER TABLE months DROP CONSTRAINT IF EXISTS months_locked_by_fk`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_staff_supabase`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_staff_email`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_staff_role_active`.execute(db);
  await sql`DROP TABLE IF EXISTS staff`.execute(db);
}
