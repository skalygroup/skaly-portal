import { Kysely, sql } from 'kysely';

/**
 * MFA recovery codes (Sprint 1 STEP 8). When a user enrolls a TOTP factor we
 * also hand them 10 single-use recovery codes to print / store in a password
 * manager, used to regain access if they lose their authenticator.
 *
 * Only the SHA-256 hash of each code is persisted — the plaintext is shown
 * exactly once (the enroll response) and never again. A row is consumed by
 * stamping `used_at`; resetMfa (admin) and re-enrollment delete a user's rows
 * so a fresh set replaces the old.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE mfa_recovery_codes (
      id          UUID         NOT NULL DEFAULT gen_random_uuid(),
      staff_id    UUID         NOT NULL,
      code_hash   TEXT         NOT NULL,
      used_at     TIMESTAMPTZ  NULL,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT mfa_recovery_codes_pkey      PRIMARY KEY (id),
      CONSTRAINT mfa_recovery_codes_staff_fk  FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE,
      CONSTRAINT mfa_recovery_codes_unique    UNIQUE (staff_id, code_hash)
    )
  `.execute(db);

  // Lookups are always scoped to one user's unused codes (recovery attempt).
  await sql`
    CREATE INDEX idx_mfa_recovery_codes_staff
      ON mfa_recovery_codes(staff_id)
      WHERE used_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_mfa_recovery_codes_staff`.execute(db);
  await sql`DROP TABLE IF EXISTS mfa_recovery_codes`.execute(db);
}
