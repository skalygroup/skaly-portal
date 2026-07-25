/**
 * Client request shapes (07-API-CONTRACT §clients, 08-AUTH-MATRIX §3).
 *
 * `ClientNameSchema` moved here from schemas/content-dropper.ts — it is a client
 * shape, not a dropper one, and `ClientCreateSchema` must reuse its `name` field
 * so create and rename can never disagree about a valid client name.
 *
 * `shootSlotsPerMonth` is REQUIRED: clients.shoot_slots_per_month has no DEFAULT
 * by design (migration 005), so there is no sane value to invent. Range 1..20
 * matches ShootPlannerService.adjustSlotCount, which is the other writer of this
 * column — a client that cannot be created at 25 slots must not be adjustable to
 * 25 either.
 */
import { z } from 'zod';

/** PATCH /v1/clients/:id — client name inline edit (admin/manager). */
export const ClientNameSchema = z.object({
  name: z.string().min(1).max(120),
});

/** POST /v1/clients — admin/manager. */
export const ClientCreateSchema = z
  .object({
    name: ClientNameSchema.shape.name,
    shootSlotsPerMonth: z.number().int().min(1).max(20),
    piecesPerVisit: z.number().int().min(1).default(1),
    isInternal: z.boolean().default(false),
    // clients.whatsapp_number is VARCHAR(20).
    whatsappNumber: z.string().max(20).optional(),
  })
  .strict();

export type ClientNameBody = z.infer<typeof ClientNameSchema>;
/** Parsed body — defaults applied. What a route handler receives. */
export type ClientCreateBody = z.infer<typeof ClientCreateSchema>;
/**
 * Pre-parse shape — defaulted fields still optional. `ClientService.create` takes
 * this: it applies its own `?? 1` / `?? false` fallbacks, so demanding the parsed
 * shape would force every non-route caller (tests, the Sprint 9 `add_client` tool)
 * to hand-fill values the service is about to default anyway.
 */
export type ClientCreateInput = z.input<typeof ClientCreateSchema>;
