import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE messages (
      id            UUID        NOT NULL DEFAULT gen_random_uuid(),
      channel       VARCHAR(10) NOT NULL,
      sender_id     UUID        REFERENCES staff(id),
      sender_type   VARCHAR(10) NOT NULL DEFAULT 'user',
      content       TEXT        NOT NULL,
      content_type  VARCHAR(15) NOT NULL DEFAULT 'text',
      parent_id     UUID        REFERENCES messages(id),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      edited_at     TIMESTAMPTZ,
      deleted_at    TIMESTAMPTZ,
      CONSTRAINT messages_pkey           PRIMARY KEY (id),
      CONSTRAINT messages_channel_check  CHECK (channel IN ('common','bot')),
      CONSTRAINT messages_type_check     CHECK (sender_type IN ('user','bot','system')),
      CONSTRAINT messages_content_check  CHECK (content_type IN ('text','tool_result','system'))
    )
  `.execute(db);

  await sql`
    ALTER TABLE messages ADD COLUMN search_vector TSVECTOR
      GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
  `.execute(db);

  await sql`CREATE INDEX idx_messages_channel ON messages(channel, created_at DESC) WHERE deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX idx_messages_parent  ON messages(parent_id) WHERE parent_id IS NOT NULL`.execute(db);
  await sql`CREATE INDEX idx_messages_search  ON messages USING GIN(search_vector)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_messages_search`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_messages_parent`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_messages_channel`.execute(db);
  await sql`DROP TABLE IF EXISTS messages`.execute(db);
}
