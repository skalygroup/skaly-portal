import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE task_time_logs (
      id          UUID        NOT NULL DEFAULT gen_random_uuid(),
      task_id     UUID        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      staff_id    UUID        NOT NULL REFERENCES staff(id),
      started_at  TIMESTAMPTZ,
      ended_at    TIMESTAMPTZ,
      manual_mins INTEGER,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT task_time_logs_pkey PRIMARY KEY (id)
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS task_time_logs`.execute(db);
}
