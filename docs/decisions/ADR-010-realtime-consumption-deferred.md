# ADR-010 — Real-time is emitted now, consumed in Sprint 10

**Status:** Accepted • Pre-Sprint 4 (confirms Sprint 3 as-built; build impact: Sprints 4–6 + 10)
**Cross-refs:** Sprint 3 reconciliations #9 / #11 · `02-TRD.md` §8 · Audit C-05 · `04-APPFLOW.md` §11

## Context
Sprint 3 shipped the backend `attendance:holiday_added` / `attendance:holiday_removed` broadcasts to `org:all` (with a backend socket test) but **deliberately did not** build the frontend `/ws/notify` client and **did not** write holiday bell-notification rows. Own-mutation refresh works via TanStack Query invalidation; cross-user live refresh and bell notifications are Sprint 10. In the running app today, a holiday add/remove has **no cross-user visible effect** — only the acting user's own grid updates. This is intentional forward-wiring.

## Decision
1. **Sprints 4–6 keep emitting** their server-side broadcasts, and keep writing the notification rows that belong to a **persisted record** (e.g. `task_assigned` — ADR-006). Backend real-time wiring is built as each module lands and covered by backend socket tests.
2. **Sprints 4–6 do not build any frontend socket subscription.** No live cross-user grid refresh in the running app before Sprint 10. Leave `// TODO(Sprint 10)` markers where subscriptions will attach.
3. **Sprint 10 builds the single frontend socket client** (all namespaces) **with** the C-05 token-refresh handshake it depends on, subscribes every module's events, and completes bell-notification coverage — **including** the `holiday_added` / `holiday_removed` bell notifications carried from Sprint 3.

## The distinction that stays true
- **`task_assigned`** = a bell notification tied to a **persisted assignment** — the row is **written in Sprint 4** (it must exist regardless of who is online; ADR-006). Displayed in Sprint 10.
- **`holiday_added` / `holiday_removed` bell** = a transient "FYI" notification — **deferred to Sprint 10** (no rows written in Sprint 3–6).
- **Live grid refresh** from any broadcast (attendance, tasks, …) — **Sprint 10** (needs the client).

> Do not read "#3/#4 defer notifications" as "write no notification rows in Sprint 4." Durable, per-record notifications (`task_assigned`, later `dependency_resolved`) are written when their record changes. Only the transient holiday FYI bell and the frontend client are deferred.

## Rule
The backend **emits from the sprint that owns the event**; the frontend **consumes it all in Sprint 10**. Do not build a frontend socket client early, and do not delete "unused" broadcasts — they are forward-wiring with backend tests, awaiting their Sprint 10 consumer.

## Rationale
One socket client built once, alongside the C-05 refresh handshake it depends on, is cleaner and less error-prone than piecemeal per-module clients. Emitting early keeps Sprint 10 additive (attach consumers) rather than retrofitting emits across five modules.
