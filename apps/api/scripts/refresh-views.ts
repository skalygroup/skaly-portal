import { sql } from 'kysely';

import { db } from '../src/lib/db.js';
import { logger } from '../src/lib/logger.js';

async function main() {
  try {
    // CONCURRENTLY avoids locking reads during refresh. Requires the
    // UNIQUE indexes created in migration 024. The initial population
    // in 024 is non-concurrent (CONCURRENTLY can't run on an empty view).
    logger.info('Refreshing dashboard_org_stats...');
    await sql`REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_org_stats`.execute(db);

    logger.info('Refreshing dashboard_staff_task_stats...');
    await sql`REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_staff_task_stats`.execute(db);

    logger.info('✅ All dashboard views populated successfully');
    await db.destroy();
  } catch (err) {
    logger.error(err, 'Failed to refresh views');
    process.exit(1);
  }
}

main();
