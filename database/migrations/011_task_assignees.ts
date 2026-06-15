import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE task_assignees (
      task_id     UUID NOT NULL REFERENCES tasks(id)  ON DELETE CASCADE,
      staff_id    UUID NOT NULL REFERENCES staff(id),
      assigned_by UUID REFERENCES staff(id),
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT task_assignees_pkey PRIMARY KEY (task_id, staff_id)
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS task_assignees`.execute(db);
}
