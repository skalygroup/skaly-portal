/**
 * /v1/comments (07-API-CONTRACT §Comments). Mounted with the /v1 prefix in app.ts.
 *
 * OPEN TO ALL FOUR ROLES AT THE ROUTE — the service filters, per row, via the
 * shared `commentVisibility()` fragment. Same division as search and the shoot
 * planner (ADR-011, ADR-032): a route-level role gate here would be a second,
 * coarser permission implementation that can only disagree with the first.
 *
 * The one exception is acknowledge, which the contract scopes to admin/manager.
 * That is a distinct capability rather than a row filter, and the service
 * asserts it too.
 */
import {
  CommentAcknowledgeSchema,
  CommentCreateSchema,
  CommentListQuerySchema,
} from '@skaly/shared';
import { z } from 'zod';

import { transactionWithEmits } from '../../lib/emit-after-commit.js';
import { CommentService } from '../../services/CommentService.js';

import type { CurrentUser } from '../../services/AttendanceService.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

const CommentSchema = z.object({
  id: z.string(),
  module: z.string(),
  recordId: z.string(),
  period: z.string(),
  content: z.string(),
  recordContext: z.string(),
  author: z.object({ staffId: z.string(), name: z.string(), role: z.string() }),
  acknowledgedBy: z.object({ staffId: z.string(), name: z.string() }).nullable(),
  acknowledgedAt: z.string().nullable(),
  createdAt: z.string(),
});

function currentUser(request: FastifyRequest): CurrentUser {
  return { staffId: request.user.id, role: request.user.role };
}

export default async function commentRoutes(app: FastifyInstance) {
  const comments = new CommentService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── GET /v1/comments?module=&recordId=&period= ──────────────────────────────
  r.get(
    '/comments',
    {
      preHandler: [app.verifyJwt],
      schema: {
        querystring: CommentListQuerySchema,
        response: { 200: z.object({ data: z.array(CommentSchema) }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => ({
      data: await comments.list(request.query, currentUser(request), app.db),
    }),
  );

  // ── POST /v1/comments ───────────────────────────────────────────────────────
  r.post(
    '/comments',
    {
      preHandler: [app.verifyJwt],
      schema: {
        body: CommentCreateSchema,
        response: { 201: z.object({ data: CommentSchema }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      // transactionWithEmits, not db.transaction: create() fans out `notify:new`
      // through the caller's trx, and an emit that beats the commit leaves every
      // subscriber's cache patched with a comment that may still roll back.
      const data = await transactionWithEmits(app.db, (trx) =>
        comments.create(request.body, currentUser(request), trx),
      );
      return reply.code(201).send({ data });
    },
  );

  // ── PATCH /v1/comments/:id/acknowledge (admin, manager) ─────────────────────
  r.patch(
    '/comments/:id/acknowledge',
    {
      preHandler: [app.verifyJwt],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: CommentAcknowledgeSchema,
        response: {
          200: z.object({
            data: z.object({
              acknowledgedBy: z.string().nullable(),
              acknowledgedAt: z.string().nullable(),
            }),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => ({
      data: await app.db.transaction().execute((trx) =>
        comments.acknowledge(
          request.params.id,
          request.body.acknowledged,
          currentUser(request),
          trx,
        ),
      ),
    }),
  );
}
