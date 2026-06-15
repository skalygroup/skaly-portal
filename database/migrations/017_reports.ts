import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE reports (
      id            UUID        NOT NULL DEFAULT gen_random_uuid(),
      period        CHAR(7)     NOT NULL REFERENCES months(period),
      type          VARCHAR(30) NOT NULL,
      client_id     UUID        REFERENCES clients(id),
      file_key      TEXT        NOT NULL,
      generated_by  UUID        NOT NULL REFERENCES staff(id),
      generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT reports_pkey        PRIMARY KEY (id),
      CONSTRAINT reports_type_check  CHECK (type IN ('client_monthly','org_monthly'))
    )
  `.execute(db);

  await sql`CREATE INDEX idx_reports_period ON reports(period, generated_at DESC)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_reports_period`.execute(db);
  await sql`DROP TABLE IF EXISTS reports`.execute(db);
}
