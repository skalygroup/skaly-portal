import { Redis } from 'ioredis';

import { env } from './env.js';
import { logger } from './logger.js';

export const redis = new Redis(
  env.REDIS_URL,
  env.REDIS_URL.startsWith('rediss://') ? { tls: {} } : {},
);

// Without an 'error' listener ioredis emits the noisy "missing 'error'
// handler on this Redis client" warning and an unhandled connection error
// can crash the process. Log instead; ioredis retries automatically.
redis.on('error', (err) => {
  logger.error({ err }, 'Redis client error');
});
