import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE user_permissions (
      id              UUID          NOT NULL DEFAULT gen_random_uuid(),
      staff_id        UUID          NOT NULL REFERENCES staff(id),
      permission_key  VARCHAR(100)  NOT NULL,
      value           BOOLEAN       NOT NULL,
      set_by          UUID          REFERENCES staff(id),
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT user_permissions_pkey   PRIMARY KEY (id),
      CONSTRAINT user_permissions_unique UNIQUE (staff_id, permission_key)
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS user_permissions`.execute(db);
}
