/**
 * Search + activity-feed request shapes (07-API-CONTRACT §Search & Activity Feed).
 *
 * Shared because the CMD+K palette builds the same query string the API validates —
 * one definition of what `scope` may be, so the pills and the endpoint cannot drift.
 */
import { z } from 'zod';

export const SEARCH_SCOPES = ['current', 'all_time'] as const;
export const SearchScopeSchema = z.enum(SEARCH_SCOPES);

/**
 * GET /v1/search
 *
 * `scope` defaults to `current` (API-Contract: "current (default, uses active
 * period)"). The service treats it as a NO-OP for clients and staff — neither has a
 * period column (ADR-015 §4).
 *
 * `q` allows a single character at the boundary even though the service returns
 * empty below two: a 400 on the first keystroke would be a worse experience than an
 * empty result set, and the debounced palette fires as the user types.
 */
export const SearchQuerySchema = z.object({
  q: z.string().min(1).max(100),
  scope: SearchScopeSchema.default('current'),
});

/** GET /v1/activity-feed — role-filtered inside the service, not at the route. */
export const ActivityFeedQuerySchema = z.object({
  period: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM')
    .optional(),
  // Query-string values arrive as strings; coerce, then cap. 50 is the service's
  // ceiling too — validated here so an over-limit request is a 400 rather than a
  // silently clamped 200.
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type SearchScope = z.infer<typeof SearchScopeSchema>;
export type SearchQuery = z.infer<typeof SearchQuerySchema>;
export type ActivityFeedQuery = z.infer<typeof ActivityFeedQuerySchema>;
