import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE attendance_logs (
      id          UUID        NOT NULL DEFAULT gen_random_uuid(),
      period      CHAR(7)     NOT NULL REFERENCES months(period),
      staff_id    UUID        NOT NULL REFERENCES staff(id),
      date        DATE        NOT NULL,
      day_type    VARCHAR(10) NOT NULL DEFAULT 'working',
      present     BOOLEAN     NOT NULL DEFAULT FALSE,
      work_log    TEXT,
      updated_at  TIMESTAMPTZ,
      updated_by  UUID        REFERENCES staff(id),
      version     INTEGER     NOT NULL DEFAULT 1,
      CONSTRAINT attendance_pkey      PRIMARY KEY (id),
      CONSTRAINT attendance_unique    UNIQUE (period, staff_id, date),
      CONSTRAINT attendance_day_type  CHECK (day_type IN ('working','sunday','holiday'))
    )
  `.execute(db);

  await sql`CREATE INDEX idx_att_period_date  ON attendance_logs(period, date)`.execute(db);
  await sql`CREATE INDEX idx_att_period_staff ON attendance_logs(period, staff_id)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_att_period_staff`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_att_period_date`.execute(db);
  await sql`DROP TABLE IF EXISTS attendance_logs`.execute(db);
}
