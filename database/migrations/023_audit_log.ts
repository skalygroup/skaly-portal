import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE audit_log (
      id                 UUID        NOT NULL DEFAULT gen_random_uuid(),
      staff_id           UUID        NOT NULL REFERENCES staff(id),
      changed_by_source  VARCHAR(10) NOT NULL DEFAULT 'user',
      table_name         VARCHAR(50) NOT NULL,
      record_id          UUID,
      action             VARCHAR(15) NOT NULL,
      old_value          JSONB,
      new_value          JSONB,
      ip_address         INET,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT audit_log_pkey        PRIMARY KEY (id),
      CONSTRAINT audit_log_source_check CHECK (changed_by_source IN ('user','system','bot')),
      CONSTRAINT audit_log_action_check CHECK (action IN ('INSERT','UPDATE','DELETE','LOCK','UNLOCK','DEACTIVATE'))
    )
  `.execute(db);

  await sql`CREATE INDEX idx_audit_staff_time ON audit_log(staff_id, created_at DESC)`.execute(db);
  await sql`CREATE INDEX idx_audit_table      ON audit_log(table_name, record_id)`.execute(db);
  await sql`CREATE INDEX idx_audit_time       ON audit_log(created_at DESC)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_audit_time`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_audit_table`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_audit_staff_time`.execute(db);
  await sql`DROP TABLE IF EXISTS audit_log`.execute(db);
}
