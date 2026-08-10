'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { api } from '@/lib/api';
import { useMonthContext } from '@/lib/hooks/use-month-context';

/**
 * "What's next" — the few tasks actually worth looking at (UIUX §5 left column).
 *
 * ⚠️ DELIBERATELY NOT A SECOND TASKS MODULE. The Tasks page owns the grid, the
 * filters and every mutation; this is a read-only shortlist whose only job is to
 * answer "what should I do now" without a click. Everything here links INTO
 * Tasks rather than reimplementing a slice of it — a home page that grows edit
 * affordances becomes a second surface to keep in step with the first.
 *
 * The shortlist is OVERDUE FIRST, then nearest deadline. Sorting by created date
 * would fill the list with whatever happened to be typed last, which is the one
 * ordering that carries no information.
 */
const SHOWN = 5;

interface TaskRow {
  id: string;
  description: string;
  status: string;
  deadline: string | null;
  clientName?: string | null;
  client?: { name: string } | null;
}

/** The status colours the grid already uses (UIUX §4.3 chips). */
const STATUS_TONE: Record<string, string> = {
  'To Do': 'var(--text-secondary)',
  'In Progress': 'var(--status-info, #3b82f6)',
  Blocked: 'var(--status-error, #ef4444)',
  Done: 'var(--status-success, #22c55e)',
  Cancelled: 'var(--text-muted)',
};

export function HomeTasks() {
  // Follows the sidebar period selector (§6.1) — the banner says which month you
  // are looking at, so these numbers had better be that month.
  const { period } = useMonthContext();
  const today = new Date().toISOString().slice(0, 10);

  const { data: tasks = [], isPending } = useQuery({
    queryKey: ['home-tasks', period],
    queryFn: async () => (await api<{ data: TaskRow[] }>(`/v1/tasks?period=${period}`)).data,
    staleTime: 60_000,
  });

  const shortlist = tasks
    .filter((t) => t.status !== 'Done' && t.status !== 'Cancelled')
    .sort((a, b) => {
      const overdue = (t: TaskRow) => (t.deadline && t.deadline < today ? 0 : 1);
      if (overdue(a) !== overdue(b)) return overdue(a) - overdue(b);
      // Undated tasks sink: a task with no deadline is not urgent, it is unplanned.
      return (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999');
    })
    .slice(0, SHOWN);

  return (
    <section aria-label="What's next">
      <div className="mb-3 flex items-baseline justify-between">
        <h2
          className="text-xs font-semibold uppercase tracking-wide"
          style={{ color: 'var(--text-muted)' }}
        >
          What&rsquo;s next
        </h2>
        <Link href="/tasks" className="text-xs" style={{ color: 'var(--accent-gold)' }}>
          All tasks
        </Link>
      </div>

      {isPending ? (
        <div className="space-y-2" aria-busy>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-12 animate-pulse rounded-md"
              style={{ background: 'var(--bg-surface)' }}
            />
          ))}
        </div>
      ) : shortlist.length === 0 ? (
        <p className="rounded-md border px-4 py-6 text-center text-sm"
           style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
          Nothing open this month.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-lg border" style={{ borderColor: 'var(--border-subtle)' }}>
          {shortlist.map((t) => {
            const late = Boolean(t.deadline && t.deadline < today);
            const client = t.clientName ?? t.client?.name ?? null;
            return (
              <li key={t.id} style={{ borderTop: '1px solid var(--border-subtle)' }} className="first:border-t-0">
                <Link
                  href={`/tasks?period=${period}&highlight=${t.id}`}
                  data-testid="home-task"
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors"
                  style={{ background: 'var(--bg-surface)' }}
                >
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: STATUS_TONE[t.status] ?? 'var(--text-muted)' }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm" style={{ color: 'var(--text-primary)' }}>
                      {t.description}
                    </span>
                    {client && (
                      <span className="block truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                        {client}
                      </span>
                    )}
                  </span>
                  {t.deadline && (
                    <span
                      className="shrink-0 text-[11px]"
                      style={{
                        fontFamily: 'var(--font-mono)',
                        // The only place a status colour appears here, and it is
                        // paired with the word "late" for anyone who cannot see it.
                        color: late ? 'var(--status-error, #ef4444)' : 'var(--text-muted)',
                      }}
                    >
                      {late ? 'late · ' : ''}
                      {t.deadline.slice(8)}/{t.deadline.slice(5, 7)}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
