import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE comments (
      id               UUID        NOT NULL DEFAULT gen_random_uuid(),
      module           VARCHAR(25) NOT NULL,
      record_id        UUID        NOT NULL,
      period           CHAR(7)     NOT NULL REFERENCES months(period),
      staff_id         UUID        NOT NULL REFERENCES staff(id),
      content          TEXT        NOT NULL,
      record_context   TEXT        NOT NULL,
      acknowledged_by  UUID        REFERENCES staff(id),
      acknowledged_at  TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT comments_pkey          PRIMARY KEY (id),
      CONSTRAINT comments_module_check  CHECK (module IN ('shoot_planner','content_dropper','content_calendar'))
    )
  `.execute(db);

  await sql`CREATE INDEX idx_comments_record ON comments(module, record_id, period)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_comments_record`.execute(db);
  await sql`DROP TABLE IF EXISTS comments`.execute(db);
}
