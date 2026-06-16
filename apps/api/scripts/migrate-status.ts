import 'dotenv/config';
import { Kysely, PostgresDialect, Migrator, type Migration, type MigrationProvider } from 'kysely';
import pg from 'pg';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../database/migrations');

// Custom provider: converts Windows paths to file:// URLs before dynamic import
class ESMFileMigrationProvider implements MigrationProvider {
  constructor(private migrationFolder: string) {}

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
    console.error('[status] FATAL: DATABASE_URL not set in apps/api/.env');
    process.exit(1);
  }
  console.log('[status] target:', new URL(databaseUrl).host);
  console.log('[status] migrations folder:', MIGRATIONS_DIR);

  const db = new Kysely<any>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: databaseUrl, max: 1 }),
    }),
  });

  try {
    await db.selectFrom('pg_catalog.pg_tables' as any).select('tablename' as any).limit(1).execute();
    console.log('[status] DB connection OK');
  } catch (err) {
    console.error('[status] FATAL: cannot connect:', err);
    process.exit(1);
  }

  const migrator = new Migrator({
    db,
    provider: new ESMFileMigrationProvider(MIGRATIONS_DIR),
  });

  const migrations = await migrator.getMigrations();

  console.log('\nMigration Status:');
  console.log('─'.repeat(80));
  for (const m of migrations) {
    const status = m.executedAt ? `✅ Applied at ${m.executedAt.toISOString()}` : '⏸  Pending';
    console.log(`${status}  ${m.name}`);
  }
  console.log('─'.repeat(80));
  console.log(`Total: ${migrations.length} | Applied: ${migrations.filter(m => m.executedAt).length} | Pending: ${migrations.filter(m => !m.executedAt).length}\n`);

  await db.destroy();
}

main().catch((err) => {
  console.error('[status] unhandled:', err);
  process.exit(1);
});