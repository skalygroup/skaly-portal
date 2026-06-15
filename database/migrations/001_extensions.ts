import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`.execute(db);
  await sql`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`.execute(db);
  await sql`CREATE EXTENSION IF NOT EXISTS "pg_stat_statements"`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP EXTENSION IF EXISTS "pg_stat_statements"`.execute(db);
  await sql`DROP EXTENSION IF EXISTS "pg_trgm"`.execute(db);
  await sql`DROP EXTENSION IF EXISTS "uuid-ossp"`.execute(db);
}
