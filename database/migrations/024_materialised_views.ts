import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE MATERIALIZED VIEW dashboard_org_stats AS
    SELECT
      period,
      ROUND(
        100.0 * SUM(CASE WHEN present THEN 1 ELSE 0 END) /
        NULLIF(COUNT(*) FILTER (WHERE day_type = 'working'), 0),
        1
      ) AS attendance_pct,
      COUNT(DISTINCT staff_id) AS active_staff_count
    FROM attendance_logs
    GROUP BY period
  `.execute(db);

  await sql`CREATE UNIQUE INDEX ON dashboard_org_stats(period)`.execute(db);

  await sql`
    CREATE MATERIALIZED VIEW dashboard_staff_task_stats AS
    SELECT
      t.period,
      ta.staff_id,
      COUNT(*)                                                     AS total_assigned,
      COUNT(*) FILTER (WHERE t.status = 'Done')                   AS tasks_done,
      COUNT(*) FILTER (WHERE t.status NOT IN ('Done','Cancelled')) AS tasks_pending,
      COUNT(*) FILTER (WHERE t.deadline < CURRENT_DATE
        AND t.status NOT IN ('Done','Cancelled'))                  AS tasks_overdue
    FROM tasks t
    JOIN task_assignees ta ON ta.task_id = t.id
    WHERE t.deleted_at IS NULL
    GROUP BY t.period, ta.staff_id
  `.execute(db);

  await sql`CREATE UNIQUE INDEX ON dashboard_staff_task_stats(period, staff_id)`.execute(db);

  // Initial population (NON-CONCURRENTLY) — per audit H-03.
  // CONCURRENTLY is not allowed on an empty materialised view.
  await sql`REFRESH MATERIALIZED VIEW dashboard_org_stats`.execute(db);
  await sql`REFRESH MATERIALIZED VIEW dashboard_staff_task_stats`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP MATERIALIZED VIEW IF EXISTS dashboard_staff_task_stats`.execute(db);
  await sql`DROP MATERIALIZED VIEW IF EXISTS dashboard_org_stats`.execute(db);
}
