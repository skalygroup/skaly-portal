/**
 * /v1/tasks — Work Allocation HTTP surface (07-API-CONTRACT §7, 08-AUTH-MATRIX §4).
 * Mounted with the /v1 prefix in app.ts.
 *
 * Two-layer authorization: `requireRole` is layer 2 (coarse role gate at the
 * route); the service is layer 3 (team_member ownership/assignment backstop,
 * ADR-006/007/009). Both exist — the route never trusts the client, the service
 * never trusts the route. Every write opens a transaction here so the write +
 * its notifications + audit commit atomically (same pattern as attendance).
 *
 * Envelopes per API-Contract §1.1: success `{ data }`, errors are rendered by
 * the global handler in app.ts.
 */
import {
  TaskQuerySchema,
  TaskCreateSchema,
  TaskUpdateSchema,
  AssignSchema,
  AttachmentPresignSchema,
  AttachmentConfirmSchema,
} from '@skaly/shared';
import { z } from 'zod';

import { transactionWithEmits } from '../../lib/emit-after-commit.js';
import { TaskAttachmentService } from '../../services/TaskAttachmentService.js';
import { TaskService } from '../../services/TaskService.js';

import type { CurrentUser } from '../../services/AttendanceService.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

// ─── Response schemas (for Swagger; the DTOs are typed in the services) ───────

const AssigneeSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
});

const AttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  fileSize: z.number(),
  mimeType: z.string().nullable(),
  uploadedBy: z.string(),
  uploadedAt: z.string().nullable(),
});

