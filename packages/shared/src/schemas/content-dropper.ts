/**
 * Single source of truth for the Content Dropper request shapes.
 *
 * Both apps/api (request validation) and apps/web (form validation) import from
 * `@skaly/shared`. Keep in sync with docs/07-API-CONTRACT.md §9 and
 * docs/08-AUTH-MATRIX.md §3–§4 — nowhere else.
 *
 * content_pipelines IS versioned (C-02): the stage PATCH requires `version`.
 * There is NO client timestamp — the server stamps the stage time (H-02).
 */
import { z } from 'zod';

const PeriodSchema = z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM');

/** The three manual stages (04-APPFLOW §7). */
export const STAGE_VALUES = ['raw', 'finals', 'posted'] as const;
export const StageSchema = z.enum(STAGE_VALUES);

/** GET /v1/content-dropper — `period` required. */
export const DropperQuerySchema = z.object({
  period: PeriodSchema,
});

/**
 * PATCH /v1/content-dropper/:id/stage — `version` required (C-02, optimistic
 * lock). No timestamp field: the server sets the stage time (H-02).
 */
export const StageUpdateSchema = z.object({
  stage: StageSchema,
  version: z.number().int().min(1),
});

/** PATCH /v1/clients/:id — client name inline edit (admin/manager). */
export const ClientNameSchema = z.object({
  name: z.string().min(1).max(120),
});

export type DropperQuery = z.infer<typeof DropperQuerySchema>;
export type StageUpdateBody = z.infer<typeof StageUpdateSchema>;
export type ClientNameBody = z.infer<typeof ClientNameSchema>;
