import { StaffMeResponseSchema } from '@skaly/shared/schemas/auth';
import { z } from 'zod';

import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getEffectivePermissions } from '../../lib/permissions.js';
import { getR2Client, getR2Bucket } from '../../lib/r2.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { AuthService, AuthError } from '../../services/AuthService.js';
import { StaffService } from '../../services/StaffService.js';

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

function sendAuthError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof AuthError) {
    return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
  }
  throw err;
}

const StaffListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  avatarUrl: z.string().nullable(),
  isOnline: z.boolean(),
});

const StaffFullProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string(),
  dateOfBirth: z.string().nullable(),
  mobileNumber: z.string().nullable(),
  cvFileKey: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  active: z.boolean(),
  mfaEnrolled: z.boolean(),
  createdAt: z.string(),
});

const StaffPublicProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  avatarUrl: z.string().nullable(),
});

/**
 * Barrel + handlers for the /v1/staff/* area (mounted with /v1 in app.ts).
 *
 *   GET /staff               — limited fields, all roles (dropdowns/@mentions)
 *   GET /staff/me            — own full profile + permissions (C-04)
 *   GET /staff/:id           — full profile; admin/manager/own only
 *   GET /staff/:id/profile   — public-safe profile, all roles
 *   PUT /staff/:id/mfa/reset — admin clears a user's MFA so they re-enroll
 */
export default async function staffRoutes(app: FastifyInstance) {
  const authService = new AuthService(
    app.db,
    app.redis,
    supabaseAdmin,
    logger,
    getR2Client(),
    getR2Bucket(),
  );
  const staffService = new StaffService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── List: limited fields for all roles (field filtering server-side) ─
  r.get(
    '/staff',
    {
      preHandler: [app.verifyJwt],
      schema: {
        response: { 200: z.object({ data: z.array(StaffListItemSchema) }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({ data: await staffService.listLimited(app.db) }),
  );

  // ── Current user: full own profile + permissions (C-04) ─────────────
  r.get(
    '/staff/me',
    {
      preHandler: [app.verifyJwt],
      schema: { response: { 200: StaffMeResponseSchema }, security: [{ bearerAuth: [] }] },
    },
    async (request) => {
      const profile = await staffService.getFullProfile(request.user.id, app.db);
      // verifyJwt already resolved this row, but stay honest about the type.
      if (!profile) throw new AppError('RESOURCE_NOT_FOUND', 'Staff not found.');
      const permissions = await getEffectivePermissions(app.db, request.user.id);
      return { ...profile, permissions };
    },
  );

  // ── Public-safe profile: all roles ──────────────────────────────────
  r.get(
    '/staff/:id/profile',
    {
      preHandler: [app.verifyJwt],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ data: StaffPublicProfileSchema }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const profile = await staffService.getPublicProfile(request.params.id, app.db);
      if (!profile) throw new AppError('RESOURCE_NOT_FOUND', 'Staff not found.');
      return { data: profile };
    },
  );

  // ── Full profile: admin, manager, or own row only ───────────────────
  r.get(
    '/staff/:id',
    {
      preHandler: [app.verifyJwt],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ data: StaffFullProfileSchema }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { id } = request.params;
      const { role, id: callerId } = request.user;
      const canView = role === 'admin' || role === 'manager' || callerId === id;
      if (!canView) throw new AppError('PERMISSION_DENIED', 'Permission denied.');
      const profile = await staffService.getFullProfile(id, app.db);
      if (!profile) throw new AppError('RESOURCE_NOT_FOUND', 'Staff not found.');
      return { data: profile };
    },
  );

  // ── Admin: reset a user's MFA ───────────────────────────────────────
  r.put(
    '/staff/:id/mfa/reset',
    {
      preHandler: [app.verifyJwt, app.requireRole('admin')],
      schema: { params: z.object({ id: z.string().uuid() }), security: [{ bearerAuth: [] }] },
    },
    async (request, reply) => {
      try {
        await authService.resetMfa(request.params.id, request.user.id);
        return reply.status(204).send();
      } catch (err) {
        return sendAuthError(err, reply);
      }
    },
  );
}
