import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE task_attachments (
      id           UUID          NOT NULL DEFAULT gen_random_uuid(),
      task_id      UUID          NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      file_name    VARCHAR(255)  NOT NULL,
      file_key     TEXT          NOT NULL,
      file_size    BIGINT        NOT NULL,
      mime_type    VARCHAR(100),
      uploaded_by  UUID          NOT NULL REFERENCES staff(id),
      uploaded_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT task_attachments_pkey PRIMARY KEY (id)
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS task_attachments`.execute(db);
}
