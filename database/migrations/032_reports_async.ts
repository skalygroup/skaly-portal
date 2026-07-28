import { Kysely, sql } from 'kysely';

/**
 * Make `reports` able to hold a request that has not finished yet (ADR-027).
 *
 * Migration 017 shaped this table for the synchronous design it was written under:
 * `file_key NOT NULL`, a single `generated_at`, no status. A row could only exist
 * once the PDF did — which is precisely what a `pending` record must do before the
 * worker starts. The table was never written to by any code, so there is no data
 * to migrate.
 *
 * Additive except for the NOT NULL drop on `file_key`, which relaxes (NFR §3.1).
 * Existing grants already cover this table: migration 026 grants SELECT, INSERT,
 * UPDATE on ALL TABLES in the schema, and 017 predates it.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE reports ALTER COLUMN file_key DROP NOT NULL`.execute(db);

  await sql`
    ALTER TABLE reports
      ADD COLUMN status        VARCHAR(10) NOT NULL DEFAULT 'pending',
      ADD COLUMN error_message TEXT,
      ADD COLUMN completed_at  TIMESTAMPTZ,
      ADD COLUMN filters       JSONB,
      ADD CONSTRAINT reports_status_check CHECK (status IN ('pending','ready','failed'))
  `.execute(db);

  // 017's `generated_at DEFAULT NOW()` is the request time, not the completion
  // time — `completed_at` above is the completion time. Renaming would churn the
  // existing index; the column keeps its name and gains a comment instead.
  await sql`
    COMMENT ON COLUMN reports.generated_at IS
      'When the report was REQUESTED. Completion is completed_at (ADR-027).'
  `.execute(db);

  // The panel lists a user's own recent reports, newest first.
  await sql`
    CREATE INDEX idx_reports_requester
      ON reports(generated_by, generated_at DESC)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_reports_requester`.execute(db);
  await sql`
    ALTER TABLE reports
      DROP CONSTRAINT IF EXISTS reports_status_check,
      DROP COLUMN IF EXISTS filters,
      DROP COLUMN IF EXISTS completed_at,
      DROP COLUMN IF EXISTS error_message,
      DROP COLUMN IF EXISTS status
  `.execute(db);
  // Fails if any pending/failed row is still holding a NULL file_key — correct,
  // since the old shape cannot represent one.
  await sql`ALTER TABLE reports ALTER COLUMN file_key SET NOT NULL`.execute(db);
}
