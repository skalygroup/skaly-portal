import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE holidays (
      id         UUID          NOT NULL DEFAULT gen_random_uuid(),
      period     CHAR(7)       NOT NULL REFERENCES months(period),
      date       DATE          NOT NULL,
      name       VARCHAR(100)  NOT NULL,
      active     BOOLEAN       NOT NULL DEFAULT TRUE,
      added_by   UUID          NOT NULL REFERENCES staff(id),
      removed_by UUID          REFERENCES staff(id),
      removed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT holidays_pkey        PRIMARY KEY (id),
      CONSTRAINT holidays_date_unique UNIQUE (period, date)
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS holidays`.execute(db);
}
