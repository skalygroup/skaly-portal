import { buildApp } from './app.js';
import { pool } from './lib/db.js';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { registerSockets } from './sockets/index.js';

/**
 * Listening entrypoint. Builds the app (src/app.ts), starts the HTTP server,
 * then attaches Socket.io to the raw server. Any startup failure logs and
 * exits non-zero; SIGINT/SIGTERM trigger graceful shutdown.
 */
const start = async () => {
  try {
    const app = await buildApp({ loggerInstance: logger });

    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info(`🚀 Skaly API listening on http://0.0.0.0:${env.PORT}`);

    // Socket.io binds to the raw HTTP server, which exists once listening.
    const { pubClient, subClient } = registerSockets(app.server);

    // ── Graceful shutdown ────────────────────────────────────────────
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully…`);
      await app.close();
      await pool.end();
      redis.disconnect();
      pubClient.disconnect();
      subClient.disconnect();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
};

start();
