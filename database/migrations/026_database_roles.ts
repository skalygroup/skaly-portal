import { Kysely, sql } from 'kysely';

/**
 * Applies the least-privilege role permissions documented in
 * 05-BACKEND-SCHEMA.md §11.
 *
 * The most important effect is the REVOKE on audit_log — this is what
 * makes the "append-only" claim actually enforceable at the database
 * level. Without this migration, audit_log can be mutated by any
 * application bug.
 *
 * NOTE: This migration runs as the database SUPERUSER (Railway-provisioned
 * connection). The role being granted/revoked TO is `skaly_app` — the
 * application connection user. If your Railway PostgreSQL setup uses a
 * different application user, change the role name below.
 *
 * Idempotency: Uses DO $$ blocks with IF NOT EXISTS for role creation,
 * and GRANT/REVOKE are naturally idempotent in PostgreSQL.
 */

const APP_ROLE = 'skaly_app';

export async function up(db: Kysely<any>): Promise<void> {
  // Create the application role if it doesn't exist (idempotent)
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sql.lit(APP_ROLE)}) THEN
        CREATE ROLE ${sql.raw(APP_ROLE)} WITH LOGIN;
      END IF;
    END
    $$
  `.execute(db);

  // Base grants — all tables get SELECT/INSERT/UPDATE
  await sql`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${sql.raw(APP_ROLE)}`.execute(db);

  // DELETE permissions — only the tables that support hard delete
  await sql`GRANT DELETE ON tasks, task_assignees, task_attachments TO ${sql.raw(APP_ROLE)}`.execute(db);
  await sql`GRANT DELETE ON shoot_schedules, content_pipelines, content_calendar TO ${sql.raw(APP_ROLE)}`.execute(db);
  await sql`GRANT DELETE ON messages, message_mentions, comments, notifications TO ${sql.raw(APP_ROLE)}`.execute(db);
  await sql`GRANT DELETE ON invite_links, bot_sessions TO ${sql.raw(APP_ROLE)}`.execute(db);

  // task_time_logs: SELECT + INSERT only — no DELETE endpoint in MVP
  await sql`REVOKE DELETE, UPDATE ON task_time_logs FROM ${sql.raw(APP_ROLE)}`.execute(db);
  await sql`GRANT SELECT, INSERT ON task_time_logs TO ${sql.raw(APP_ROLE)}`.execute(db);

  // ─── CRITICAL: audit_log is append-only ────────────────────────────────
  // This is the actual security control. Without this REVOKE, the
  // "tamper-proof audit log" claim is documentation only.
  await sql`REVOKE UPDATE, DELETE ON audit_log FROM ${sql.raw(APP_ROLE)}`.execute(db);

  // Sequence permissions for newly inserted rows
  await sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${sql.raw(APP_ROLE)}`.execute(db);

  // Future tables created in this schema inherit these defaults
  await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO ${sql.raw(APP_ROLE)}`.execute(db);
  await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${sql.raw(APP_ROLE)}`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Restore mutability — only used for a forced rollback. In practice,
  // this migration should never be rolled back on production.
  await sql`GRANT UPDATE, DELETE ON audit_log TO ${sql.raw(APP_ROLE)}`.execute(db);
  await sql`GRANT DELETE, UPDATE ON task_time_logs TO ${sql.raw(APP_ROLE)}`.execute(db);
}
