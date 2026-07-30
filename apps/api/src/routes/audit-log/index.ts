import { Readable, Transform, pipeline } from 'node:stream';

import { stringify } from 'csv-stringify';
import { z } from 'zod';

import { logger } from '../../lib/logger.js';
import { AuditQueryService } from '../../services/AuditQueryService.js';

import type { AuditFilters } from '../../services/AuditQueryService.js';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/** NFR §5.3's filter set, shared by both routes so they cannot drift. */
const FilterQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  staffId: z.string().uuid().optional(),
  tableName: z.string().max(50).optional(),
  action: z.enum(['INSERT', 'UPDATE', 'DELETE', 'LOCK', 'UNLOCK', 'DEACTIVATE']).optional(),
  recordId: z.string().uuid().optional(),
  changedBySource: z.enum(['user', 'system', 'bot']).optional(),
});

const AuditEntrySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  actorId: z.string(),
  actorName: z.string(),
  actorRole: z.string().nullable(),
  source: z.string(),
  tableName: z.string(),
  action: z.string(),
  recordId: z.string().nullable(),
  oldValue: z.unknown(),
  newValue: z.unknown(),
  ipAddress: z.string().nullable(),
});

/**
 * /v1/audit-log — admin only (Auth-Matrix §4), mounted with /v1 in app.ts.
 *
 *   GET /audit-log         — keyset-paginated JSON for the panel
 *   GET /audit-log/export  — the SAME filter predicate, streamed as CSV
 *
 * There is no POST, PATCH or DELETE, and there will not be: migration 026 revokes
 * UPDATE and DELETE on `audit_log` from the app role. A mutation endpoint here
 * could only ever return an error.
 *
 * This stays admin-only. `/v1/activity-feed` (Sprint 9) is the role-filtered
 * surface for everyone else — a canonical separation (PRD FR-SET-07), not an
 * accident of two sprints.
 */
export default async function auditLogRoutes(app: FastifyInstance) {
  const service = new AuditQueryService();
  const r = app.withTypeProvider<ZodTypeProvider>();
  const adminOnly = { preHandler: [app.verifyJwt, app.requireRole('admin')] };

  r.get(
    '/audit-log',
    {
      ...adminOnly,
      schema: {
        querystring: FilterQuery.extend({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        }),
        response: {
          200: z.object({
            data: z.array(AuditEntrySchema),
            nextCursor: z.string().nullable(),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { cursor, limit, ...filters } = request.query;
      const page = await service.list(
        filters as AuditFilters,
        cursor,
        limit,
        request.user.role,
        app.db,
      );
      return { data: page.entries, nextCursor: page.nextCursor };
    },
  );

  /**
   * ⭐ ADR-028. The whole response is a function of how much data matched, so it
   * streams: a Postgres cursor → csv-stringify → the socket, with nothing holding
   * the full set. No `Content-Length` (it is unknowable without buffering), so
   * the response is chunked.
   *
   * Fastify serialises a stream body as-is once the content type is set, so the
   * route must NOT declare a `response` schema — a schema would make it try to
   * serialise the stream object itself.
   */
  r.get(
    '/audit-log/export',
    {
      ...adminOnly,
      schema: { querystring: FilterQuery, security: [{ bearerAuth: [] }] },
    },
    async (request, reply) => {
      const filters = request.query as AuditFilters;
      const rows = service.streamRows(filters, request.user.role, app.db);

      const stamp = [filters.from, filters.to].filter(Boolean).join('-to-') || 'all';
      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="audit-log-${stamp}.csv"`)
        // A proxy that buffers to add Content-Length would undo the whole ADR.
        .header('Cache-Control', 'no-store')
        .header('X-Accel-Buffering', 'no');

      const toRecord = new Transform({
        objectMode: true,
        transform(row, _enc, done) {
          done(null, AuditQueryService.toCsvRecord(row));
        },
      });

      const csv = stringify({
        header: true,
        columns: AuditQueryService.CSV_COLUMNS.map((c) => ({ key: c.key, header: c.header })),
      });

      // `pipeline` rather than `.pipe`: it is what tears the Postgres cursor down
      // if the client disconnects halfway through a 50k-row download. A leaked
      // cursor holds a connection from a pool that is also serving PDF renders.
      const out = pipeline(Readable.from(rows), toRecord, csv, (err) => {
        if (err) logger.warn({ err }, 'audit-log export stream failed');
      });

      return reply.send(out);
    },
  );
}
