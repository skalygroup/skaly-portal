import { sql } from 'kysely';
import { db } from '../src/lib/db.js';
import { logger } from '../src/lib/logger.js';

async function main() {
  try {
    logger.info('Refreshing dashboard_org_stats...');
    await sql`REFRESH MATERIALIZED VIEW dashboard_org_stats`.execute(db);

    logger.info('Refreshing dashboard_staff_task_stats...');
    await sql`REFRESH MATERIALIZED VIEW dashboard_staff_task_stats`.execute(db);

    logger.info('✅ All dashboard views populated successfully');
    await db.destroy();
  } catch (err) {
    logger.error(err, 'Failed to refresh views');
    process.exit(1);
  }
}

main();
