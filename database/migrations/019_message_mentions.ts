import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE message_mentions (
      message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      staff_id   UUID NOT NULL REFERENCES staff(id),
      CONSTRAINT message_mentions_pkey PRIMARY KEY (message_id, staff_id)
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS message_mentions`.execute(db);
}
