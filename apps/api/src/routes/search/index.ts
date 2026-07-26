/**
 * /v1/search + /v1/activity-feed (07-API-CONTRACT §Search & Activity Feed).
 * Mounted with the /v1 prefix in app.ts.
 *
 * BOTH ARE OPEN TO ALL FOUR ROLES AT THE ROUTE. The route does not filter — the
 * service does, per category and per row. Same division as the shoot planner's
 * freelancer isolation (ADR-011): a route-level role gate here would be a second,
 * coarser permission implementation that can only disagree with the first.
 *
 * Search inherits the global 150/min IP limiter (M-06 headers included). No
 * dedicated bucket: it is a read, and the palette's 200ms debounce is the real
 * throttle — a per-keystroke cap would fire on legitimate typing.
 */
import { ActivityFeedQuerySchema, SearchQuerySchema } from '@skaly/shared';
import { z } from 'zod';

import { ActivityFeedService } from '../../services/ActivityFeedService.js';
import { SearchService } from '../../services/SearchService.js';

import type { CurrentUser } from '../../services/AttendanceService.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

// ─── Response schemas (Swagger; the DTOs are typed in the services) ───────────

const SearchTaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  period: z.string(),
  status: z.string(),
  clientName: z.string().nullable(),
});

const SearchCommentSchema = z.object({
  id: z.string(),
  content: z.string(),
  module: z.string(),
  recordContext: z.string(),
  period: z.string(),
});

const SearchClientSchema = z.object({ id: z.string(), name: z.string() });

/** The LIMITED staff shape — never the full row (NFR §4.2). Every role can read
 *  this endpoint, so the projection is a security boundary, not a convenience. */
const SearchStaffSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  avatarUrl: z.string().nullable(),
});

const SearchResultsSchema = z.object({
  tasks: z.array(SearchTaskSchema),
  clients: z.array(SearchClientSchema),
  staff: z.array(SearchStaffSchema),
  comments: z.array(SearchCommentSchema),
});

const FeedItemSchema = z.object({
  id: z.string(),
  actor: z.string(),
  text: z.string(),
  link: z.string().nullable(),
  at: z.string(),
});

function currentUser(request: FastifyRequest): CurrentUser {
  return { staffId: request.user.id, role: request.user.role };
}

export default async function searchRoutes(app: FastifyInstance) {
  const search = new SearchService();
  const feed = new ActivityFeedService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── GET /v1/search?q=&scope= — four categories, role-scoped per category ──
  r.get(
    '/search',
    {
      preHandler: [app.verifyJwt],
      schema: {
        querystring: SearchQuerySchema,
        response: { 200: z.object({ data: SearchResultsSchema }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => ({
      data: await search.search(request.query.q, request.query.scope, currentUser(request), app.db),
    }),
  );

  // ── GET /v1/activity-feed?period=&limit= — humanised, role-filtered ──
  r.get(
    '/activity-feed',
    {
      preHandler: [app.verifyJwt],
      schema: {
        querystring: ActivityFeedQuerySchema,
        response: { 200: z.object({ data: z.array(FeedItemSchema) }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => ({
      data: await feed.getFeed(
        { period: request.query.period, limit: request.query.limit },
        currentUser(request),
        app.db,
      ),
    }),
  );
}
