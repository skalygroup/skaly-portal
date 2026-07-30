'use client';

import { Loader2 } from 'lucide-react';
import { useEffect } from 'react';

import { cn } from '@/lib/utils';

/**
 * The shape every settings panel repeats: header, table, row actions, and a
 * confirmation that names its consequence.
 *
 * Extracted at panel two of seven rather than panel five. The pieces are small
 * on purpose — a `<SettingsPanel>` that owned fetching and mutations would have
 * to grow a prop for every difference between Staff and Months, and the four
 * primitives here cover all seven without any of them knowing what a row is.
 */

export function PanelHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-bold text-text-primary">
          {title}
        </h1>
        <p className="mt-1 text-sm text-text-muted">{description}</p>
      </div>
      {action}
    </header>
  );
}

/** Base modal — Escape to close, click-outside to close, focus-trapped by role. */
export function Modal({
  title,
  onClose,
  children,
  width = 'max-w-md',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-5"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'w-full rounded-2xl border border-border-subtle bg-bg-surface p-6 shadow-[0_30px_70px_-30px_rgba(0,0,0,0.85)]',
          width,
        )}
      >
        <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-text-primary">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/**
 * A destructive confirmation that NAMES the consequence.
 *
 * `consequence` is required, not optional, and that is the whole point of the
 * component. "Are you sure?" is a speed bump: it asks a question the user
 * already answered by clicking. What they cannot know without being told is
 * that deactivating signs the person out of their open tab right now.
 */
export function ConfirmDialog({
  title,
  consequence,
  confirmLabel,
  destructive = true,
  pending = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  consequence: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={pending ? () => {} : onCancel}>
      <p className="mt-2 text-[13.5px] leading-[1.6] text-text-secondary">{consequence}</p>
      <div className="mt-6 flex justify-end gap-2.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-md border border-border-default bg-bg-elevated px-4 py-2 text-[13.5px] font-semibold text-text-secondary hover:bg-bg-hover disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className={cn(
            'inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13.5px] font-semibold transition-[filter] hover:brightness-[1.06] disabled:opacity-60',
            destructive ? 'bg-status-red text-white' : 'bg-accent-gold text-bg-base',
          )}
        >
          {pending && <Loader2 size={15} className="animate-spin" />}
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/** Table chrome. The panels own their columns; this owns the borders. */
export function PanelTable({
  head,
  children,
  empty,
  loading,
}: {
  head: React.ReactNode;
  children: React.ReactNode;
  empty?: boolean;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-16 text-text-muted">
        <Loader2 size={18} className="animate-spin" />
        <span className="text-sm">Loading…</span>
      </div>
    );
  }
  if (empty) {
    return (
      <div className="rounded-xl border border-dashed border-border-default bg-bg-surface px-6 py-16 text-center">
        <p className="text-sm text-text-muted">Nothing here yet.</p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border-subtle bg-bg-surface">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead>
          <tr className="border-b border-border-subtle">{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        'px-4 py-3 font-[family-name:var(--font-mono)] text-[10.5px] uppercase tracking-[0.12em] text-text-muted',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn('px-4 py-3 text-[13.5px] text-text-secondary', className)}>{children}</td>;
}

/** Row action. Rendered only where the caller has the write permission. */
export function RowAction({
  onClick,
  children,
  tone = 'default',
}: {
  onClick: () => void;
  children: React.ReactNode;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md border border-border-default bg-bg-elevated px-2.5 py-1 text-[12.5px] font-semibold transition-colors',
        tone === 'danger'
          ? 'text-text-secondary hover:border-status-red/60 hover:text-status-red'
          : 'text-text-secondary hover:border-accent-gold hover:text-text-primary',
      )}
    >
      {children}
    </button>
  );
}

export function StatusPill({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        'rounded-full px-2.5 py-0.5 text-[11px] font-medium',
        active ? 'bg-status-green/10 text-status-green' : 'bg-status-red/10 text-status-red',
      )}
    >
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}
