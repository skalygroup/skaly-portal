import { Migrator, FileMigrationProvider } from 'kysely';
import { promises as fs } from 'fs';
import path from 'path';
import { db } from '../src/lib/db.js';
import { logger } from '../src/lib/logger.js';

async function status() {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.resolve(process.cwd(), '../../database/migrations'),
    }),
  });
  const migrations = await migrator.getMigrations();
  logger.info('Migration status:');
  for (const m of migrations) {
    const applied = m.executedAt
      ? `✅ Applied at ${m.executedAt.toISOString()}`
      : '⏳ Pending';
    logger.info(`  ${m.name} — ${applied}`);
  }
  await db.destroy();
}
status();
