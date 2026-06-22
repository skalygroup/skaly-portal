import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE months (
      period        CHAR(7)      NOT NULL,
      label         VARCHAR(20)  NOT NULL,
      locked        BOOLEAN      NOT NULL DEFAULT FALSE,
      locked_at     TIMESTAMPTZ,
      locked_by     UUID,
      unlocked_at   TIMESTAMPTZ,
      unlocked_by   UUID,
      unlock_reason TEXT,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT months_pkey PRIMARY KEY (period),
      CONSTRAINT months_period_format CHECK (period ~ '^[0-9]{4}-[0-9]{2}$')
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS months`.execute(db);
}
