'use client';

/**
 * The old/new value diff for one audit row.
 *
 * ── Kept deliberately shallow ────────────────────────────────────────────────
 * `old_value` / `new_value` are JSONB written by `AuditService.log`, whose
 * callers pass flat objects of the columns that changed (`{ active, deletedAt }`,
 * `{ permissionKey, value }`). A recursive tree-differ would be a general
 * solution to a problem this data does not have — and the nested case it would
 * exist for, a whole row snapshot, is not a thing any caller writes.
 *
 * So: compare at the top level, JSON-stringify each side, show only keys whose
 * rendering differs. Nested objects still display correctly, just as one line
 * each instead of a drill-down. If a caller ever starts writing deep snapshots,
 * that is the moment to reach for a real differ — not before.
 */

type Json = unknown;

const isRecord = (v: Json): v is Record<string, Json> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `undefined` for an absent key, so "added" and "set to null" stay different. */
function show(value: Json): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export interface DiffLine {
  key: string;
  before?: string;
  after?: string;
}

/**
 * Only the keys that actually CHANGED. An INSERT has no `old_value` and a DELETE
 * has no `new_value`, so both come out as every key on the side that exists —
 * which is right: for those actions every field is the change.
 */
export function diffLines(oldValue: Json, newValue: Json): DiffLine[] {
  const before = isRecord(oldValue) ? oldValue : {};
  const after = isRecord(newValue) ? newValue : {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

  return keys
    .map((key) => ({ key, before: show(before[key]), after: show(after[key]) }))
    .filter((line) => line.before !== line.after);
}

export function AuditDiff({ oldValue, newValue }: { oldValue: Json; newValue: Json }) {
  const lines = diffLines(oldValue, newValue);

  if (lines.length === 0) {
    return (
      <p className="px-4 py-3 text-[12.5px] text-text-muted">
        No field-level detail was recorded for this entry.
      </p>
    );
  }

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-4 py-3 font-[family-name:var(--font-mono)] text-[12px]">
      {lines.map((line) => (
        <div key={line.key} className="col-span-2 grid grid-cols-[minmax(9rem,auto)_1fr] gap-x-4">
          <dt className="text-text-muted">{line.key}</dt>
          <dd className="flex flex-wrap items-baseline gap-2 break-all">
            {line.before !== undefined && (
              <span className="rounded bg-status-red/10 px-1.5 py-0.5 text-status-red line-through">
                {line.before}
              </span>
            )}
            {line.after !== undefined && (
              <span className="rounded bg-status-green/10 px-1.5 py-0.5 text-status-green">
                {line.after}
              </span>
            )}
            {/* A key present on one side only is an add or a removal; the single
                chip above already says which by its colour. */}
          </dd>
        </div>
      ))}
    </dl>
  );
}
