import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE clients (
      id                    UUID          NOT NULL DEFAULT gen_random_uuid(),
      name                  VARCHAR(255)  NOT NULL,
      is_internal           BOOLEAN       NOT NULL DEFAULT FALSE,
      active                BOOLEAN       NOT NULL DEFAULT TRUE,
      shoot_slots_per_month INTEGER       NOT NULL,
      pieces_per_visit      INTEGER       NOT NULL DEFAULT 1,
      whatsapp_number       VARCHAR(20),
      created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      deleted_at            TIMESTAMPTZ,
      CONSTRAINT clients_pkey             PRIMARY KEY (id),
      CONSTRAINT clients_slots_positive   CHECK (shoot_slots_per_month > 0),
      CONSTRAINT clients_pieces_positive  CHECK (pieces_per_visit > 0)
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS clients`.execute(db);
}
