'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Lock, LockOpen } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import {
  ConfirmDialog,
  Modal,
  PanelHeader,
  PanelTable,
  RowAction,
  Td,
  Th,
} from '@/components/settings/panel-chrome';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

interface MonthRow {
  period: string;
  label: string;
  locked: boolean;
  lockedAt: string | null;
  lockedByName: string | null;
  unlockedAt: string | null;
  unlockedByName: string | null;
  unlockReason: string | null;
}

const QUERY_KEY = ['settings', 'months'] as const;

export function MonthsPanel({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const [locking, setLocking] = useState<MonthRow | null>(null);
  const [unlocking, setUnlocking] = useState<MonthRow | null>(null);

  const { data = [], isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => (await api<{ data: MonthRow[] }>('/v1/months')).data,
    staleTime: 30_000,
  });

  const lock = useMutation({
    mutationFn: (row: MonthRow) => api(`/v1/months/${row.period}/lock`, { method: 'POST' }),
    onSuccess: (_r, row) => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      setLocking(null);
      toast.success(`${row.label} is locked. Every module is read-only for that month.`);
    },
    onError: () => toast.error('Could not lock that month. Try again.'),
  });

  return (
    <div>
      <PanelHeader
        title="Months"
        description="Close a period when its numbers are final. Locking makes every module read-only for that month."
      />

      <PanelTable
        loading={isLoading}
        empty={data.length === 0}
        head={
          <>
            <Th>Period</Th>
            <Th>State</Th>
            <Th>History</Th>
            {canWrite && <Th className="text-right">Actions</Th>}
          </>
        }
      >
        {data.map((row) => (
          <tr key={row.period} className="border-b border-border-subtle last:border-0">
            <Td className="font-medium text-text-primary">{row.label}</Td>
            <Td>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
                  row.locked
                    ? 'bg-status-red/10 text-status-red'
                    : 'bg-status-green/10 text-status-green',
                )}
              >
                {row.locked ? <Lock size={12} /> : <LockOpen size={12} />}
                {row.locked ? 'Locked' : 'Open'}
              </span>
            </Td>
            {/* A locked month says who closed it; an open one that was REOPENED
                says why. The unlock reason is the only thing on this screen that
                explains a decision, so it is worth a column rather than a
                tooltip. */}
            <Td className="text-[12.5px] text-text-muted">
              {row.locked ? (
                row.lockedByName ? (
                  <>
                    Locked by {row.lockedByName}
                    {row.lockedAt ? ` on ${row.lockedAt.slice(0, 10)}` : ''}
                  </>
                ) : (
                  '—'
                )
              ) : row.unlockReason ? (
                <>
                  Reopened by {row.unlockedByName ?? 'an admin'}
                  {row.unlockedAt ? ` on ${row.unlockedAt.slice(0, 10)}` : ''} — “{row.unlockReason}
                  ”
                </>
              ) : (
                '—'
              )}
            </Td>
            {canWrite && (
              <Td className="text-right">
                {row.locked ? (
                  <RowAction onClick={() => setUnlocking(row)}>Unlock</RowAction>
                ) : (
                  <RowAction tone="danger" onClick={() => setLocking(row)}>
                    Lock
                  </RowAction>
                )}
              </Td>
            )}
          </tr>
        ))}
      </PanelTable>

      {/* Lock is ONE click behind one confirmation — no reason required. It is the
          intended end state of a month; the asymmetry with unlock is deliberate,
          because reopening a closed month is the act that rewrites history. */}
      {locking && (
        <ConfirmDialog
          title={`Lock ${locking.label}?`}
          consequence={
            <>
              <strong className="font-semibold text-text-primary">
                Every module goes read-only for {locking.label}
              </strong>{' '}
              — attendance, tasks, shoots, the content grids, all of it. Nobody, including you, can
              edit that month&apos;s data until it is unlocked again, and unlocking asks you to say
              why.
            </>
          }
          confirmLabel="Lock month"
          pending={lock.isPending}
          onConfirm={() => lock.mutate(locking)}
          onCancel={() => setLocking(null)}
        />
      )}

      {unlocking && (
        <UnlockModal
          row={unlocking}
          onClose={() => setUnlocking(null)}
          onUnlocked={() => {
            void qc.invalidateQueries({ queryKey: QUERY_KEY });
            setUnlocking(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Unlock — the only action in Settings that requires the admin to write
 * something down.
 *
 * `UNLOCK_REASON_REQUIRED` is enforced in `MonthService`, not by the route's Zod
 * body, which is what makes it a business rule with ONE gate rather than two
 * that disagree depending on whether you sent `{}` or nothing. The panel's job
 * is to put that code on the reason FIELD — a toast would vanish while the
 * admin is still looking at the empty textarea it is about.
 */
function UnlockModal({
  row,
  onClose,
  onUnlocked,
}: {
  row: MonthRow;
  onClose: () => void;
  onUnlocked: () => void;
}) {
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api(`/v1/months/${row.period}/lock`, {
        method: 'DELETE',
        body: JSON.stringify({ reason: reason.trim() }),
      }),
    onSuccess: () => {
      onUnlocked();
      toast.success(`${row.label} is open again.`);
    },
    onError: (err) => {
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      if (code === 'UNLOCK_REASON_REQUIRED') {
        setFieldError('Say why this month is being reopened — it goes in the audit log.');
        return;
      }
      if (code === 'VALIDATION_ERROR') {
        setFieldError('Keep the reason under 500 characters.');
        return;
      }
      toast.error('Could not unlock that month. Try again.');
    },
  });

  return (
    <Modal title={`Unlock ${row.label}?`} onClose={onClose}>
      <p className="mt-2 text-[13.5px] leading-[1.6] text-text-secondary">
        {row.label} becomes editable again across every module, and this reason is written to the
        audit log next to your name. It stays visible on this screen afterwards.
      </p>

      <label className="mt-5 block text-[13px] font-semibold text-text-primary" htmlFor="unlock-reason">
        Reason <span className="text-text-muted">(required)</span>
      </label>
      <textarea
        id="unlock-reason"
        value={reason}
        onChange={(e) => {
          setReason(e.target.value);
          setFieldError(null);
        }}
        rows={3}
        maxLength={500}
        disabled={mutation.isPending}
        placeholder="Correcting three attendance rows entered against the wrong client."
        aria-invalid={fieldError !== null}
        aria-describedby={fieldError ? 'unlock-reason-error' : undefined}
        className="mt-1.5 w-full resize-y rounded-md border border-border-default bg-bg-elevated px-3 py-2.5 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)] aria-[invalid=true]:border-status-red"
      />
      {fieldError && (
        <p id="unlock-reason-error" role="alert" className="mt-1.5 text-[12.5px] text-status-red">
          {fieldError}
        </p>
      )}

      <div className="mt-6 flex justify-end gap-2.5">
        <button
          type="button"
          onClick={onClose}
          disabled={mutation.isPending}
          className="rounded-md border border-border-default bg-bg-elevated px-4 py-2 text-[13.5px] font-semibold text-text-secondary hover:bg-bg-hover disabled:opacity-60"
        >
          Cancel
        </button>
        {/* Deliberately NOT disabled on an empty reason. The rule lives on the
            server; letting the click through is what proves the server said no
            and puts its answer on the field, rather than hiding the requirement
            behind a greyed-out button that never explains itself. */}
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          className="inline-flex items-center gap-2 rounded-md bg-accent-gold px-4 py-2 text-[13.5px] font-semibold text-bg-base transition-[filter] hover:brightness-[1.06] disabled:opacity-60"
        >
          {mutation.isPending && <Loader2 size={15} className="animate-spin" />}
          Unlock month
        </button>
      </div>
    </Modal>
  );
}
