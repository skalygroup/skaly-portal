import { Kysely, sql } from 'kysely';

/**
 * Let a removed holiday's date be reused.
 *
 * `holidays_date_unique UNIQUE (period, date)` covered removed rows too, so soft
 * delete permanently burned the date: re-adding a holiday you had removed hit the
 * constraint and POST /v1/holidays answered a raw 500. A UNIQUE constraint that
 * ignores the soft-delete flag is the bug — removing something has to actually
 * free the slot it occupied.
 *
 * A partial unique index is the whole fix, and it keeps the guarantee that matters:
 * at most one ACTIVE holiday per (period, date). Removed rows stay in the table for
 * audit and no longer collide.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE holidays DROP CONSTRAINT holidays_date_unique`.execute(db);
  await sql`
    CREATE UNIQUE INDEX holidays_date_unique
      ON holidays(period, date)
      WHERE active
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Only reversible while no date carries both an active and a removed row —
  // exactly the state the constraint used to forbid.
  await sql`DROP INDEX IF EXISTS holidays_date_unique`.execute(db);
  await sql`
    ALTER TABLE holidays
      ADD CONSTRAINT holidays_date_unique UNIQUE (period, date)
  `.execute(db);
}
