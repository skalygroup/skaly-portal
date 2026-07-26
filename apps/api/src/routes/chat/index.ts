import {
  CHAT_PAGE_LIMIT,
  ChatDeleteResponseSchema,
  ChatListQuerySchema,
  ChatListResponseSchema,
  ChatSearchQuerySchema,
  ChatSendResponseSchema,
  ChatSendSchema,
  ChatThreadResponseSchema,
} from '@skaly/shared';
import { z } from 'zod';

import { emitAfterCommit, transactionWithEmits } from '../../lib/emit-after-commit.js';
import { ChatService } from '../../services/ChatService.js';

import type { CurrentUser } from '../../services/AttendanceService.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/**
 * /v1/chat/* — mounted with the /v1 prefix in app.ts.
 *
 * ACCESS IS A PERMISSION, NOT A ROLE. Every route is `verifyJwt` only; the
 * `chat.access` check lives in ChatService (Auth-Matrix §3 marks /chat 🔧 for
 * freelancers — default-denied, admin-grantable). A `requireRole` here would be both
 * wrong (it cannot express an override) and redundant with the service gate that
 * actually protects the data.
 *
 * SOCKET EVENTS go out on the EXISTING /ws/chat namespace (ADR-005 — no fourth
 * namespace; sockets/index.ts:22 already declares it).
 */
const CHAT_NAMESPACE = '/ws/chat';
const CHAT_ROOM = 'org:all';

export default async function chatRoutes(app: FastifyInstance) {
  const service = new ChatService(app.redis);
  const r = app.withTypeProvider<ZodTypeProvider>();

  const authed = { preHandler: [app.verifyJwt] };
  const userOf = (request: FastifyRequest): CurrentUser => ({
    staffId: request.user!.id,
    role: request.user!.role,
  });

  r.get(
    '/chat/messages',
    {
      ...authed,
      schema: {
        querystring: ChatListQuerySchema,
        response: { 200: ChatListResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const page = await service.list(
        { limit: request.query.limit ?? CHAT_PAGE_LIMIT, cursor: request.query.cursor },
        userOf(request),
        app.db,
      );
      return { data: page.messages, meta: { nextCursor: page.nextCursor } };
    },
  );

  r.post(
    '/chat/messages',
    {
      ...authed,
      schema: {
        body: ChatSendSchema,
        response: { 201: ChatSendResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const currentUser = userOf(request);
      const message = await transactionWithEmits(app.db, (trx) =>
        service.send({ content: request.body.content, parentId: request.body.parentId }, currentUser, trx),
      );

      // Queued inside the transaction, delivered on COMMIT. A rolled-back send that
      // had already broadcast would leave every other client holding a message the
      // database never kept — and under ADR-022 they PATCH from this payload, so
      // nothing would come along to correct them.
      //
      // The payload is the complete message so clients append without refetching.
      emitAfterCommit(CHAT_NAMESPACE, CHAT_ROOM, 'chat:message', {
        ...message,
        // Client-side half of the sender-exclusion guard (ADR-022 rule b). The server
        // half is the socket handler's broadcast; this covers the REST path, where
        // there is no originating socket to exclude.
        actorStaffId: currentUser.staffId,
      });

      return reply.status(201).send({ data: message });
    },
  );

  r.get(
    '/chat/messages/:id/thread',
    {
      ...authed,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: ChatThreadResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => ({
      data: await service.getThread(request.params.id, userOf(request), app.db),
    }),
  );

  r.delete(
    '/chat/messages/:id',
    {
      ...authed,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: ChatDeleteResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const currentUser = userOf(request);
      await transactionWithEmits(app.db, (trx) => service.remove(request.params.id, currentUser, trx));

      // Clients TOMBSTONE from this rather than refetching — the row still exists and
      // its replies must stay put, so removing it client-side would reflow the
      // conversation under whoever is reading it.
      emitAfterCommit(CHAT_NAMESPACE, CHAT_ROOM, 'chat:deleted', {
        id: request.params.id,
        actorStaffId: currentUser.staffId,
      });

      return { data: { deleted: true as const } };
    },
  );

  r.get(
    '/chat/search',
    {
      ...authed,
      schema: {
        querystring: ChatSearchQuerySchema,
        response: { 200: ChatThreadResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => ({
      // Separate from Sprint 9's /v1/search by design (ADR-015): `messages` is not one
      // of global search's four categories, and merging them would surface chat
      // content in a palette a freelancer can open without chat.access.
      data: await service.search(request.query.q, userOf(request), app.db, request.query.limit),
    }),
  );
}
