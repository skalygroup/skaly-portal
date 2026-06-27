import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { Kysely, PostgresDialect } from 'kysely';
// kysely 0.29 moved the migration API out of the main entry into `kysely/migration`.
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../database/migrations');

// Custom provider: converts Windows paths to file:// URLs before dynamic import
class ESMFileMigrationProvider implements MigrationProvider {
  constructor(private migrationFolder: string) { }

  async getMigrations(): Promise<Record<string, Migration>> {
    const migrations: Record<string, Migration> = {};
    const files = (await fs.readdir(this.migrationFolder)).sort();

    for (const fileName of files) {
      if (!fileName.endsWith('.ts') && !fileName.endsWith('.js')) continue;
      const fullPath = path.join(this.migrationFolder, fileName);
      const fileUrl = pathToFileURL(fullPath).href;
      const mod = await import(fileUrl);
      const key = fileName.substring(0, fileName.lastIndexOf('.'));
      migrations[key] = mod;
    }
    return migrations;
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[migrate] FATAL: DATABASE_URL not set in apps/api/.env');
    process.exit(1);
  }
  console.log('[migrate] target:', new URL(databaseUrl).host);
  console.log('[migrate] migrations folder:', MIGRATIONS_DIR);

  const db = new Kysely<any>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: databaseUrl, max: 1 }),
    }),
  });

  try {
    await db.selectFrom('pg_catalog.pg_tables' as any).select('tablename' as any).limit(1).execute();
    console.log('[migrate] DB connection OK');
  } catch (err) {
    console.error('[migrate] FATAL: cannot connect:', err);
    process.exit(1);
  }

  const files = await fs.readdir(MIGRATIONS_DIR);
  const tsFiles = files.filter((f) => f.endsWith('.ts'));
  console.log(`[migrate] found ${tsFiles.length} migration files`);

  const migrator = new Migrator({
    db,
    provider: new ESMFileMigrationProvider(MIGRATIONS_DIR),
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((r) => {
    if (r.status === 'Success') console.log(`✅ ${r.migrationName}`);
    else if (r.status === 'Error') console.error(`❌ ${r.migrationName}`);
    else console.log(`⏸  ${r.migrationName} — ${r.status}`);
  });

  if (error) {
    console.error('[migrate] migration error:', error);
    await db.destroy();
    process.exit(1);
  }

  console.log('[migrate] all migrations applied');
  await db.destroy();
}

main().catch((err) => {
  console.error('[migrate] unhandled:', err);
  process.exit(1);
});