import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { setupSocketTokenWatcher } from '../middleware/socketTokenWatcher.plugin.js';

export interface SocketSetup {
  io: Server;
  pubClient: Redis;
  subClient: Redis;
}

/**
 * Boots Socket.io against the listening HTTP server (TRD §8).
 *
 * Socket.io binds to the raw HTTP server, not the Fastify instance, so this is
 * called from server.ts after listen() — not from buildApp(). Returns the io
 * server plus its Redis pub/sub clients so the entrypoint can disconnect them
 * during graceful shutdown.
 */
export function registerSockets(httpServer: HttpServer): SocketSetup {
  const io = new Server(httpServer, {
    cors: {
      origin: env.CORS_ALLOWED_ORIGINS,
      credentials: true,
    },
  });

  const pubClient = new Redis(
    env.REDIS_URL,
    env.REDIS_URL.startsWith('rediss://') ? { tls: {} } : {},
  );
  const subClient = pubClient.duplicate();
  // Attach error handlers so transient Upstash/connection blips are logged
  // instead of emitting "missing 'error' handler" warnings or crashing.
  pubClient.on('error', (err) => logger.error({ err }, 'Redis pub client error'));
  subClient.on('error', (err) => logger.error({ err }, 'Redis sub client error'));
  io.adapter(createAdapter(pubClient, subClient));

  // ── Socket.io JWT refresh watcher (C-05) ───────────────────────────
  setupSocketTokenWatcher(io);

  return { io, pubClient, subClient };
}
