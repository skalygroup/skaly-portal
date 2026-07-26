import { z } from 'zod';

import { getAnthropic } from '../../lib/anthropic.js';
import { logger } from '../../lib/logger.js';
import { redis } from '../../lib/redis.js';
import { BotService } from '../../services/BotService.js';
import { getIo } from '../../sockets/index.js';

import type { CurrentUser } from '../../services/AttendanceService.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

// ponytail: kept local rather than in @skaly/shared — the web panel validates the
// 2000-char cap inline and posts `decision`/`confirmationId` as plain fields, so
// this is still the only importing consumer. Move to shared if a third appears.
//
// `decision` is the confirmation gate (ADR-014 §1); `content` alongside it is only
// the display string archived to the transcript ("Yes, go ahead"). When `decision`
// is present the gate NEVER reads `content` — that is the whole point of the
// structured field, and Turn2Body's precedence chain enforces it.
const BotMessageSchema = z
  .object({
    content: z.string().min(1).max(2000),
    confirmationId: z.string().uuid().optional(),
    decision: z.enum(['confirm', 'cancel']).optional(),
  })
  .strict()
  // A decision without the id it applies to is a malformed request, not a stale
  // one. The server would resolve it to `stale_id` and answer politely, which is
  // safe but hides a frontend bug — the buttons always bind both.
  .refine((b) => b.decision === undefined || b.confirmationId !== undefined, {
    message: 'confirmationId is required when decision is present.',
    path: ['confirmationId'],
  });

const SessionViewSchema = z.object({
  sessionId: z.string().nullable(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
  turnCount: z.number(),
  lastActivityAt: z.string().nullable(),
});

function currentUser(request: FastifyRequest): CurrentUser {
  return { staffId: request.user.id, role: request.user.role };
}

/**
 * /v1/bot/* (mounted with /v1 in app.ts). The bot's reply never rides the HTTP
 * response (C-01) — POST returns a 202 acknowledgement and the tokens + card
 * stream over /ws/notify. All roles may POST; per-user tool permissions are
 * applied inside BotService.
 */
export default async function botRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Built per request: getIo() only exists after registerSockets(), and
  // getAnthropic() throws if the key is unconfigured — neither is safe at
  // module load. The Anthropic client itself is a process-wide singleton.
  const service = (): BotService => new BotService(getAnthropic(), redis, getIo());

  // ── POST /v1/bot/message — 202 ack; reply streams over the socket (C-01) ──
  r.post(
    '/bot/message',
    {
      preHandler: [app.verifyJwt],
      // 30/min per staff (§2). The limiter runs onRequest, before verifyJwt, so
      // key on the bearer token (per-staff session identity) — same precedent as
      // the tasks presign route.
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => req.headers.authorization ?? req.ip,
        },
      },
      schema: {
        body: BotMessageSchema,
        response: {
          202: z.object({ data: z.object({ messageId: z.string(), sessionId: z.string() }) }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      const bot = service();

      // Load the session (stable sessionId) + archive the user message
      // (messageId) BEFORE the 202, so a Redis/DB failure returns an error rather
      // than a false ack.
      const session = await bot.loadSession(user.staffId);
      const messageId = await bot.archiveUserMessage(user.staffId, request.body.content, app.db);

      // C-01: the body is an acknowledgement only — no content, no card.
      await reply.status(202).send({ data: { messageId, sessionId: session.sessionId } });

      // Fire-and-forget AFTER the reply is sent. The .catch is load-bearing: an
      // unhandled rejection here would take the process down, not just fail this
      // one message. handleMessage already finalizes its own errors onto the
      // socket; this only guards a throw before/around that.
      void bot
        .handleMessage({
          session,
          staffId: user.staffId,
          role: user.role,
          userText: request.body.content,
          db: app.db,
          // ADR-014: the client may send ONLY these two. Never the tool, never the
          // arguments, never the version — those live in the server's pending record.
          decision: request.body.decision,
          confirmationId: request.body.confirmationId,
        })
        .catch((err) => logger.error({ err, staffId: user.staffId }, 'bot handleMessage rejected'));

      return reply;
    },
  );

  // ── GET /v1/bot/session/current — restore conversation (or null shape) ──
  r.get(
    '/bot/session/current',
    {
      preHandler: [app.verifyJwt],
      schema: { response: { 200: z.object({ data: SessionViewSchema }) }, security: [{ bearerAuth: [] }] },
    },
    async (request) => ({ data: await service().sessionView(currentUser(request).staffId) }),
  );

  // ── DELETE /v1/bot/session/current — clear the session ──
  r.delete(
    '/bot/session/current',
    {
      preHandler: [app.verifyJwt],
      schema: { response: { 200: z.object({ data: z.object({ cleared: z.literal(true) }) }) }, security: [{ bearerAuth: [] }] },
    },
    async (request) => {
      await service().clearSession(currentUser(request).staffId);
      return { data: { cleared: true as const } };
    },
  );
}