const TaskSchema = z.object({
  id: z.string(),
  period: z.string(),
  date: z.string(),
  description: z.string(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  status: z.string(),
  priority: z.string().nullable(),
  dependencyId: z.string().nullable(),
  dependencyDescription: z.string().nullable(),
  dependencyBlocked: z.boolean(),
  deadline: z.string().nullable(),
  remark: z.string().nullable(),
  result: z.string().nullable(),
  assignees: z.array(AssigneeSchema),
  attachmentCount: z.number(),
  createdBy: z.string(),
  createdAt: z.string().nullable(),
});

const TaskDetailSchema = TaskSchema.extend({ attachments: z.array(AttachmentSchema) });

const IdParam = z.object({ id: z.string().uuid() });
const bearer = { security: [{ bearerAuth: [] }] };

function currentUser(request: FastifyRequest): CurrentUser {
  return { staffId: request.user.id, role: request.user.role };
}

export default async function tasksRoutes(app: FastifyInstance) {
  const tasks = new TaskService();
  const attachments = new TaskAttachmentService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Read roles: admin/manager/team_member all read ALL tasks; freelancer → 403.
  const readRoles = { preHandler: [app.verifyJwt, app.requireRole('admin', 'manager', 'team_member')] };
  // Write roles: admin/manager only (create/delete/assign/unassign).
  const writeRoles = { preHandler: [app.verifyJwt, app.requireRole('admin', 'manager')] };

  // ── Tasks ──────────────────────────────────────────────────────────────────

  r.get(
    '/tasks',
    { ...readRoles, schema: { querystring: TaskQuerySchema, response: { 200: z.object({ data: z.array(TaskSchema) }) }, ...bearer } },
    async (request) => ({ data: await tasks.getTasks(request.query, currentUser(request), app.db) }),
  );

  r.post(
    '/tasks',
    { ...writeRoles, schema: { body: TaskCreateSchema, response: { 201: z.object({ data: TaskDetailSchema }) }, ...bearer } },
    async (request, reply) => {
      const data = await transactionWithEmits(app.db, (trx) => tasks.create(request.body, currentUser(request), trx));
      return reply.status(201).send({ data });
    },
  );

  r.get(
    '/tasks/:id',
    { ...readRoles, schema: { params: IdParam, response: { 200: z.object({ data: TaskDetailSchema }) }, ...bearer } },
    async (request) => ({ data: await tasks.getTask(request.params.id, currentUser(request), app.db) }),
  );

  r.patch(
    '/tasks/:id',
    { ...readRoles, schema: { params: IdParam, body: TaskUpdateSchema, response: { 200: z.object({ data: TaskDetailSchema }) }, ...bearer } },
    async (request) => {
      // team_member ownership is enforced inside the service (layer 3).
      const data = await transactionWithEmits(app.db, (trx) => tasks.update(request.params.id, request.body, currentUser(request), trx));
      return { data };
    },
  );

  r.delete(
    '/tasks/:id',
    { ...writeRoles, schema: { params: IdParam, response: { 200: z.object({ data: z.object({ deleted: z.literal(true) }) }) }, ...bearer } },
    async (request) => {
      const data = await transactionWithEmits(app.db, (trx) => tasks.remove(request.params.id, currentUser(request), trx));
      return { data };
    },
  );

  // ── Assignees ────────────────────────────────────────────────────────────────

  r.post(
    '/tasks/:id/assignees',
    { ...writeRoles, schema: { params: IdParam, body: AssignSchema, response: { 200: z.object({ data: TaskDetailSchema }) }, ...bearer } },
    async (request) => {
      const data = await transactionWithEmits(app.db, (trx) => tasks.assign(request.params.id, request.body.staffIds, currentUser(request), trx));
      return { data };
    },
  );

  r.delete(
    '/tasks/:id/assignees/:staffId',
    {
      ...writeRoles,
      schema: { params: z.object({ id: z.string().uuid(), staffId: z.string().uuid() }), response: { 200: z.object({ data: TaskDetailSchema }) }, ...bearer },
    },
    async (request) => {
      const data = await transactionWithEmits(app.db, (trx) => tasks.unassign(request.params.id, request.params.staffId, currentUser(request), trx));
      return { data };
    },
  );

  // ── Attachments (ADR-007; service gates team_member by assignment) ───────────

  r.post(
    '/tasks/:id/attachments/presign',
    {
      ...readRoles,
      // M-06: 20 presigns/hr per staff. The rate-limit hook runs onRequest, before
      // verifyJwt populates request.user, so we key on the bearer token (a per-staff
      // session identity). ponytail: token-keyed bucket; switch to decoded staffId
      // only if token rotation churn on the limiter ever matters.
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 hour',
          keyGenerator: (req: FastifyRequest) => req.headers.authorization ?? req.ip,
        },
      },
      schema: {
        params: IdParam,
        body: AttachmentPresignSchema,
        response: { 200: z.object({ data: z.object({ presignedUrl: z.string(), fileKey: z.string() }) }) },
        ...bearer,
      },
    },
    async (request) => ({ data: await attachments.presignAttachment(request.params.id, request.body, currentUser(request), app.db) }),
  );

  r.post(
    '/tasks/:id/attachments/confirm',
    { ...readRoles, schema: { params: IdParam, body: AttachmentConfirmSchema, response: { 201: z.object({ data: AttachmentSchema }) }, ...bearer } },
    async (request, reply) => {
      const data = await transactionWithEmits(app.db, (trx) => attachments.confirmAttachment(request.params.id, request.body, currentUser(request), trx));
      return reply.status(201).send({ data });
    },
  );

  r.get(
    '/tasks/:id/attachments/:aid/download',
    {
      ...readRoles,
      schema: { params: z.object({ id: z.string().uuid(), aid: z.string().uuid() }), response: { 200: z.object({ data: z.object({ downloadUrl: z.string() }) }) }, ...bearer },
    },
    async (request) => ({
      data: await attachments.getAttachmentDownloadUrl(request.params.id, request.params.aid, currentUser(request), app.db),
    }),
  );

  r.delete(
    '/tasks/:id/attachments/:aid',
    {
      ...readRoles,
      schema: { params: z.object({ id: z.string().uuid(), aid: z.string().uuid() }), response: { 200: z.object({ data: z.object({ deleted: z.literal(true) }) }) }, ...bearer },
    },
    async (request) => {
      const data = await transactionWithEmits(app.db, (trx) => attachments.deleteAttachment(request.params.id, request.params.aid, currentUser(request), trx));
      return { data };
    },
  );
}
