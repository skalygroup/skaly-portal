import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { Server } from 'socket.io';

import { attachPresence } from './presence.js';
import { verifySupabaseToken } from '../lib/auth-verify.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { setupSocketTokenWatcher } from '../middleware/socketTokenWatcher.plugin.js';


import type { Server as HttpServer } from 'node:http';
import type { Namespace, Socket } from 'socket.io';

export interface SocketSetup {
  io: Server;
  pubClient: Redis;
  subClient: Redis;
}

/** The three canonical namespaces (02-TRD §8). Order is the boot-log order. */
export const SOCKET_NAMESPACES = ['/ws/chat', '/ws/presence', '/ws/notify'] as const;

// Set once by registerSockets() at boot so services (NotificationService, STEP
// 8) can reach the live io — e.g. getIo().of('/ws/notify').to('user:'+id).emit().
let ioInstance: Server | null = null;

/** The initialised Socket.io server. Throws if called before registerSockets(). */
export function getIo(): Server {
  if (!ioInstance) {
    throw new Error('Socket.io not initialised — registerSockets() has not run yet.');
  }
  return ioInstance;
}

/**
 * Handshake auth, shared by all three namespaces. Reads the token from
 * socket.handshake.auth.token and reuses the HTTP verifier — one source of truth
 * for "is this token valid + who is it". On success attaches { staffId, role }
 * to socket.data; on any failure the connection is refused.
 */
async function handshakeAuth(socket: Socket, next: (err?: Error) => void): Promise<void> {
  try {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length === 0) {
      next(new Error('UNAUTHORIZED'));
      return;
    }
    const user = await verifySupabaseToken(token);
    if (user.active === false) {
      next(new Error('ACCOUNT_DEACTIVATED'));
      return;
    }
    socket.data.staffId = user.id;
    socket.data.role = user.role;
    next();
  } catch {
    next(new Error('UNAUTHORIZED'));
  }
}

/**
 * Room joins run on every authenticated connect across all namespaces (audit
 * H-05 preview; full test in Sprint 10). Personal + role + org-wide.
 */
function joinRooms(socket: Socket): void {
  const staffId = socket.data.staffId as string;
  const role = socket.data.role as string;
  void socket.join(`user:${staffId}`);
  void socket.join(`role:${role}`);
  void socket.join('org:all');
}

/**
 * Boots Socket.io against the listening HTTP server (02-TRD §8): the Redis
 * adapter (so Railway rolling deploys don't drop broadcasts), the three
 * canonical namespaces, JWT handshake auth reusing the HTTP verifier, room
 * joins, the C-05 token watcher, and Redis presence on /ws/presence.
 *
 * Called from server.ts after listen() — Socket.io binds to the raw HTTP
 * server, not the Fastify instance. Returns the io server plus its Redis
 * pub/sub clients so the entrypoint can disconnect them on shutdown.
 */
export function registerSockets(httpServer: HttpServer): SocketSetup {
  const io = new Server(httpServer, {
    cors: { origin: env.CORS_ALLOWED_ORIGINS, credentials: true },
    // Client tunes reconnection (02-TRD §8: delay 1s, max 30s, infinite
    // attempts); the server keeps Socket.io's defaults, which those satisfy.
  });

  // ── Redis adapter (Sprint 0 DoD) ───────────────────────────────────
  const pubClient = new Redis(env.REDIS_URL, env.REDIS_URL.startsWith('rediss://') ? { tls: {} } : {});
  const subClient = pubClient.duplicate();
  pubClient.on('error', (err) => logger.error({ err }, 'Redis pub client error'));
  subClient.on('error', (err) => logger.error({ err }, 'Redis sub client error'));
  io.adapter(createAdapter(pubClient, subClient));

  // ── Per-namespace: auth → token watcher (C-05) → room joins → presence ─
  for (const path of SOCKET_NAMESPACES) {
    const nsp: Namespace = io.of(path);

    // Handshake auth runs before 'connection'; a refused socket never connects.
    nsp.use((socket, next) => {
      void handshakeAuth(socket, next);
    });

    // C-05 JWT refresh/disconnect watcher — the existing Sprint 0 plugin,
    // applied per namespace (not reimplemented).
    setupSocketTokenWatcher(nsp);

    nsp.on('connection', (socket) => {
      joinRooms(socket);
      if (path === '/ws/presence') {
        attachPresence(socket, socket.data.staffId as string);
      }
    });
  }

  ioInstance = io;
  logger.info(`socket.io listening on ${SOCKET_NAMESPACES.join(',')}`);

  return { io, pubClient, subClient };
}