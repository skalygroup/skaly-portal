'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus } from 'lucide-react';
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
import { useMonthContext } from '@/lib/hooks/use-month-context';

interface HolidayRow {
  id: string;
  period: string;
  date: string;
  name: string;
}

const queryKey = (period: string) => ['settings', 'holidays', period] as const;

export function HolidaysPanel({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  // The period lives in ?period= like every other period-scoped screen (UIUX
  // §6.1) — bookmarkable, and the same value the attendance grid is looking at.
  const { period, setPeriod } = useMonthContext();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<HolidayRow | null>(null);

  const { data = [], isLoading } = useQuery({
    queryKey: queryKey(period),
    queryFn: async () =>
      (await api<{ data: HolidayRow[] }>(`/v1/holidays?period=${period}`)).data,
    staleTime: 30_000,
  });

  const remove = useMutation({
    mutationFn: (row: HolidayRow) => api(`/v1/holidays/${row.id}`, { method: 'DELETE' }),
    onSuccess: (_r, row) => {
      void qc.invalidateQueries({ queryKey: ['settings', 'holidays'] });
      setRemoving(null);
      toast.success(`${row.name} removed. That date is a working day again.`);
    },
    onError: (err) => {
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      toast.error(
        code === 'PERIOD_LOCKED'
          ? 'That month is locked. Unlock it first, then remove the holiday.'
          : 'Could not remove that holiday. Try again.',
      );
    },
  });

  return (
    <div>
      <PanelHeader
        title="Holidays"
        description="Non-working days for the period. Adding one flips that day's attendance to holiday."
        action={
          canWrite ? (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent-gold px-3.5 py-2 text-[13px] font-semibold text-bg-base transition-[filter] hover:brightness-[1.06]"
            >
              <Plus size={15} />
              Add holiday
            </button>
          ) : undefined
        }
      />

      <label className="block text-[13px] font-semibold text-text-primary" htmlFor="holiday-period">
        Period
      </label>
      <input
        id="holiday-period"
        type="month"
        value={period}
        onChange={(e) => e.target.value && setPeriod(e.target.value)}
        className="mb-6 mt-1.5 h-11 rounded-md border border-border-default bg-bg-elevated px-3 text-sm text-text-primary outline-none focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)]"
      />

      <PanelTable
        loading={isLoading}
        empty={data.length === 0}
        head={
          <>
            <Th>Date</Th>
            <Th>Name</Th>
            {canWrite && <Th className="text-right">Actions</Th>}
          </>
        }
      >
        {data.map((row) => (
          <tr key={row.id} className="border-b border-border-subtle last:border-0">
            <Td className="font-medium text-text-primary">{row.date}</Td>
            <Td>{row.name}</Td>
            {canWrite && (
              <Td className="text-right">
                <RowAction tone="danger" onClick={() => setRemoving(row)}>
                  Remove
                </RowAction>
              </Td>
            )}
          </tr>
        ))}
      </PanelTable>

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          consequence={
            <>
              Everyone&apos;s attendance for{' '}
              <strong className="font-semibold text-text-primary">{removing.date}</strong> reverts
              to a <strong className="font-semibold text-text-primary">working day</strong> — the
              same cascade that ran in reverse when the holiday was added. Anyone already marked
              absent or on leave for that date keeps what they were marked as; only the day type
              changes.
            </>
          }
          confirmLabel="Remove holiday"
          pending={remove.isPending}
          onConfirm={() => remove.mutate(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}

      {adding && (
        <AddHolidayModal
          period={period}
          onClose={() => setAdding(false)}
          onSaved={() => void qc.invalidateQueries({ queryKey: ['settings', 'holidays'] })}
        />
      )}
    </div>
  );
}

function AddHolidayModal({
  period,
  onClose,
  onSaved,
}: {
  period: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Pre-fill the viewed month's first day so the native picker opens where the
  // user is already looking, without asserting a date they did not choose.
  const [date, setDate] = useState(`${period}-01`);
  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api('/v1/holidays', {
        method: 'POST',
        body: JSON.stringify({
          // DERIVED from the date, never the viewed period. The service uses
          // `period` AND `date` together to flip attendance rows, so a date in
          // another month paired with the viewed period would insert the holiday
          // and silently cascade over nothing.
          period: date.slice(0, 7),
          date,
          name: name.trim(),
        }),
      }),
    onSuccess: () => {
      onSaved();
      onClose();
      toast.success(`${name.trim()} added. ${date} is now a holiday.`);
    },
    onError: (err) => {
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      if (code === 'ALREADY_PROCESSED') {
        setFieldError('That date is already a holiday.');
        return;
      }
      if (code === 'PERIOD_LOCKED') {
        setFieldError('That month is locked. Unlock it before adding holidays to it.');
        return;
      }
      toast.error('Could not add the holiday. Try again.');
    },
  });

  return (
    <Modal title="Add a holiday" onClose={onClose}>
      <p className="mt-1.5 text-[13.5px] text-text-secondary">
        Every working-day attendance row for this date becomes a holiday. Sundays are already
        non-working and are left alone.
      </p>

      <label className="mt-5 block text-[13px] font-semibold text-text-primary" htmlFor="holiday-date">
        Date
      </label>
      <input
        id="holiday-date"
        type="date"
        value={date}
        onChange={(e) => {
          setDate(e.target.value);
          setFieldError(null);
        }}
        disabled={mutation.isPending}
        aria-invalid={fieldError !== null}
        aria-describedby={fieldError ? 'holiday-date-error' : undefined}
        className="mt-1.5 h-11 w-full rounded-md border border-border-default bg-bg-elevated px-3 text-sm text-text-primary outline-none focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)] aria-[invalid=true]:border-status-red"
      />
      {fieldError && (
        <p id="holiday-date-error" role="alert" className="mt-1.5 text-[12.5px] text-status-red">
          {fieldError}
        </p>
      )}

      <label className="mt-4 block text-[13px] font-semibold text-text-primary" htmlFor="holiday-name">
        Name
      </label>
      <input
        id="holiday-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={100}
        disabled={mutation.isPending}
        placeholder="Diwali"
        className="mt-1.5 h-11 w-full rounded-md border border-border-default bg-bg-elevated px-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)]"
      />

      <div className="mt-6 flex justify-end gap-2.5">
        <button
          type="button"
          onClick={onClose}
          disabled={mutation.isPending}
          className="rounded-md border border-border-default bg-bg-elevated px-4 py-2 text-[13.5px] font-semibold text-text-secondary hover:bg-bg-hover disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={!name.trim() || !date || mutation.isPending}
          className="inline-flex items-center gap-2 rounded-md bg-accent-gold px-4 py-2 text-[13.5px] font-semibold text-bg-base transition-[filter] hover:brightness-[1.06] disabled:opacity-60"
        >
          {mutation.isPending && <Loader2 size={15} className="animate-spin" />}
          Add holiday
        </button>
      </div>
    </Modal>
  );
}
