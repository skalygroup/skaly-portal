'use client';

import type { TaskAssignee } from './types';

/**
 * Read-only status/priority/dependency/assignee presenters for the tasks grid
 * (UIUX §4.3 chips, §8 columns). Colours come only from the --status-* tokens
 * in globals.css; Step 7 makes the status chip interactive.
 */

// Status enum → colour token (UIUX §4.3). Cancelled also strikes through.
const STATUS_TOKEN: Record<string, string> = {
  'To Do': '--status-grey',
  'In Progress': '--status-blue',
  Blocked: '--status-red',
  Done: '--status-green',
  Cancelled: '--status-grey',
};

// Priority enum → colour token (reconciliation #11).
const PRIORITY_TOKEN: Record<string, string> = {
  Low: '--status-grey',
  Medium: '--status-blue',
  High: '--status-amber',
  Urgent: '--status-red',
};

/** A pill in a --status-* colour: coloured text on a dim tint of the same hue. */
function Pill({ token, children, strike }: { token: string; children: React.ReactNode; strike?: boolean }) {
  const color = `var(${token})`;
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
        textDecoration: strike ? 'line-through' : undefined,
      }}
    >
      {children}
    </span>
  );
}

export function StatusChip({ status }: { status: string }) {
  return (
    <Pill token={STATUS_TOKEN[status] ?? '--status-grey'} strike={status === 'Cancelled'}>
      {status}
    </Pill>
  );
}

export function PriorityBadge({ priority }: { priority: string | null }) {
  if (!priority) return null;
  return <Pill token={PRIORITY_TOKEN[priority] ?? '--status-grey'}>{priority}</Pill>;
}

/**
 * Dependency indicator: a red "Blocked by" badge when the dependency is
 * unresolved, or a subtle link chip when it exists but is resolved.
 */
export function DependencyBadge({
  blocked,
  description,
  id,
}: {
  blocked: boolean;
  description: string | null;
  id: string;
}) {
  if (!description) return null;
  const descId = `dep-${id}`;
  if (blocked) {
    return (
      <span
        aria-describedby={descId}
        title={`Blocked by: ${description}`}
        className="inline-flex max-w-[160px] items-center gap-1 truncate rounded px-2 py-0.5 text-xs font-medium"
        style={{
          color: 'var(--status-red)',
          background: 'color-mix(in srgb, var(--status-red) 12%, transparent)',
          border: '1px solid color-mix(in srgb, var(--status-red) 28%, transparent)',
        }}
      >
        <span id={descId} className="truncate">
          Blocked by: {description}
        </span>
      </span>
    );
  }
  return (
    <span
      title={`Depends on: ${description}`}
      className="inline-flex max-w-[160px] items-center truncate rounded px-2 py-0.5 text-xs"
      style={{ color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}
    >
      {description}
    </span>
  );
}

/** Overlapping 24px avatar stack, showing up to 4 then a +N overflow chip. */
export function AssigneeStack({ assignees }: { assignees: TaskAssignee[] }) {
  if (assignees.length === 0) {
    return (
      <span className="text-xs" style={{ color: 'var(--text-disabled)' }}>
        —
      </span>
    );
  }
  const shown = assignees.slice(0, 4);
  const overflow = assignees.length - shown.length;
  return (
    <div className="flex items-center" aria-label={`${assignees.length} assignee(s)`}>
      {shown.map((a, i) => (
        <Avatar key={a.id} assignee={a} style={{ marginLeft: i === 0 ? 0 : -8, zIndex: shown.length - i }} />
      ))}
      {overflow > 0 ? (
        <span
          className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold"
          style={{
            marginLeft: -8,
            background: 'var(--bg-elevated)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border-default)',
          }}
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}

function Avatar({ assignee, style }: { assignee: TaskAssignee; style?: React.CSSProperties }) {
  const initials = assignee.name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return assignee.avatarUrl ? (
    // 24px avatar from a remote URL; not worth the next/image pipeline.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={assignee.avatarUrl}
      alt={assignee.name}
      title={assignee.name}
      className="h-6 w-6 rounded-full object-cover"
      style={{ border: '1px solid var(--bg-surface)', ...style }}
    />
  ) : (
    <span
      title={assignee.name}
      className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold"
      style={{
        background: 'var(--accent-gold-dim)',
        color: 'var(--accent-gold)',
        border: '1px solid var(--bg-surface)',
        ...style,
      }}
    >
      {initials}
    </span>
  );
}
