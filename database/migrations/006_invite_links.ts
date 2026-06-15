import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE invite_links (
      id           UUID          NOT NULL DEFAULT gen_random_uuid(),
      token        TEXT          NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
      email        VARCHAR(255)  NULL,
      role         VARCHAR(30)   NOT NULL,
      created_by   UUID          NOT NULL REFERENCES staff(id),
      expires_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
      used_at      TIMESTAMPTZ,
      used_by      UUID          REFERENCES staff(id),
      CONSTRAINT invite_links_pkey         PRIMARY KEY (id),
      CONSTRAINT invite_links_token_unique UNIQUE (token),
      CONSTRAINT invite_links_role_check   CHECK (role IN ('admin','manager','team_member','freelancer'))
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS invite_links`.execute(db);
}
