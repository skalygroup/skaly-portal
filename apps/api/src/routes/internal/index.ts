/**
 * /v1/internal/* — the Railway cron service's entry points (Infra §4).
 *
 * NOT user routes. Every one is gated by `verifyInternalSecret` (timing-safe
 * X-Internal-Secret, audit B-03) and by nothing else — there is no `verifyJwt`
 * here, because the caller is a curl in a scheduler, not a person.
 *
 * Schedules (all IST, all clear of each other and of the 00:01 rollover window
 * that Sprint 13 adds):
 *
 *   03:00 monthly   POST /v1/internal/message-retention   ADR-030 amendment
 *   04:00 daily     POST /v1/internal/attachment-sweep    ADR-033 §10
 *   inside rollover POST /v1/internal/recompute-shoot-dates  ADR-034
 *
 * The recompute endpoint exists so the schedule is testable and callable before
 * Sprint 13's rollover transaction exists to host it. When rollover lands, it
 * calls `recomputeAllComingShootDates` directly — the same function, in-process,
 * inside its transaction — and this endpoint stays as the manual re-run handle.
 *
 * Every handler returns its job's summary rather than a bare 204: an unattended
 * job that reports nothing is one nobody can tell has silently stopped working.
 */
import { z } from 'zod';

import { attachmentOrphanSweep } from '../../jobs/attachment-orphan-sweep.js';
import { recomputeAllComingShootDates } from '../../jobs/coming-shoot-date-recompute.js';
import { messageRetentionSweep } from '../../jobs/message-retention.js';
import { currentIstPeriod } from '../../services/BaseService.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

export default async function internalRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── 04:00 IST daily — ADR-033 ───────────────────────────────────────────────
  r.post(
    '/internal/attachment-sweep',
    {
      // onRequest, NOT preHandler: Fastify validates the request between the two,
      // so a preHandler secret check hands an unauthenticated caller a 400 for a
      // malformed body — confirming the route exists before proving they may ask.
      onRequest: [app.verifyInternalSecret],
      schema: {
        response: {
          200: z.object({
            data: z.object({
              scanned: z.number(),
              orphaned: z.number(),
              deleted: z.number(),
              skippedTooRecent: z.number(),
            }),
          }),
        },
      },
    },
    async () => ({ data: await attachmentOrphanSweep(app.db, { logger: app.log }) }),
  );

  // ── 03:00 IST monthly — ADR-030 amendment ───────────────────────────────────
  r.post(
    '/internal/message-retention',
    {
      // onRequest, NOT preHandler: Fastify validates the request between the two,
      // so a preHandler secret check hands an unauthenticated caller a 400 for a
      // malformed body — confirming the route exists before proving they may ask.
      onRequest: [app.verifyInternalSecret],
      schema: {
        response: {
          200: z.object({
            data: z.object({
              messagesDeleted: z.number(),
              sessionsDeleted: z.number(),
              batches: z.number(),
              hitBatchCap: z.boolean(),
            }),
          }),
        },
      },
    },
    async () => ({ data: await messageRetentionSweep(app.db, { logger: app.log }) }),
  );

  // ── Inside rollover (Sprint 13); manual re-run handle until then — ADR-034 ──
  r.post(
    '/internal/recompute-shoot-dates',
    {
      // onRequest, NOT preHandler: Fastify validates the request between the two,
      // so a preHandler secret check hands an unauthenticated caller a 400 for a
      // malformed body — confirming the route exists before proving they may ask.
      onRequest: [app.verifyInternalSecret],
      schema: {
        // A query param, not a body: the cron calls this with a bare
        // `curl -X POST`, and a required body schema 400s on an absent one.
        querystring: z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).strict(),
        response: {
          200: z.object({
            data: z.object({
              period: z.string(),
              clients: z.number(),
              recomputed: z.number(),
              failed: z.number(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const period = request.query.period ?? currentIstPeriod();
      return { data: { period, ...(await recomputeAllComingShootDates(app.db, period, app.log)) } };
    },
  );
}
