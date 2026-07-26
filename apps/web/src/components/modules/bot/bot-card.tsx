'use client';

import { Check } from 'lucide-react';
import Link from 'next/link';

import type { BotCard as BotCardPayload } from './chat-state';

/**
 * The 11-card registry (STEP 7). One renderer per tool card type; a
 * <BotCard type payload /> dispatcher picks it and an unknown type falls back to
 * nothing (the streamed text already carries the answer).
 *
 * Grid-shaped cards (attendance, shoot, pipeline, calendar) render a compact
 * summary, not the full interactive grid — the bot's streamed text narrates the
 * detail and the real module owns the grid. // ponytail: summary over a second
 * grid impl; deepen a card only if a user actually asks for it inline.
 */

const frame: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 10,
};
const label: React.CSSProperties = { color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' };

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={frame} className="mt-2 overflow-hidden text-sm">
      <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--border-subtle)', ...label }}>
        {title}
      </div>
      <div className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>
        {children}
      </div>
    </div>
  );
}

/** A defensive array read — payloads come off the wire as `unknown`. */
function rows(payload: BotCardPayload, key: string): Record<string, unknown>[] {
  const v = payload[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}
const str = (v: unknown): string => (v == null ? '' : String(v));

function TaskList({ payload, title }: { payload: BotCardPayload; title: string }) {
  const tasks = rows(payload, 'tasks');
  if (tasks.length === 0) return <Frame title={title}>No matching tasks.</Frame>;
  return (
    <Frame title={`${title} · ${tasks.length}`}>
      <ul className="space-y-1">
        {tasks.map((t, i) => {
          const assignees = Array.isArray(t.assignees) ? (t.assignees as Record<string, unknown>[]) : [];
          const who = assignees.map((a) => str(a.name)).join(', ');
          return (
            <li key={i} className="flex flex-wrap gap-x-2">
              <span>{str(t.description)}</span>
              <span style={label}>{str(t.status)}</span>
              {t.deadline ? <span style={label}>due {str(t.deadline)}</span> : null}
              {who ? <span style={label}>({who})</span> : null}
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}

/** A generic two-column stat table for the count-based cards. */
function StatTable({
  title,
  items,
  name,
  cols,
}: {
  title: string;
  items: Record<string, unknown>[];
  name: (r: Record<string, unknown>) => string;
  cols: Array<[string, (r: Record<string, unknown>) => unknown]>;
}) {
  if (items.length === 0) return <Frame title={title}>Nothing to show.</Frame>;
  return (
    <Frame title={title}>
      <table className="w-full">
        <thead>
          <tr style={label}>
            <th className="text-left font-normal">Name</th>
            {cols.map(([h]) => (
              <th key={h} className="px-2 text-right font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((r, i) => (
            <tr key={i}>
              <td className="text-left">{name(r)}</td>
              {cols.map(([h, get]) => (
                <td key={h} className="px-2 text-right tabular-nums">
                  {str(get(r))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Frame>
  );
}

function gridSummary(payload: BotCardPayload, title: string, noun: string): React.ReactNode {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const items = Array.isArray(data.slots)
    ? data.slots
    : Array.isArray(data.rows)
      ? data.rows
      : Array.isArray(payload.rows)
        ? payload.rows
        : [];
  return (
    <Frame title={title}>
      {items.length} {noun}
      {items.length === 1 ? '' : 's'} for {str(payload.period)}. Open the module for the full grid.
    </Frame>
  );
}

/**
 * The two-turn confirmation card (ADR-014, UIUX §12, APPFLOW §9).
 *
 * DISPLAY + DISPATCH ONLY. Every value shown is rendered exactly as the server sent
 * it — no client-side re-derivation of `from`/`to`, no validation of the change. The
 * user is consenting to the SERVER's description of what will happen; if this
 * component computed any part of it, they would be consenting to something else.
 *
 * The buttons bind to `confirmationId` and nothing else. The client cannot name the
 * tool, the arguments, or the version — those live only in the server's pending
 * record, which is the point of the whole protocol.
 */
function ConfirmationCard({
  payload,
  actionable,
  onDecision,
}: {
  payload: BotCardPayload;
  actionable: boolean;
  onDecision?: (decision: 'confirm' | 'cancel', confirmationId: string) => void;
}) {
  const summary = (payload.summary ?? {}) as Record<string, unknown>;
  const confirmationId = str(payload.confirmationId);
  const changes = Array.isArray(summary.changes)
    ? (summary.changes as Record<string, unknown>[])
    : [];
  // Set by the reducer when a button was pressed; absent when the turn moved on some
  // other way (a typed "yes", a new question), which still disables the buttons.
  const resolved = payload.resolved === 'confirm' || payload.resolved === 'cancel' ? payload.resolved : null;
  const disabled = !actionable || resolved !== null || !confirmationId;

  return (
    <div style={{ ...frame, borderColor: 'var(--accent-gold-border)' }} className="mt-2 overflow-hidden text-sm">
      <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ color: 'var(--text-primary)' }}>{str(summary.action)}</div>
        <div style={label} className="text-xs">
          {str(summary.entity)} · {str(summary.target)}
          {summary.period ? ` · ${str(summary.period)}` : ''}
        </div>
      </div>

      <dl className="space-y-1 px-3 py-2">
        {changes.map((c, i) => (
          <div key={i} className="flex flex-wrap items-baseline gap-x-2">
            <dt style={label} className="text-xs">
              {str(c.field)}
            </dt>
            <dd className="flex items-baseline gap-2" style={{ fontFamily: 'var(--font-mono)' }}>
              <span style={{ color: 'var(--text-muted)' }}>{str(c.from)}</span>
              <span aria-hidden style={{ color: 'var(--text-muted)' }}>
                →
              </span>
              <span style={{ color: 'var(--text-primary)' }}>{str(c.to)}</span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex items-center gap-2 px-3 py-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onDecision?.('confirm', confirmationId)}
          className="rounded-md px-3 py-1 text-sm disabled:opacity-40"
          style={{ background: 'var(--accent-gold)', color: 'var(--bg-base)' }}
        >
          {resolved === 'confirm' ? 'Confirmed' : 'Confirm'}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onDecision?.('cancel', confirmationId)}
          className="rounded-md px-3 py-1 text-sm disabled:opacity-40"
          style={{ color: 'var(--text-secondary)' }}
        >
          {resolved === 'cancel' ? 'Cancelled' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

/** The turn-2 outcome: what changed, plus a deep link into the module that owns it. */
function MutationResultCard({ payload }: { payload: BotCardPayload }) {
  const summary = (payload.summary ?? {}) as Record<string, unknown>;
  const link = str(payload.link);
  return (
    <div style={frame} className="mt-2 flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
      <Check size={14} style={{ color: 'var(--accent-success, #4ade80)' }} aria-hidden />
      <span style={{ color: 'var(--text-secondary)' }}>
        {str(summary.action)}
        {summary.target ? ` · ${str(summary.target)}` : ''}
      </span>
      {link ? (
        <Link href={link} style={{ color: 'var(--accent-gold)' }}>
          View
        </Link>
      ) : null}
    </div>
  );
}

export function BotCard({
  payload,
  actionable = false,
  onDecision,
}: {
  payload: BotCardPayload;
  /** True only for the card on the LAST message — see chat-state's `send`. */
  actionable?: boolean;
  onDecision?: (decision: 'confirm' | 'cancel', confirmationId: string) => void;
}) {
  switch (payload.type) {
    case 'confirmation':
      return <ConfirmationCard payload={payload} actionable={actionable} onDecision={onDecision} />;
    case 'mutation_result':
      return <MutationResultCard payload={payload} />;
    case 'task_list':
      return <TaskList payload={payload} title="Tasks" />;
    case 'overdue_list':
      return <TaskList payload={payload} title={`Overdue as of ${str(payload.asOf)}`} />;
    case 'workload':
      return (
        <StatTable
          title={`Workload · ${str(payload.period)}`}
          items={rows(payload, 'users')}
          name={(r) => str(r.name)}
          cols={[
            ['open', (r) => r.open],
            ['overdue', (r) => r.overdue],
            ['done', (r) => r.done],
          ]}
        />
      );
    case 'project_status':
      return (
        <StatTable
          title={`Project status · ${str(payload.period)}`}
          items={rows(payload, 'projects')}
          name={(r) => str(r.clientName)}
          cols={[
            ['total', (r) => r.total],
            ['done', (r) => r.done],
            ['open', (r) => r.open],
            ['overdue', (r) => r.overdue],
          ]}
        />
      );
    case 'holiday_list': {
      const hs = rows(payload, 'holidays');
      return (
        <Frame title={`Holidays · ${str(payload.period)}`}>
          {hs.length === 0 ? (
            'None configured.'
          ) : (
            <ul className="space-y-1">
              {hs.map((h, i) => (
                <li key={i}>
                  <span style={label}>{str(h.date)}</span> {str(h.name)}
                </li>
              ))}
            </ul>
          )}
        </Frame>
      );
    }
    case 'client_summary': {
      const cs = rows(payload, 'clients');
      return (
        <Frame title={`Clients · ${cs.length}`}>
          {cs.length === 0 ? 'None.' : cs.map((c) => str(c.name)).join(', ')}
        </Frame>
      );
    }
    case 'audit_log': {
      const entries = rows(payload, 'entries');
      return (
        <Frame title={`Audit log${payload.hasMore ? ' (more available)' : ''}`}>
          {entries.length === 0 ? (
            'No entries.'
          ) : (
            <ul className="space-y-1">
              {entries.map((e, i) => (
                <li key={i}>
                  {str(e.summary)} <span style={label}>{str(e.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Frame>
      );
    }
    case 'attendance_summary':
      return gridSummary(payload, `Attendance · ${str(payload.period)}`, 'row');
    case 'shoot_schedule':
      return gridSummary(payload, `Shoot schedule · ${str(payload.period)}`, 'slot');
    case 'pipeline':
      return gridSummary(payload, `Content pipeline · ${str(payload.period)}`, 'row');
    case 'calendar':
      return gridSummary(payload, `Content calendar · ${str(payload.period)}`, 'entry');
    default:
      // Unknown card type → nothing; the streamed text stands on its own.
      return null;
  }
}
