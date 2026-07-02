# Decisions log

Lightweight, one-line rulings that don't warrant a full ADR. Full ADRs live
alongside this file (`ADR-00N-*.md`).

## Bot streaming namespace (Sprint 3 pre-flight, decision #4)

**2026-07-03 — Accepted.** Bot streaming stays on `/ws/notify`; no fourth
namespace. Sprint 8 emits `bot:message` via
`io.of('/ws/notify').to('user:' + staffId).emit('bot:message', …)`; the bot UI
subscribes to `bot:message` on its existing `/ws/notify` connection. The three
canonical namespaces (`/ws/chat`, `/ws/presence`, `/ws/notify`, 02-TRD §8)
stand. Revisit only if Sprint 13 load tests show bot streaming degrading
notification/grid latency.
