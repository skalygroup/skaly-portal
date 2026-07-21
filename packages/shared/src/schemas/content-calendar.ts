/**
 * Single source of truth for the Content Calendar status vocabulary and request
 * shapes.
 *
 * Both apps/api (request validation + service validation) and apps/web (the cell
 * popover dropdown) import from `@skaly/shared`. Keep in sync with
 * docs/07-API-CONTRACT.md §Content Calendar and docs/08-AUTH-MATRIX.md §3–§4 —
 * nowhere else.
 *
 * content_calendar IS versioned (C-02): the cell PATCH requires `version`.
 * There is NO `source` field on the wire — the service sets it (the auto-reset,
 * 04-APPFLOW §8). Sending one is a 400.
 */
import { z } from 'zod';

/**
 * The status vocabulary, exactly the six values in the `content_calendar_status`
 * CHECK (migration 016). 'No Activity' is the column default. Adding a value
 * here without a migration will fail at the DB boundary.
 */
export const CALENDAR_STATUSES = [
  'No Activity',
  'Under Progress',
  'Ready',
  'Posted',
  'Pending',
  'Rescheduled',
] as const;

export const CalendarStatusSchema = z.enum(CALENDAR_STATUSES);
export type CalendarStatus = (typeof CALENDAR_STATUSES)[number];

/** `note` ceiling. The column is TEXT (unbounded); bound it at both layers. */
export const CALENDAR_NOTE_MAX = 1000;

/** GET /v1/content-calendar — `period` required. */
export const CalendarQuerySchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM'),
});

/**
 * PATCH /v1/content-calendar/:id — `version` required (C-02, optimistic lock).
 *
 * `.strict()` is load-bearing, not tidiness: it is what rejects a `source` field
 * outright. Per API-Contract the frontend never sends `source`, so a client must
 * not be able to forge a provenance value and fake (or erase) the gold
 * trigger dot. The service re-checks — this is layer 2 of 2.
 *
 * Exported as a base + the refined schema: `.refine()` returns a ZodEffects,
 * which has no `.extend()` / `.partial()` / `.pick()` / `.strict()`. Derive from
 * CellUpdateBase, not from CellUpdateSchema.
 */
export const CellUpdateBase = z
  .object({
    status: CalendarStatusSchema.optional(),
    note: z.string().max(CALENDAR_NOTE_MAX).nullable().optional(),
    version: z.number().int().min(1),
  })
  .strict();

export const CellUpdateSchema = CellUpdateBase.refine(
  (b) => b.status !== undefined || b.note !== undefined,
  { message: 'Provide at least one of status or note.' },
);

export type CalendarQuery = z.infer<typeof CalendarQuerySchema>;
export type CellUpdateBody = z.infer<typeof CellUpdateSchema>;
