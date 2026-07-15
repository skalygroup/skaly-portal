/**
 * Single source of truth for the Work Allocation (tasks) request shapes.
 *
 * Both apps/api (request validation) and apps/web (form validation) import
 * from `@skaly/shared`. Keep the wire contract here in sync with
 * docs/07-API-CONTRACT.md §7 and docs/08-AUTH-MATRIX.md §4 — nowhere else.
 *
 * ADR-008: tasks are NOT versioned — no `version` field anywhere here.
 */
import { z } from 'zod';

/** 05-BACKEND-SCHEMA tasks CHECK enums — fixed by contract. */
export const TASK_STATUS_VALUES = ['To Do', 'In Progress', 'Blocked', 'Done', 'Cancelled'] as const;
export const TASK_PRIORITY_VALUES = ['Low', 'Medium', 'High', 'Urgent'] as const;

export const TaskStatusSchema = z.enum(TASK_STATUS_VALUES);
export const TaskPrioritySchema = z.enum(TASK_PRIORITY_VALUES);

const PeriodSchema = z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM');
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

// ─── Requests ────────────────────────────────────────────────────────────────

/** GET /v1/tasks — `period` required; every other filter optional. */
export const TaskQuerySchema = z.object({
  period: PeriodSchema,
  date: DateSchema.optional(),
  status: TaskStatusSchema.optional(),
  clientId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(),
  priority: TaskPrioritySchema.optional(),
});

/** POST /v1/tasks — assigneeIds defaults to [] so a task can be created unassigned. */
export const TaskCreateSchema = z.object({
  period: PeriodSchema,
  date: DateSchema,
  description: z.string().min(1),
  clientId: z.string().uuid().optional(),
  assigneeIds: z.array(z.string().uuid()).default([]),
  priority: TaskPrioritySchema.optional(),
  dependencyId: z.string().uuid().optional(),
  deadline: DateSchema.optional(),
  remark: z.string().optional(),
});

/**
 * PATCH /v1/tasks/:id — every field optional but at least one required.
 * Clearable fields accept null so a PATCH can null a dependency/client/etc.
 * No `version` (ADR-008); a stray `version` in the body is simply ignored.
 */
export const TaskUpdateSchema = z
  .object({
    description: z.string().min(1).optional(),
    clientId: z.string().uuid().nullable().optional(),
    priority: TaskPrioritySchema.nullable().optional(),
    dependencyId: z.string().uuid().nullable().optional(),
    deadline: DateSchema.nullable().optional(),
    remark: z.string().nullable().optional(),
    status: TaskStatusSchema.optional(),
    result: z.string().nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'At least one field must be provided.',
  });

/** POST /v1/tasks/:id/assignees — add one or more assignees. */
export const AssignSchema = z.object({
  staffIds: z.array(z.string().uuid()).min(1),
});

/** POST /v1/tasks/:id/attachments/presign — declared metadata (re-checked at confirm, ADR-007). */
export const AttachmentPresignSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  fileSize: z.number().int().positive(),
});

/** POST /v1/tasks/:id/attachments/confirm — the object the client actually PUT. */
export const AttachmentConfirmSchema = z.object({
  fileKey: z.string().min(1),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  fileSize: z.number().int().positive(),
});

export type TaskQuery = z.infer<typeof TaskQuerySchema>;
export type TaskCreateBody = z.infer<typeof TaskCreateSchema>;
export type TaskUpdateBody = z.infer<typeof TaskUpdateSchema>;
export type AssignBody = z.infer<typeof AssignSchema>;
export type AttachmentPresignBody = z.infer<typeof AttachmentPresignSchema>;
export type AttachmentConfirmBody = z.infer<typeof AttachmentConfirmSchema>;
