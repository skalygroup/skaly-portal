import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE signup_requests (
      id                       UUID          NOT NULL DEFAULT gen_random_uuid(),
      name                     VARCHAR(255)  NOT NULL,
      email                    VARCHAR(255)  NOT NULL,
      date_of_birth            DATE          NOT NULL,
      mobile_number            VARCHAR(20)   NOT NULL,
      role_requested           VARCHAR(30)   NOT NULL,
      cv_file_key              TEXT          NULL,
      message                  TEXT          NULL,
      google_uid               TEXT          NULL,
      status                   VARCHAR(20)   NOT NULL DEFAULT 'pending',
      role_assigned            VARCHAR(30)   NULL,
      rejection_note           TEXT          NULL,
      public_rejection_message VARCHAR(300)  NULL,
      reviewed_at              TIMESTAMPTZ,
      reviewed_by              UUID          REFERENCES staff(id),
      created_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT signup_requests_pkey           PRIMARY KEY (id),
      CONSTRAINT signup_requests_role_check     CHECK (role_requested IN ('manager','team_member','freelancer')),
      CONSTRAINT signup_requests_status_check   CHECK (status IN ('pending','approved','rejected'))
    )
  `.execute(db);

  await sql`CREATE INDEX idx_signup_requests_status ON signup_requests(status, created_at DESC)`.execute(db);

  // Prevents duplicate pending signup submissions for the same email address.
  await sql`
    CREATE UNIQUE INDEX idx_signup_requests_email_pending
      ON signup_requests(email)
      WHERE status = 'pending'
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_signup_requests_email_pending`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_signup_requests_status`.execute(db);
  await sql`DROP TABLE IF EXISTS signup_requests`.execute(db);
}
