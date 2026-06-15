import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE content_pipelines (
      id                    UUID          NOT NULL DEFAULT gen_random_uuid(),
      period                CHAR(7)       NOT NULL REFERENCES months(period),
      client_id             UUID          NOT NULL REFERENCES clients(id),
      visit_type            VARCHAR(50),
      last_shoot_date       DATE,
      raw_received_at       TIMESTAMPTZ,
      finals_ready_at       TIMESTAMPTZ,
      posted_at             TIMESTAMPTZ,
      coming_shoot_date     DATE,
      coming_shoot_source   VARCHAR(10),
      updated_by            UUID          REFERENCES staff(id),
      version               INTEGER       NOT NULL DEFAULT 1,
      CONSTRAINT content_pipelines_pkey           PRIMARY KEY (id),
      CONSTRAINT content_pipelines_unique         UNIQUE (period, client_id),
      CONSTRAINT content_pipelines_shoot_source   CHECK (coming_shoot_source IN ('trigger','manual') OR coming_shoot_source IS NULL)
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS content_pipelines`.execute(db);
}
