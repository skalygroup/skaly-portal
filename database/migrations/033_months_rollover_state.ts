import { Kysely, sql } from 'kysely';

/**
 * Rollover idempotency state on `months` (ADR-037) + the reason the dashboard
 * views' unique indexes exist (ADR-035).
 *
 * The `months` ROW ITSELF is the create-if-absent idempotency key — that needs no
 * column, `period` is already the primary key. These three columns track what
 * happens AFTER Tier 1 commits, so a retry that arrives mid-way resumes instead
 * of re-running (ADR-037 §2):
 *
 *   rollover_completed_at — set inside Tier 1, at its commit. This, not the row's
 *                           presence, is the completion signal: a months row can
 *                           pre-exist without any rollover having made it (the
 *                           seed creates the current month; an admin can lock a
 *                           future one).
 *   view_refreshed_at     — set on Tier 2 success. NULL with completed_at set is
 *                           exactly the resume-Tier-2-only state.
 *   rollover_failed_step  — set when a POST-commit step fails. A Tier 1 failure
 *                           rolls this row back with everything else, so that
 *                           case threads the step through the error instead
 *                           (ADR-036 §5) and never reaches here.
 *
 * Additive only (NFR §3.1) — all three nullable, no default, no backfill. Existing
 * months rows read as "not rolled over by this mechanism", which is true.
 *
 * The view indexes: `024_materialised_views.ts` already created them, unnamed, so
 * Postgres auto-named them `<view>_<cols>_idx`. They are NOT query-performance
 * indexes — `REFRESH MATERIALIZED VIEW CONCURRENTLY` refuses to run without a
 * unique index, and without CONCURRENTLY the refresh takes ACCESS EXCLUSIVE and
 * blocks every dashboard read for its duration, contradicting NFR §3.1's "API
 * fully operational during 00:01–00:05". A comment is the only thing standing
 * between a future index audit and a 4-minute dashboard outage every month.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE months
      ADD COLUMN rollover_completed_at TIMESTAMPTZ,
      ADD COLUMN view_refreshed_at     TIMESTAMPTZ,
      ADD COLUMN rollover_failed_step  TEXT
  `.execute(db);

  await sql`
    COMMENT ON COLUMN months.rollover_completed_at IS
      'Tier 1 commit time (ADR-035/037). The completion signal — NOT the row''s presence.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN months.view_refreshed_at IS
      'Tier 2 success time (ADR-035). NULL while completed_at is set = resume Tier 2 only.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN months.rollover_failed_step IS
      'Last failed POST-commit step (ADR-037). Tier 1 failures roll back and thread the step through the error instead.'
  `.execute(db);

  await sql`
    COMMENT ON INDEX dashboard_org_stats_period_idx IS
      'REQUIRED by REFRESH MATERIALIZED VIEW CONCURRENTLY (ADR-035). Not a query index — do not drop as redundant.'
  `.execute(db);
  await sql`
    COMMENT ON INDEX dashboard_staff_task_stats_period_staff_id_idx IS
      'REQUIRED by REFRESH MATERIALIZED VIEW CONCURRENTLY (ADR-035). Not a query index — do not drop as redundant.'
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE months
      DROP COLUMN IF EXISTS rollover_failed_step,
      DROP COLUMN IF EXISTS view_refreshed_at,
      DROP COLUMN IF EXISTS rollover_completed_at
  `.execute(db);
  // The index comments go with the indexes, which 024 owns — nothing to reverse.
}
