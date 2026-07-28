# ADR-028 — Audit log export streams CSV via cursor

**Status:** Accepted • Pre-Sprint 11
**Cross-refs:** `13-NFRS.md` §2.2 (~50k rows at 12mo), §4.2 (append-only), §5.3 ·
`05-BACKEND-SCHEMA.md` (`audit_log`, migration `026_database_roles`) · ADR-027

> **Numbering note.** The Sprint 11 guide calls this ADR-025; that number is taken by
> `ADR-025-realtime-subscription-ordering` (Sprint 10.1). See ADR-026's note.

## Context

`audit_log` reaches ~50k rows at 12 months (NFR §2.2). An export is the first response in
the product whose size is a function of data volume rather than of page size — and it
lands on the same instance that ADR-027 now uses for PDF rendering. A buffered 50k-row
array is a memory spike arriving at exactly the worst moment.

## Decision

1. **The export streams.** Kysely `.stream()` (**requires `pg-query-stream`** — without
   it the failure is a *runtime* error, not a typecheck error) → a `csv-stringify`
   transform → `reply.send(stream)`. No buffered array, no `Content-Length`, chunked
   encoding, no memory ceiling.

2. **Streaming is safe here specifically because `audit_log` is append-only at the DB
   role level** — migration `026` revokes `UPDATE` and `DELETE` from `skaly_app`. Rows
   are immutable, so a long-running cursor cannot observe a row mutating underneath it.
   This is a property of this table, not a general licence to stream any query.

3. **One `WHERE` clause feeds two sinks.** The paginated JSON list on screen and the
   streamed CSV must not drift — an export that quietly disagrees with the table it was
   exported from is worse than no export. The predicate builder is extracted and called
   twice; it is not written twice.

4. **Real CSV escaping, not `join(',')`.** `old_value` / `new_value` are JSONB and
   contain commas, quotes, and newlines *by construction*. Hand-rolled serialisation
   produces a file that looks fine in a text editor and is silently corrupt in a
   spreadsheet — misaligned columns in an audit export is the failure mode you discover
   during an investigation.

5. **Explicit column list, never `SELECT *`,** so a future schema addition cannot
   silently widen the export.

6. **No mutation endpoints, at any layer.** No edit, no delete, no redact — not in the
   API, not in the UI. The DB role forbids it; the surfaces must reflect that rather than
   offering an action that can only fail.

## Rule

> A response whose size is a function of data volume streams. It is less code than
> paginating an export, not more.
