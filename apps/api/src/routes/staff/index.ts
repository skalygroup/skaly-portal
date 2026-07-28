import { StaffMeResponseSchema } from '@skaly/shared/schemas/auth';
import { z } from 'zod';

import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getR2Client, getR2Bucket } from '../../lib/r2.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { AuthService, AuthError } from '../../services/AuthService.js';
import { PermissionService, isPermissionKey } from '../../services/PermissionService.js';
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
  const permissionService = new PermissionService(app.redis);
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
      // One resolver, so this reflects admin overrides exactly as the bot's tool
      // filter does (Sprint 8.1). The response SHAPE is unchanged — only the
      // values are now correct.
      //
      // The sidebar reads this via TanStack Query, so a permission an admin just
      // changed lands on the affected user's next refetch/reload; the override
      // endpoint already busts the Redis cache server-side.
      // Sprint 10 may push a permission-changed event; until then the sidebar
      // refreshes on refetch.
      const permissions = await permissionService.getEffectivePermissions(
        request.user.id,
        profile.role,
        app.db,
      );
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

  // ── Admin: deactivate a staff member ────────────────────────────────
  // Soft-delete + active = false + Supabase session revocation, so they are
  // signed out rather than merely blocked on their next request.
  r.put(
    '/staff/:id/deactivate',
    {
      preHandler: [app.verifyJwt, app.requireRole('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ data: z.object({ deactivated: z.literal(true) }) }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      try {
        return { data: await authService.deactivateStaff(request.params.id, request.user.id) };
      } catch (err) {
        return sendAuthError(err, reply);
      }
    },
  );

  // ── Admin: reinstate a soft-deleted staff member (ADR-026, fixes A4) ─
  // Already specified in Auth-Matrix §4 since Sprint 1; built in Sprint 11.
  r.put(
    '/staff/:id/reactivate',
    {
      preHandler: [app.verifyJwt, app.requireRole('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({
            data: z.object({ staffId: z.string(), reactivated: z.literal(true) }),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      try {
        return { data: await authService.reactivateStaff(request.params.id, request.user.id) };
      } catch (err) {
        return sendAuthError(err, reply);
      }
    },
  );

  // ── Admin: set a per-user permission override (AUTH-MATRIX §4/§6) ────
  // Upserts user_permissions, audits, and busts perms:{staffId} so the change
  // takes effect on the next resolve. The resolver's floor is ROLE_DEFAULTS.
  r.put(
    '/staff/:id/permissions/:key',
    {
      preHandler: [app.verifyJwt, app.requireRole('admin')],
      schema: {
        params: z.object({
          id: z.string().uuid(),
          key: z.string().refine(isPermissionKey, 'Unknown permission key'),
        }),
        body: z.object({ value: z.boolean() }),
        response: {
          200: z.object({
            data: z.object({
              staffId: z.string(),
              permissionKey: z.string(),
              value: z.boolean(),
            }),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { id, key } = request.params;
      const { value } = request.body;
      const updated = await permissionService.setOverride(id, key, value, request.user.id, app.db);
      return { data: updated };
    },
  );
}
