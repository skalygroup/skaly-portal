// Usage: pnpm --filter @skaly/api db:refresh-views
//
// Refreshes both dashboard materialised views NON-CONCURRENTLY.
// Use this after restoring backups or loading seed data on dev / staging.
// In production, the post-rollover job uses CONCURRENTLY.

import { sql } from 'kysely';
import { db } from '../src/lib/db.js';
import { logger } from '../src/lib/logger.js';

async function main() {
  logger.info('Refreshing dashboard_org_stats...');
  await sql`REFRESH MATERIALIZED VIEW dashboard_org_stats`.execute(db);

  logger.info('Refreshing dashboard_staff_task_stats...');
  await sql`REFRESH MATERIALIZED VIEW dashboard_staff_task_stats`.execute(db);

  logger.info('✅ Done.');
  await db.destroy();
}

main().catch((err) => {
  logger.error(err, 'Failed to refresh materialised views');
  process.exit(1);
});
