# ADR-015 — Search role scoping and ranking

**Status:** Accepted • Pre-Sprint 9 (build impact: Sprint 9, Sprint 11)
**Cross-refs:** Audit M-05 · `08-AUTH-MATRIX.md` §4 · ADR-011 · `05-BACKEND-SCHEMA.md` §8

## Context

`GET /v1/search` spans four categories owned by four different services, each with its own
role scoping. The question is where that scoping lives, and how each category ranks.

## Decision

1. **Query-time role filtering mirroring each owning service.** Never a visibility predicate
   baked into index rows — that is a second permission implementation, the exact class of bug
   Sprint 8.1 deleted.

2. **Parity means exactly the service's scope — not stricter.** `team_member` tasks are
   **not** row-filtered: Auth-Matrix §4 grants `team_member` read on all tasks. Filtering
   search harder than the service is a parity break that fails safe, so it goes unnoticed.
   The real isolation surface is **freelancer** (no tasks; comments only on their own shoot
   rows) and **comments** (`team_member`: own + manager/admin replies on the same record).

3. **There is no `search_indexes` table.** Migration 025 creates *indexes*.

   | Category | Ranking |
   |---|---|
   | `tasks`, `comments` | `ts_rank(search_vector, websearch_to_tsquery($1))` |
   | `clients`, `staff` | `name ILIKE '%q%'` (accelerated by `gin_trgm_ops`), `ORDER BY similarity(name, $1) DESC` |

   Two of the four categories have no `search_vector` column; ranking them with `ts_rank`
   does not compile.

4. **`scope=current` filters `tasks` and `comments` only.** `clients` and `staff` have no
   period column; applying the filter there returns zero rows and reads as a broken search.

5. **`LIMIT 20` per category**; the palette renders 5 with `[Show more]`. Audit M-05's
   `LIMIT 5` leaves UI/UX §17's `[Show more]` nothing to reveal.

## Rule

Search returns exactly what that user could already read, ranked, per category.
A search-parity test asserts row-set equality against the owning service.

## Rationale

Search is the easiest place in a portal to leak a row, because it crosses every module at
once and nobody writes a permission test for a text box. Delegating scope to the owning
service keeps one implementation of "who can see this".
