'use client';

import { TaskCreateSchema, TASK_PRIORITY_VALUES } from '@skaly/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { SlidePanel } from './slide-panel';

import type { Task } from './types';

import { api } from '@/lib/api';
import { handleMutationError } from '@/lib/mutation-errors';

interface ClientItem { id: string; name: string }
interface StaffItem { id: string; name: string; role: string }

const labelCls = 'mb-1 block text-xs font-semibold uppercase tracking-wide';
const fieldStyle = {
  background: 'var(--bg-base)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
} as const;

/**
 * Slide-in create form (APPFLOW §5). Validates the assembled payload with the
 * shared TaskCreateSchema before POSTing, so the client mirrors the exact server
 * contract. On success invalidates ['tasks', period] and closes.
 */
export function TaskCreatePanel({
  open,
  onClose,
  period,
  defaultDate,
  tasks,
}: {
  open: boolean;
  onClose: () => void;
  period: string;
  defaultDate: string;
  tasks: Task[];
}) {
  const queryClient = useQueryClient();

  const { data: clients = [] } = useQuery({
    queryKey: ['clients'],
    queryFn: async () => (await api<{ data: ClientItem[] }>('/v1/clients')).data,
    staleTime: 5 * 60_000,
    enabled: open,
  });
  const { data: staff = [] } = useQuery({
    queryKey: ['staff'],
    queryFn: async () => (await api<{ data: StaffItem[] }>('/v1/staff')).data,
    staleTime: 5 * 60_000,
    enabled: open,
  });

  const [date, setDate] = useState(defaultDate);
  const [description, setDescription] = useState('');
  const [clientId, setClientId] = useState('');
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [priority, setPriority] = useState('');
  const [dependencyId, setDependencyId] = useState('');
  const [deadline, setDeadline] = useState('');
  const [remark, setRemark] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  function reset() {
    setDate(defaultDate);
    setDescription('');
    setClientId('');
    setAssigneeIds([]);
    setPriority('');
    setDependencyId('');
    setDeadline('');
    setRemark('');
    setErrors({});
  }

  const createMutation = useMutation({
    mutationFn: async (body: unknown) =>
      (await api<{ data: Task }>('/v1/tasks', { method: 'POST', body: JSON.stringify(body) })).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', period] });
      toast.success('Task created.');
      reset();
      onClose();
    },
    onError: (err) => handleMutationError(err),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      period,
      date,
      description,
      assigneeIds,
      ...(clientId ? { clientId } : {}),
      ...(priority ? { priority } : {}),
      ...(dependencyId ? { dependencyId } : {}),
      ...(deadline ? { deadline } : {}),
      ...(remark ? { remark } : {}),
    };
    const parsed = TaskCreateSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        fieldErrors[key] ??= issue.message;
      }
      setErrors(fieldErrors);
      return;
    }
    setErrors({});
    createMutation.mutate(parsed.data);
  }

  function toggleAssignee(id: string) {
    setAssigneeIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  // Period bounds for the native date inputs (YYYY-MM-01 … end of month).
  const monthStart = `${period}-01`;
  const monthEnd = `${period}-${new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0).getDate()}`;

  return (
    <SlidePanel open={open} onClose={onClose} title="New task">
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field label="Date" error={errors.date}>
          <input
            type="date"
            value={date}
            min={monthStart}
            max={monthEnd}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded px-3 py-2 text-sm"
            style={fieldStyle}
          />
        </Field>

        <Field label="Description" error={errors.description}>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What needs doing?"
            className="w-full rounded px-3 py-2 text-sm"
            style={fieldStyle}
          />
        </Field>

        <Field label="Client" error={errors.clientId}>
          <select data-testid="create-client" value={clientId} onChange={(e) => setClientId(e.target.value)} className="w-full rounded px-3 py-2 text-sm" style={fieldStyle}>
            <option value="">— None —</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Assignees" error={errors.assigneeIds}>
          <div className="flex flex-wrap gap-2">
            {staff.map((s) => {
              const on = assigneeIds.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleAssignee(s.id)}
                  aria-pressed={on}
                  className="rounded-full px-3 py-1 text-xs font-medium"
                  style={{
                    background: on ? 'var(--accent-gold-dim)' : 'var(--bg-base)',
                    color: on ? 'var(--accent-gold)' : 'var(--text-secondary)',
                    border: `1px solid ${on ? 'var(--accent-gold-border)' : 'var(--border-default)'}`,
                  }}
                >
                  {s.name}
                </button>
              );
            })}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Priority" error={errors.priority}>
            <select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full rounded px-3 py-2 text-sm" style={fieldStyle}>
              <option value="">— None —</option>
              {TASK_PRIORITY_VALUES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Deadline" error={errors.deadline}>
            <input data-testid="create-deadline" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} className="w-full rounded px-3 py-2 text-sm" style={fieldStyle} />
          </Field>
        </div>

        <Field label="Dependency" error={errors.dependencyId}>
          <select value={dependencyId} onChange={(e) => setDependencyId(e.target.value)} className="w-full rounded px-3 py-2 text-sm" style={fieldStyle}>
            <option value="">— None —</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.description}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Remark" error={errors.remark}>
          <textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={2} className="w-full rounded px-3 py-2 text-sm" style={fieldStyle} />
        </Field>

        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
            style={{ background: 'var(--accent-gold)', color: 'var(--bg-base)' }}
          >
            {createMutation.isPending ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </form>
    </SlidePanel>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <span className={labelCls} style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      {children}
      {error ? (
        <p className="mt-1 text-xs" style={{ color: 'var(--status-red)' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
