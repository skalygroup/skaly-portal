import { z } from 'zod';

import {
  AttendanceService,
  attendanceLogToDTO,
  WORK_LOG_MAX,
  type CurrentUser,
} from '../../services/AttendanceService.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

const PeriodSchema = z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM');

const AttendanceLogSchema = z.object({
  id: z.string(),
  period: z.string(),
  staffId: z.string(),
  date: z.string(),
  dayType: z.string(),
  present: z.boolean(),
  workLog: z.string().nullable(),
  version: z.number(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

const GridSchema = z.object({
  attendanceLogs: z.array(AttendanceLogSchema),
  holidays: z.array(z.object({ id: z.string(), date: z.string(), name: z.string() })),
  staffList: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: z.string(),
      avatarUrl: z.string().nullable(),
    }),
  ),
  editableStaffIds: z.array(z.string()),
});

/** A pg DATE comes back as a local-midnight Date; recover the calendar date
 * with local getters (never toISOString, which would shift the day in -UTC TZs). */
function toDateString(d: unknown): string {
  if (typeof d === 'string') return d.slice(0, 10);
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return String(d);
}

/**
 * /v1/attendance — mounted with the /v1 prefix in app.ts.
 *
 *   GET  /attendance?period=YYYY-MM   — admin, manager, team_member (freelancer 403)
 *   PATCH /attendance/:id             — same roles; team_member own row only (503 backstop)
 *
 * Field filtering + column ownership are enforced in the service; the frontend
 * pointer-events (STEP 7) is UX only.
 */
export default async function attendanceRoutes(app: FastifyInstance) {
  const service = new AttendanceService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  const gridRoles = { preHandler: [app.verifyJwt, app.requireRole('admin', 'manager', 'team_member')] };

  r.get(
    '/attendance',
    {
      ...gridRoles,
      schema: {
        querystring: z.object({ period: PeriodSchema }),
        response: { 200: z.object({ data: GridSchema }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const currentUser: CurrentUser = { staffId: request.user.id, role: request.user.role };
      const data = await service.getGrid(request.query.period, currentUser, app.db);
      return { data };
    },
  );

  r.patch(
    '/attendance/:id',
    {
      ...gridRoles,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          present: z.boolean().optional(),
          workLog: z.string().max(WORK_LOG_MAX).optional(),
          version: z.number().int(),
        }),
        response: { 200: z.object({ data: AttendanceLogSchema }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const currentUser: CurrentUser = { staffId: request.user.id, role: request.user.role };
      const { present, workLog, version } = request.body;

      // The write + audit must commit together (STEP 4 atomicity).
      const updated = await app.db
        .transaction()
        .execute((trx) => service.update(request.params.id, { present, work_log: workLog }, currentUser, version, trx));

      const dto = attendanceLogToDTO({ ...updated, date: toDateString(updated.date) });
      return { data: dto };
    },
  );
}
