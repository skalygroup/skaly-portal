import { db } from '../src/lib/db.js';
import { logger } from '../src/lib/logger.js';
import { seedSystemActor } from '../../database/seeds/001_system_actor.js';
import { seedDevData } from '../../database/seeds/002_dev_data.js';

async function run() {
  try {
    await seedSystemActor(db);
    logger.info('✅ System actor seeded');
    await seedDevData(db);
    logger.info('✅ Dev data seeded (if non-production)');
  } catch (err) {
    logger.error(err);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}
run();
