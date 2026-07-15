/**
 * Wire shapes for the Work Allocation grid — the camelCase JSON the API's
 * GET /v1/tasks returns (07-API-CONTRACT §7 / apps/api TaskDTO). Kept in sync
 * with the backend DTO; the shared Zod schemas cover only request bodies.
 */

export interface TaskAssignee {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface TaskAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string | null;
  uploadedBy: string;
  uploadedAt: string | null;
}

export interface Task {
  id: string;
  period: string;
  /** 'YYYY-MM-DD'. */
  date: string;
  description: string;
  clientId: string | null;
  clientName: string | null;
  status: string;
  priority: string | null;
  dependencyId: string | null;
  dependencyDescription: string | null;
  /** dependency set AND that task ≠ Done. Drives the red "Blocked by" badge. */
  dependencyBlocked: boolean;
  deadline: string | null;
  remark: string | null;
  result: string | null;
  assignees: TaskAssignee[];
  attachmentCount: number;
  createdBy: string;
  createdAt: string | null;
}

/** getTask (row expansion, Step 7) adds the full attachments list. */
export interface TaskDetail extends Task {
  attachments: TaskAttachment[];
}
