/**
 * Comment request shapes (07-API-CONTRACT §Comments).
 *
 * `COMMENT_MODULES` mirrors the `comments_module_check` CHECK constraint
 * (migration 022). Comments exist in three modules only — there is no `tasks`
 * comment surface, and adding one here without the migration produces a 500 at
 * the constraint rather than a 400 at the boundary.
 */
import { z } from 'zod';

export const COMMENT_MODULES = ['shoot_planner', 'content_dropper', 'content_calendar'] as const;
export const CommentModuleSchema = z.enum(COMMENT_MODULES);

const PeriodSchema = z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM');

/** GET /v1/comments?module=&recordId=&period= */
export const CommentListQuerySchema = z
  .object({
    module: CommentModuleSchema,
    recordId: z.string().uuid(),
    period: PeriodSchema,
  })
  .strict();

/**
 * POST /v1/comments
 *
 * `record_context` is absent deliberately: the service builds it (the contract
 * says server-side), and `.strict()` turns a client that tries to supply it into
 * a 400 rather than a spoofed audit label.
 */
export const CommentCreateSchema = z
  .object({
    module: CommentModuleSchema,
    recordId: z.string().uuid(),
    period: PeriodSchema,
    content: z.string().trim().min(1).max(2000),
  })
  .strict();

/** PATCH /v1/comments/:id/acknowledge */
export const CommentAcknowledgeSchema = z.object({ acknowledged: z.boolean() }).strict();

export type CommentModule = z.infer<typeof CommentModuleSchema>;
export type CommentListQuery = z.infer<typeof CommentListQuerySchema>;
export type CommentCreateBody = z.infer<typeof CommentCreateSchema>;
export type CommentAcknowledgeBody = z.infer<typeof CommentAcknowledgeSchema>;
