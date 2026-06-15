import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Trigram indexes for fuzzy search (client name, staff name)
  await sql`CREATE INDEX idx_clients_name_trgm ON clients USING GIN(name gin_trgm_ops)`.execute(db);
  await sql`CREATE INDEX idx_staff_name_trgm   ON staff   USING GIN(name gin_trgm_ops)`.execute(db);

  // Full-text search on comments
  await sql`
    ALTER TABLE comments ADD COLUMN search_vector TSVECTOR
      GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
  `.execute(db);
  await sql`CREATE INDEX idx_comments_search ON comments USING GIN(search_vector)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_comments_search`.execute(db);
  await sql`ALTER TABLE comments DROP COLUMN IF EXISTS search_vector`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_staff_name_trgm`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_clients_name_trgm`.execute(db);
}
