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
 *   00:01 daily     POST /v1/internal/rollover            ADR-035/036/037
 *   03:00 monthly   POST /v1/internal/message-retention   ADR-030 amendment
 *   04:00 daily     POST /v1/internal/attachment-sweep    ADR-033 §10
 *   inside rollover POST /v1/internal/recompute-shoot-dates  ADR-034
 *
 * The recompute endpoint exists so the schedule is testable and callable before
 * Sprint 13's rollover transaction exists to host it. Now that rollover has
 * landed, Tier 1 calls `recomputeComingShootDateIn` in-process inside its own
 * transaction, and this endpoint stays as the manual re-run handle.
 *
 * ⚠️ `/internal/rollover` IS THE ONE EXCEPTION to "no JWT path at all" — and
 * deliberately so (ADR-037 §4). The `[Manual rollover]` button in an admin's
 * failure notification posts to THIS endpoint, not to a parallel "force" route
 * that would skip the idempotency guard. Two entry points, one idempotent core.
 *
 * Every handler returns its job's summary rather than a bare 204: an unattended
 * job that reports nothing is one nobody can tell has silently stopped working.
 */
import { z } from 'zod';

import { attachmentOrphanSweep } from '../../jobs/attachment-orphan-sweep.js';
import { recomputeAllComingShootDates } from '../../jobs/coming-shoot-date-recompute.js';
import { messageRetentionSweep } from '../../jobs/message-retention.js';
import { AppError } from '../../lib/errors.js';
import { currentIstPeriod } from '../../services/BaseService.js';
import { RolloverFailure, RolloverService } from '../../services/RolloverService.js';

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

export default async function internalRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const rollover = new RolloverService();

  /**
   * Accept EITHER the cron's internal secret OR an admin session (ADR-037 §4).
   *
   * The secret path is tried first and is total: if the header is present it
   * decides the request, so an attacker cannot downgrade to the JWT path by
   * sending a wrong secret. Only a request with NO secret header at all is
   * treated as a user action and sent through the ordinary admin gate.
   *
   * preHandler, not onRequest, unlike its siblings above — `verifyJwt` is a
   * preHandler and the two must run in one place to be one decision. The cost is
   * the leak those siblings avoid (a malformed body 400s before the 401), which
   * for this route is nothing: its only input is an optional `period` query param.
   */
  // verifyJwt/requireRole are typed as preHandlerHookHandler, i.e. (req, reply, done).
  // Both are async and ignore `done` (Fastify uses the returned promise instead), so
  // calling them directly needs a no-op to satisfy the signature.
  const noopDone: HookHandlerDoneFunction = () => {};

  const verifySecretOrAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers['x-internal-secret'] !== undefined) {
      return app.verifyInternalSecret(request, reply);
    }
    await app.verifyJwt(request, reply, noopDone);
    if (reply.sent) return;
    // .call(app, …): requireRole returns a preHandlerHookHandler, which declares
    // `this: FastifyInstance`. A bare call would bind `this` to undefined.
    return app.requireRole('admin').call(app, request, reply, noopDone);
  };

  // ── 00:01 IST daily (cron) + the [Manual rollover] button — ADR-035/036/037 ─
  r.post(
    '/internal/rollover',
    {
      preHandler: [verifySecretOrAdmin],
      schema: {
        // A query param, not a body: the cron calls this with a bare `curl -X POST`,
        // and a required body schema 400s on an absent one. Omitted ⇒ the current
        // IST period, which at 00:01 on the 1st is the month needing its rows.
        querystring: z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).strict(),
        response: {
          200: z.object({
            data: z.object({
              period: z.string(),
              status: z.enum(['completed', 'resumed', 'already_completed']),
              clients: z.number(),
              viewsRefreshed: z.boolean(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const period = request.query.period ?? currentIstPeriod();
      try {
        return { data: await rollover.run(app.db, period, app.log) };
      } catch (err) {
        // Tier 1 failed. The service has already rolled back and already notified
        // the admins (ADR-036); all that is left here is the non-2xx the cron's
        // 3× retry keys off. A Tier 2 failure never reaches this branch — it
        // resolves with viewsRefreshed: false, because a stale dashboard is not a
        // reason to re-run a month that committed correctly.
        const step = err instanceof RolloverFailure ? err.step : 'period_rows';
        throw new AppError('INTERNAL_ERROR', `Rollover for ${period} failed at step ${step}.`);
      }
    },
  );

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
