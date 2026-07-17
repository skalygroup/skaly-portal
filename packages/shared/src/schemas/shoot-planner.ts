/**
 * Single source of truth for the Shoot Planner request shapes.
 *
 * Both apps/api (request validation) and apps/web (form validation) import
 * from `@skaly/shared`. Keep the wire contract in sync with
 * docs/07-API-CONTRACT.md §8 and docs/08-AUTH-MATRIX.md §4 — nowhere else.
 *
 * shoot_schedules is NOT versioned (schema) — no `version` field anywhere here;
 * slot edits are last-write-wins.
 */
import { z } from 'zod';

/** 05-BACKEND-SCHEMA shoot_schedules slot_status CHECK — fixed by contract. */
export const SLOT_STATUS_VALUES = ['Unset', 'Scheduled', 'Confirmed', 'Completed'] as const;
export const SlotStatusSchema = z.enum(SLOT_STATUS_VALUES);

const PeriodSchema = z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM');
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

/** GET /v1/shoot-planner — `period` required. */
export const ShootQuerySchema = z.object({
  period: PeriodSchema,
});

/** PATCH /v1/shoot-planner/:id — every field optional but at least one required. */
export const SlotUpdateSchema = z
  .object({
    slotStatus: SlotStatusSchema.optional(),
    slotDate: DateSchema.optional(),
    piecesExpected: z.number().int().min(1).optional(),
    freelancerId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'At least one field must be provided.',
  });

/**
 * POST /v1/shoot-planner/:id/reset — `confirm: true` is mandatory. The route
 * accepts a loose boolean so the service can return the exact contract code
 * (400 SHOOT_RESET_CONFIRMATION_REQUIRED) instead of a generic Zod failure.
 */
export const SlotResetSchema = z.object({
  confirm: z.boolean().optional(),
});

/** PATCH /v1/clients/:id/shoot-slots — admin-only slot-count adjustment. */
export const SlotCountSchema = z.object({
  slotsPerMonth: z.number().int().min(1).max(20),
});

export type ShootQuery = z.infer<typeof ShootQuerySchema>;
export type SlotUpdateBody = z.infer<typeof SlotUpdateSchema>;
export type SlotResetBody = z.infer<typeof SlotResetSchema>;
export type SlotCountBody = z.infer<typeof SlotCountSchema>;
