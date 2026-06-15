import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE bot_sessions (
      id               UUID        NOT NULL DEFAULT gen_random_uuid(),
      staff_id         UUID        NOT NULL REFERENCES staff(id),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT bot_sessions_pkey PRIMARY KEY (id)
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS bot_sessions`.execute(db);
}
