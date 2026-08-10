'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Camera, CheckCircle2, ClipboardList, UserCheck } from 'lucide-react';
import Link from 'next/link';

import { api } from '@/lib/api';
import { useMonthContext } from '@/lib/hooks/use-month-context';

/**
 * The home page's headline numbers (UIUX §5 role-specific widgets).
 *
 * A KPI ROW OF STAT TILES, not charts — four headline figures is exactly the case
 * where a chart adds ink and removes clarity. Each tile is label + value + a
 * one-line context string, and nothing is a bare number: "24" means nothing,
 * "24 of 26 working days" is an answer.
 *
 * ⚠️ EVERY TILE IS A LINK. A number you cannot act on is decoration — the whole
 * complaint that produced this page was that it told you nothing. Overdue goes to
 * Tasks, attendance to the grid, shoots to the planner, the signup queue to its
 * panel.
 *
 * Fed by ONE ~1KB request (`/v1/home-summary`). Deriving these client-side from
 * the module endpoints would have cost ~600KB on the landing page — see
 * HomeSummaryService's header.
 */
interface Summary {
  period: string;
  scope: 'own' | 'organisation';
  tasks: { todo: number; inProgress: number; blocked: number; done: number; overdue: number } | null;
  attendance: { presentDays: number; workingDays: number; pct: number | null } | null;
  shoots: { confirmed: number; unset: number; nextDate: string | null } | null;
  pendingSignups: number | null;
}

/** 'YYYY-MM-DD' → 'Tue 12 Aug', without pulling a formatter over a 10-char string. */
function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function HomeSummary() {
  // Follows the sidebar period selector (§6.1) — the banner says which month you
  // are looking at, so these numbers had better be that month.
  const { period } = useMonthContext();

  const { data, isPending, isError } = useQuery({
    queryKey: ['home-summary', period],
    queryFn: async () => (await api<{ data: Summary }>(`/v1/home-summary?period=${period}`)).data,
    staleTime: 60_000,
  });

  if (isPending) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-[92px] animate-pulse rounded-lg border"
            style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          />
        ))}
      </div>
    );
  }

  // A failed summary must not take the page down — the activity feed and the
  // task list below it are independently useful, and a red panel where four
  // numbers should be is worse than their quiet absence.
  if (isError || !data) return null;

  const { tasks, attendance, shoots, pendingSignups, scope } = data;
  const openTasks = tasks ? tasks.todo + tasks.inProgress + tasks.blocked : 0;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {tasks && (
        <Tile
          href="/tasks"
          icon={ClipboardList}
          label={scope === 'own' ? 'Your open tasks' : 'Open tasks'}
          value={openTasks}
          context={
            openTasks === 0
              ? tasks.done > 0
                ? `All ${tasks.done} done`
                : 'Nothing assigned'
              : `${tasks.inProgress} in progress · ${tasks.blocked} blocked`
          }
        />
      )}

      {tasks && (
        <Tile
          href="/tasks"
          icon={tasks.overdue > 0 ? AlertTriangle : CheckCircle2}
          label="Overdue"
          value={tasks.overdue}
          context={tasks.overdue > 0 ? 'Past deadline, not done' : 'Nothing past its deadline'}
          // Status colour is reserved and never decorative — it appears ONLY when
          // something is actually overdue, and always beside an icon and the word
          // "Overdue", never as colour alone.
          tone={tasks.overdue > 0 ? 'critical' : 'good'}
        />
      )}

      {attendance && (
        <Tile
          href="/attendance"
          icon={UserCheck}
          label={scope === 'own' ? 'Your attendance' : 'Team attendance'}
          value={attendance.pct === null ? '—' : `${attendance.pct}%`}
          context={
            attendance.workingDays === 0
              ? 'No working days yet'
              : `${attendance.presentDays} of ${attendance.workingDays} working days`
          }
        />
      )}

      {shoots && (
        <Tile
          href="/shoot-planner"
          icon={Camera}
          label="Next shoot"
          value={shoots.nextDate ? shortDate(shoots.nextDate) : '—'}
          context={
            shoots.nextDate
              ? `${shoots.confirmed} confirmed this month`
              : shoots.unset > 0
                ? `${shoots.unset} slots still unset`
                : 'Nothing scheduled'
          }
          // A date is not a magnitude — it must not be squeezed to a numeral size.
          compact
        />
      )}

      {pendingSignups !== null && pendingSignups > 0 && (
        <Tile
          href="/settings/signup-requests"
          icon={ClipboardList}
          label="Signup requests"
          value={pendingSignups}
          context="Waiting on your review"
          tone="warning"
        />
      )}
    </div>
  );
}

type Tone = 'neutral' | 'good' | 'warning' | 'critical';

const TONE_COLOR: Record<Tone, string> = {
  neutral: 'var(--text-muted)',
  good: 'var(--status-success, #22c55e)',
  warning: 'var(--status-amber, #f59e0b)',
  critical: 'var(--status-error, #ef4444)',
};

function Tile({
  href,
  icon: Icon,
  label,
  value,
  context,
  tone = 'neutral',
  compact = false,
}: {
  href: string;
  icon: typeof ClipboardList;
  label: string;
  value: number | string;
  context: string;
  tone?: Tone;
  compact?: boolean;
}) {
  return (
    <Link
      href={href}
      data-testid="home-tile"
      data-tone={tone}
      className="group flex flex-col justify-between rounded-lg border p-4 transition-colors"
      style={{
        minHeight: 92,
        background: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      <div className="flex items-center gap-2">
        <Icon size={14} aria-hidden style={{ color: TONE_COLOR[tone] }} />
        <span
          className="text-[11px] uppercase tracking-wide"
          style={{ color: 'var(--text-muted)' }}
        >
          {label}
        </span>
      </div>

      <div className="mt-2">
        <div
          // Proportional figures, not tabular: these are standalone values, and
          // tabular-nums gives every digit a '0' width, which reads loose at
          // display sizes. Tabular is for COLUMNS that must align.
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: compact ? 20 : 28,
            fontWeight: 600,
            lineHeight: 1.1,
            // Text wears text tokens; the tone rides the icon beside it. A value
            // painted in a status colour is unreadable to anyone who cannot see it.
            color: 'var(--text-primary)',
          }}
        >
          {value}
        </div>
        <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-secondary)' }}>
          {context}
        </p>
      </div>
    </Link>
  );
}
