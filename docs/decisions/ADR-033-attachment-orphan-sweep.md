# ADR-033 — The attachment orphan sweep is prefix-scoped and audited

**Status:** Accepted • Pre-Sprint 12 (completes ADR-007's deferral)
**Cross-refs:** ADR-007 (attachment validation) · `10-INFRA-DEPLOYMENT.md` §1 (one bucket
holds attachments + CVs + reports + backups) · `11-THIRD-PARTY-INTEGRATIONS.md` §4.1
(versioning, 90-day) + §4.3 (`UPLOAD_EXPIRY_SECONDS = 900`) · `05-BACKEND-SCHEMA.md`
(`task_attachments.file_key`)

## Context

A presigned PUT that completed while the confirm call never arrived leaves an R2 object
with no `task_attachments` row. It is a genuine orphan wasting bytes, and `lib/r2.ts` has
carried a `TODO(Sprint 12 cron)` for it since Sprint 4.

An object that is **mid-upload right now** looks identical to that orphan. So does every
CV, every generated report, and every nightly database backup — because Infra §1 puts them
all in the same bucket.

## Decision

1. **Scope: keys under the attachments prefix only.** The prefix is `attachments/` —
   `TaskAttachmentService` presigns `attachments/{taskId}/{uuid}_{name}` and its confirm
   path already rejects a `fileKey` that does not start with it.

2. **The prefix scope is a CODE ASSERTION, not a comment.** The sweep asserts a non-empty
   prefix equal to the attachments prefix before it issues its first `ListObjectsV2`, and
   throws otherwise. A refactor that drops or blanks the prefix must fail loudly on the
   first line, because the unscoped version of this job — "delete every key with no
   `task_attachments` row" — deletes every backup, every CV, and every report in one run.
   This is the most dangerous line in Sprint 12.

3. **Age comes from R2 `LastModified`, never a DB timestamp.** The orphan has no DB row to
   carry one. A key is deletable only when it is older than **1 hour** — well past
   `UPLOAD_EXPIRY_SECONDS` (900), so an upload in flight is never reaped.

4. **Never delete on a DB-side "pending" flag alone.** The crash being cleaned up after is
   exactly the one that fails to set it.

5. **The DB lookup is batched** — one `WHERE file_key IN (…)` per `ListObjectsV2` page, not
   a query per object.

6. **Every deletion is audited to the System Actor** (`AuditService` with `actorId: null`):
   key, reason `orphan`, and age. An unattended deleter's audit trail is the only way
   anyone ever finds out what it removed.

7. **R2 versioning (90-day) makes a delete a delete-marker**, so an over-aggressive sweep is
   recoverable within 90 days. That LOWERS the blast radius; it does **not** excuse the
   scoping, and it is not a reason to relax the assertion.

8. **The other orphan direction — a `task_attachments` row whose object is gone — is
   handled LAZILY at download**, not by a cron HEAD-storm over every row. The download path
   already `HEAD`s; when the object is missing it returns a clean `RESOURCE_NOT_FOUND`
   instead of handing back a presigned URL that 404s in the browser.

   **No `missing_at` column.** The schema has none, the sprint's other work needs none, and
   a migration to persist a state that a single `HEAD` re-derives on demand is storage for
   its own sake. If a "broken attachment" badge is ever wanted in the UI, that is the
   moment to add the column — not before.

9. **Idempotent.** Two runs back-to-back delete the same set exactly once; the second finds
   nothing.

10. **Schedule: daily, 04:00 IST**, on the existing Railway cron service behind
    `X-Internal-Secret` — clear of the 00:01 rollover window and of the 03:00 retention job.

## Rule

> A scheduled deleter with no user watching gets a scope it cannot exceed, asserted in
> code, and an audit trail for every byte it removes.
