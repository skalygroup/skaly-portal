import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`.execute(db);
  // pgcrypto provides gen_random_bytes() — required by 006_invite_links
  // for secure invite-token generation. (gen_random_uuid() is built-in
  // in PG13+, but gen_random_bytes() still lives in pgcrypto.)
  await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`.execute(db);
  await sql`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`.execute(db);
  await sql`CREATE EXTENSION IF NOT EXISTS "pg_stat_statements"`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP EXTENSION IF EXISTS "pg_stat_statements"`.execute(db);
  await sql`DROP EXTENSION IF EXISTS "pg_trgm"`.execute(db);
  await sql`DROP EXTENSION IF EXISTS "pgcrypto"`.execute(db);
  await sql`DROP EXTENSION IF EXISTS "uuid-ossp"`.execute(db);
}
