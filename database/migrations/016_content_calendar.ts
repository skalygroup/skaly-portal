import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE content_calendar (
      id          UUID        NOT NULL DEFAULT gen_random_uuid(),
      period      CHAR(7)     NOT NULL REFERENCES months(period),
      client_id   UUID        NOT NULL REFERENCES clients(id),
      date        DATE        NOT NULL,
      status      VARCHAR(20) NOT NULL DEFAULT 'No Activity',
      note        TEXT,
      source      VARCHAR(20) NULL,
      updated_by  UUID        REFERENCES staff(id),
      updated_at  TIMESTAMPTZ,
      version     INTEGER     NOT NULL DEFAULT 1,
      CONSTRAINT content_calendar_pkey     PRIMARY KEY (id),
      CONSTRAINT content_calendar_unique   UNIQUE (period, client_id, date),
      CONSTRAINT content_calendar_status   CHECK (status IN
        ('No Activity','Under Progress','Ready','Posted','Pending','Rescheduled')),
      CONSTRAINT content_calendar_source   CHECK (source IN ('manual','pipeline_trigger') OR source IS NULL)
    )
  `.execute(db);

  await sql`CREATE INDEX idx_calendar_period_date   ON content_calendar(period, date)`.execute(db);
  await sql`CREATE INDEX idx_calendar_period_client ON content_calendar(period, client_id)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_calendar_period_client`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_calendar_period_date`.execute(db);
  await sql`DROP TABLE IF EXISTS content_calendar`.execute(db);
}
