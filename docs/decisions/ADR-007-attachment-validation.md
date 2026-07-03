# ADR-007 — Task attachment limits are enforced server-side, at presign AND confirm

**Status:** Accepted • Pre-Sprint 4 (build impact: Sprint 4)
**Cross-refs:** `07-API-CONTRACT.md` §5 · `04-APPFLOW.md` §5 · `09-ERROR-HANDLING.md` (`FILE_TOO_LARGE`, `TASK_ATTACHMENT_LIMIT_EXCEEDED`, `INVALID_FILE_TYPE`) · `lib/r2.ts` (Sprint 2) · `13-NFRS.md` §4.3

## Context
The flow is **presign → browser PUT to R2 → confirm** (insert `task_attachments` row). `lib/r2.ts` issues a **presigned PUT** (`PutObjectCommand`). A presigned PUT does **not** enforce content-length at R2 — the client controls the actual bytes regardless of any size declared at presign time. So presign-time checks alone are bypassable by a direct API caller.

## Decision — two enforcement points, both server-side, never UI-only
**1. PRESIGN** (`POST /v1/tasks/:id/attachments/presign`) validates **before** issuing a URL:
- `mimeType ∈ { application/pdf, image/jpeg, image/png, video/mp4, video/quicktime }` — else `400 INVALID_FILE_TYPE`. Set `ContentType` on the presigned PUT so R2 stores it and the client's PUT header must match.
- `declaredSize ≤ 50MB` — else `400 FILE_TOO_LARGE`.
- `SUM(existing task_attachments.file_size for this task) + declaredSize ≤ 200MB` — else `400 TASK_ATTACHMENT_LIMIT_EXCEEDED`.
- Presign route is rate-limited **20/hr keyed by staffId**.

**2. CONFIRM** (`POST /v1/tasks/:id/attachments/confirm`) re-validates the **actual** object:
- `HeadObject` the uploaded key → read real `ContentLength`.
- If `realSize > 50MB` **or** it pushes the task total over 200MB → `DeleteObject` the orphan and return `400` (`FILE_TOO_LARGE` / `TASK_ATTACHMENT_LIMIT_EXCEEDED`). **No DB row is written.**
- Only on pass → `INSERT task_attachments` with the **real** `file_size` + `mime_type`.

## Orphan reaping
Objects that are presigned + PUT but never confirmed (or rejected at confirm) leave R2 bytes with no DB row. Presigned objects use the key convention `attachments/{taskId}/{uuid}_{filename}`. An R2 lifecycle rule (or the Sprint 12 cron) sweeps objects under `attachments/` with no matching `task_attachments` row older than **24h**. Negligible at MVP volume, but not left dangling.

> **Key-prefix note (Sprint 4 reconciliation #6):** this ADR originally illustrated the key as `tasks/{taskId}/…`; the build uses the `attachments/{taskId}/{uuid}_{filename}` prefix to match `07-API-CONTRACT.md` §7 and the R2 lifecycle rule. Same per-task namespacing, contract-aligned prefix.

## Rule
A client can never store a disallowed or oversized attachment by calling the API directly. Browser checks are convenience; **presign + confirm are the boundary**, and both paths are tested (bad MIME rejected at presign; a small-declared / large-actual upload rejected + deleted at confirm; the 200MB task ceiling enforced across multiple attachments).

## Rationale
A presigned PUT can't express a content-length-range — that is a presigned **POST** policy feature, and R2's POST-policy support is partial — so a confirm-time `HeadObject` is the only reliable size backstop. Keeping the established PUT approach and adding confirm-time re-validation is airtight without changing `lib/r2.ts`'s signing method.
