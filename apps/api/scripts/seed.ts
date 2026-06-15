// Usage: pnpm --filter @skaly/api db:seed
//
// Runs seed files from database/seeds/ directory.
// Seeds are executed in filename order.

import { promises as fs } from 'fs';
import path from 'path';
import { db } from '../src/lib/db.js';
import { logger } from '../src/lib/logger.js';

async function seed() {
  const seedDir = path.resolve(process.cwd(), '../../database/seeds');

  try {
    await fs.access(seedDir);
  } catch {
    logger.warn('No database/seeds/ directory found. Skipping.');
    await db.destroy();
    return;
  }

  const files = (await fs.readdir(seedDir))
    .filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
    .sort();

  for (const file of files) {
    logger.info(`🌱 Running seed: ${file}`);
    const mod = await import(path.join(seedDir, file));
    if (typeof mod.seed === 'function') {
      await mod.seed(db);
    } else {
      logger.warn(`  ⚠ ${file} has no exported seed() function, skipping.`);
    }
  }

  logger.info('✅ All seeds complete.');
  await db.destroy();
}

seed().catch((err) => {
  logger.error(err, 'Seed failed');
  process.exit(1);
});
