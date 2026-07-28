# ADR-027 — Report generation is asynchronous AND off the event loop

**Status:** Accepted • Pre-Sprint 11
**Cross-refs:** `13-NFRS.md` §1.2 · `10-INFRA-DEPLOYMENT.md` §4 (`healthcheckTimeout = 30`) ·
`11-THIRD-PARTY-INTEGRATIONS.md` §4.3 (`REPORT_EXPIRY_SECONDS = 86400`) ·
`05-BACKEND-SCHEMA.md` (`reports`, migration `017`) · ADR-020 (`report_ready`)

> **Numbering note.** The Sprint 11 guide calls this ADR-024; that number is taken by
> `ADR-024-rate-limit-keying` (Sprint 10.1). See ADR-026's note. The guide's "ADR-017
> (report_ready)" is this repo's **ADR-020**.

## Context

`@react-pdf/renderer` renders **synchronously**. A 10–15s render on the single Railway
instance blocks every other request on that instance, including `/v1/health` — and
`healthcheckTimeout` is 30s (INFRA §4). A month-end burst of report requests is therefore
not a slow-report problem; it is a **restart loop**.

This is the first CPU-bound work in the product. It sets the precedent for every later
one.

## The trap

Returning `202` while still rendering on the request event loop moves *when* the block
happens, not *whether*. The handler returns early, the render proceeds on the same
thread, and every concurrent request still stalls behind it. The code reads as correct —
there is an `await`, there is a `202` — and it passes review. Naming it here so it is
caught in review rather than in a health-check restart.

## Decision — the async contract AND off-loop execution. Both.

1. **`POST /v1/reports/generate`** validates `{ type, period, filters? }`, persists a
   `reports` row with `status: 'pending'`, dispatches, and returns **202 + `{ reportId }`**.
   No PDF, no link, in the response.

2. **THE RENDER LEAVES THE MAIN THREAD** — `worker_threads`. The worker opens its **own**
   DB connection; a `pg` pool is not shareable across threads.

3. **Four exit paths, one convergence.** Success, thrown error, `'exit'` without a
   message, and hard timeout all end in *mark the row, then notify*. A worker that dies
   without messaging must still mark the row `failed`, or a report sits `pending`
   forever with nothing to observe it. `'error'` and `'exit'` are handled, not just the
   success message.

4. **Documented concurrency cap: 2 concurrent renders, queued beyond that.** Two because
   the Railway instance is small and a PDF render is CPU-bound: one render leaves the box
   responsive, two saturate it without queueing at the OS level, and five simultaneous
   month-end requests must not spawn five renders. Raise it only with a measurement, not
   a hunch.

5. **Hard timeout past the NFR §1.2 p99 ceiling** (p99 < 20s → terminate at 30s). Past
   the ceiling the render is not slow, it is stuck, and a stuck worker holds a pool slot.

6. **Completion:** upload to R2 (private) → update `status: 'ready'`, `r2_key`,
   `completed_at` → fire **`report_ready`** carrying a presigned GET at
   `REPORT_EXPIRY_SECONDS` (24h — chosen precisely so a notification link survives a full
   working day). This is the first real producer for one of ADR-020's six deferred types;
   the deferred count drops 6 → 5.

7. **The persisted record is what makes the link cheap.** `GET /v1/reports/:id`
   regenerates a fresh presigned URL from the stored `r2_key`, so a user returning within
   24h never triggers a re-render. **Presigned links are regenerated on read, never
   stored** — a stored link is a link that expires in the database.

8. **Failure is a visible row**, `status: 'failed'` + `error_message` + a notification —
   never a silent nothing.

9. **Fonts are vendored into the repo**, not fetched by `Font.register` at render time. A
   network fetch inside a render is an unbounded stall in the middle of a timed
   operation, and it presents as "report generation is slow in a way that doesn't match
   render complexity".

## Schema note

Migration `017_reports` already exists, shaped for the synchronous design it was written
under: `file_key TEXT NOT NULL`, `generated_at`, and no status. A row cannot be inserted
before the file exists, which is exactly what a `pending` record must do. Sprint 11
alters it — `status`, `error_message`, `completed_at`, and `file_key` made nullable —
rather than creating a second table.

## Rule

> No synchronous CPU-bound work on the request event loop. Ever.
