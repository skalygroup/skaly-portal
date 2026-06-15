import { Migrator, FileMigrationProvider } from 'kysely';
import { promises as fs } from 'fs';
import path from 'path';
import { db } from '../src/lib/db.js';
import { logger } from '../src/lib/logger.js';

async function migrateToLatest() {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.resolve(process.cwd(), '../../database/migrations'),
    }),
  });
  const { error, results } = await migrator.migrateToLatest();
  results?.forEach((r) => {
    if (r.status === 'Success') logger.info(`✅ Migration ${r.migrationName} applied`);
    else if (r.status === 'Error') logger.error(`❌ Migration ${r.migrationName} failed`);
  });
  if (error) { logger.error(error); process.exit(1); }
  await db.destroy();
}
migrateToLatest();
