# ADR-019 — Query tools serialise record ids (the id contract)

**Status:** Accepted • Sprint 9
**Cross-refs:** SPRINT-9 reconciliation #11 · ADR-014 · ADR-018

## Context

Reconciliation #11 forbids a fuzzy-id resolver: to act on a record the model must
obtain its id from a query tool. Sprint 8 built the query tools **read-only**, where
an id was never needed, and `list_tasks` built its output lines by hand and omitted
the row id. The consequence in the real UI: the bot found the task, described it
correctly, and then said it could not act because "list_tasks doesn't return the task
id". Every task mutation was structurally dead — reachable only if the user already
knew the uuid.

The grid tools were unaffected because they `JSON.stringify` their DTOs, ids and all.
That is the tell: the gap is not a property of a domain, it is a property of
**hand-built output**.

## Decision

Every query tool's output MUST include the primary key of each record it returns. No
tool hand-builds a display line that drops the id. Where a mutation tool consumes an
id, the query tool that surfaces those records is contractually required to expose it.

A serialised-DTO output satisfies this automatically; a hand-built line must include
the id explicitly.

## Audit (Sprint 9, all 22 tools)

`list_tasks` was the only omission. `list_overdue_tasks` shares the same `line()`
helper, so it was fixed by the same change. The remaining candidates all serialise
their DTOs and already carried ids: `get_content_pipeline` (`PipelineDTO.id`),
`get_content_calendar` (`CalendarCellDTO.id`), `get_shoot_schedule` (`SlotDTO.id`),
`get_holiday_list` (`HolidayItem.id`), `get_client_summary` (`ClientListItem.id`).

## Guard

`test/lib/mutation-tools.test.ts` asserts, for **every** mutation tool, that it is
either a create (no target to look up) or has a named id field plus the query tool
that surfaces it — and then drives that pair against seeded rows: the query tool's
serialised output contains the id, and that id round-trips through the mutation
tool's input schema. A new mutation tool cannot be added without declaring which
query tool resolves its target, which is what stops the next hand-built tool from
silently re-breaking the feature.

| mutation | id | source query tool |
| --- | --- | --- |
| `update_task_status` / `set_deadline` / `assign_task` | `taskId` | `list_tasks` (and `list_overdue_tasks`) |
| `update_pipeline_stage` | `pipelineId` | `get_content_pipeline` |
| `update_shoot_slot` | `slotId` | `get_shoot_schedule` |
| `update_calendar_cell` | `cellId` | `get_content_calendar` |
| `remove_holiday` | `holidayId` | `get_holiday_list` |
| `deactivate_client` | `clientId` | `get_client_summary` |
| `create_task` / `add_holiday` / `add_client` | — | creates: no target yet |

## Known ceiling

`grids.ts`'s `asText` truncates a serialised grid at 6000 characters to protect the
1024-token budget, so ids beyond that point are not visible to the model (the full
grid still reaches the frontend via the card). A month large enough to truncate would
degrade to "ask for a narrower range", not to a wrong write. Revisit by serialising a
projection — id plus the display fields — rather than raising the cap.
