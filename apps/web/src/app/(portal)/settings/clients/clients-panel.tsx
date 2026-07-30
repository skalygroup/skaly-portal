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
  StatusPill,
  Td,
  Th,
} from '@/components/settings/panel-chrome';
import { api, ApiError } from '@/lib/api';

interface ClientRow {
  id: string;
  name: string;
  isInternal: boolean;
  active: boolean;
  shootSlotsPerMonth: number;
  piecesPerVisit: number;
  whatsappNumber: string | null;
  createdAt: string;
}

const queryKey = (includeInactive: boolean) => ['settings', 'clients', includeInactive] as const;

type Pending =
  | { kind: 'deactivate'; row: ClientRow }
  | { kind: 'reactivate'; row: ClientRow }
  | null;

export function ClientsPanel({ canWrite, isAdmin }: { canWrite: boolean; isAdmin: boolean }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<Pending>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ClientRow | null>(null);

  // Only an admin may pass includeInactive — the endpoint 403s otherwise, so a
  // manager must not ask for it. This is the panel/lookup split in one line.
  const { data = [], isLoading } = useQuery({
    queryKey: queryKey(isAdmin),
    queryFn: async () =>
      (
        await api<{ data: ClientRow[] }>(
          isAdmin ? '/v1/clients?includeInactive=true' : '/v1/clients',
        )
      ).data,
    staleTime: 30_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['settings', 'clients'] });

  const lifecycle = useMutation({
    mutationFn: async (p: NonNullable<Pending>) =>
      p.kind === 'deactivate'
        ? api(`/v1/clients/${p.row.id}`, { method: 'DELETE' })
        : api(`/v1/clients/${p.row.id}/reactivate`, { method: 'PUT' }),
    onSuccess: (_r, p) => {
      void invalidate();
      setPending(null);
      toast.success(
        p.kind === 'deactivate' ? `${p.row.name} deactivated.` : `${p.row.name} is active again.`,
      );
    },
    onError: () => toast.error('That didn’t work. Try again.'),
  });

  return (
    <div>
      <PanelHeader
        title="Clients"
        description="The accounts every module is scoped to."
        action={
          canWrite ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent-gold px-3.5 py-2 text-[13px] font-semibold text-bg-base transition-[filter] hover:brightness-[1.06]"
            >
              <Plus size={15} />
              New client
            </button>
          ) : undefined
        }
      />

      <PanelTable
        loading={isLoading}
        empty={data.length === 0}
        head={
          <>
            <Th>Name</Th>
            <Th>Shoot slots / month</Th>
            <Th>Pieces / visit</Th>
            <Th>Status</Th>
            {canWrite && <Th className="text-right">Actions</Th>}
          </>
        }
      >
        {data.map((row) => (
          <tr key={row.id} className="border-b border-border-subtle last:border-0">
            <Td className="font-medium text-text-primary">
              {row.name}
              {row.isInternal && (
                <span className="ml-2 rounded-full border border-border-default px-2 py-0.5 text-[10.5px] text-text-muted">
                  Internal
                </span>
              )}
            </Td>
            <Td>{row.shootSlotsPerMonth}</Td>
            <Td>{row.piecesPerVisit}</Td>
            <Td>
              <StatusPill active={row.active} />
            </Td>
            {canWrite && (
              <Td className="text-right">
                <div className="flex justify-end gap-2">
                  <RowAction onClick={() => setEditing(row)}>Edit</RowAction>
                  {row.active ? (
                    // Deactivate is admin-only on the API; hide rather than let
                    // a manager click into a 403.
                    isAdmin && (
                      <RowAction
                        tone="danger"
                        onClick={() => setPending({ kind: 'deactivate', row })}
                      >
                        Deactivate
                      </RowAction>
                    )
                  ) : (
                    isAdmin && (
                      <RowAction onClick={() => setPending({ kind: 'reactivate', row })}>
                        Reactivate
                      </RowAction>
                    )
                  )}
                </div>
              </Td>
            )}
          </tr>
        ))}
      </PanelTable>

      {pending?.kind === 'deactivate' && (
        <ConfirmDialog
          title={`Deactivate ${pending.row.name}?`}
          consequence={
            <>
              They disappear from every module&apos;s client filter and no new work can be logged
              against them.{' '}
              <strong className="font-semibold text-text-primary">
                Nothing already recorded is deleted
              </strong>{' '}
              — past shoots, tasks and calendar entries stay intact, and you can reactivate them
              later.
            </>
          }
          confirmLabel="Deactivate"
          pending={lifecycle.isPending}
          onConfirm={() => lifecycle.mutate(pending)}
          onCancel={() => setPending(null)}
        />
      )}

      {pending?.kind === 'reactivate' && (
        <ConfirmDialog
          title={`Reactivate ${pending.row.name}?`}
          consequence={
            <>
              They return to every client filter, and{' '}
              <strong className="font-semibold text-text-primary">
                this month&apos;s shoot, pipeline and calendar rows are regenerated
              </strong>{' '}
              so the modules have somewhere to put new work. Earlier periods are left as they are.
            </>
          }
          confirmLabel="Reactivate"
          destructive={false}
          pending={lifecycle.isPending}
          onConfirm={() => lifecycle.mutate(pending)}
          onCancel={() => setPending(null)}
        />
      )}

      {creating && <CreateClientModal onClose={() => setCreating(false)} onSaved={invalidate} />}
      {editing && (
        <EditClientModal
          row={editing}
          isAdmin={isAdmin}
          onClose={() => setEditing(null)}
          onSaved={invalidate}
        />
      )}
    </div>
  );
}

// ─── Create ──────────────────────────────────────────────────────────────────

function CreateClientModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  // Empty string, not 0 or 4: the column has no DEFAULT by design (migration
  // 005), so there is no sane value to pre-fill. A pre-filled number would be
  // someone's guess wearing the authority of a default.
  const [slots, setSlots] = useState('');
  const [pieces, setPieces] = useState('1');
  const [fieldError, setFieldError] = useState<{ field: 'name' | 'slots'; message: string } | null>(
    null,
  );

  const mutation = useMutation({
    mutationFn: () =>
      api('/v1/clients', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          shootSlotsPerMonth: Number(slots),
          piecesPerVisit: Number(pieces) || 1,
        }),
      }),
    onSuccess: () => {
      onSaved();
      onClose();
      toast.success(`${name.trim()} added.`);
    },
    onError: (err) => {
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      // CLIENT_SHOOT_SLOTS_REQUIRED belongs on the field that caused it, not in
      // a toast that vanishes while the user is still looking at the form.
      if (code === 'CLIENT_SHOOT_SLOTS_REQUIRED' || code === 'VALIDATION_ERROR') {
        setFieldError({
          field: 'slots',
          message: 'Enter how many shoot slots this client gets each month (1–20).',
        });
        return;
      }
      toast.error('Could not create the client. Try again.');
    },
  });

  return (
    <Modal title="New client" onClose={onClose}>
      <label className="mt-5 block text-[13px] font-semibold text-text-primary" htmlFor="client-name">
        Name
      </label>
      <input
        id="client-name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setFieldError(null);
        }}
        disabled={mutation.isPending}
        maxLength={120}
        className="mt-1.5 h-11 w-full rounded-md border border-border-default bg-bg-elevated px-3 text-sm text-text-primary outline-none focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)]"
      />

      <label
        className="mt-4 block text-[13px] font-semibold text-text-primary"
        htmlFor="client-slots"
      >
        Shoot slots per month <span className="text-text-muted">(required, 1–20)</span>
      </label>
      <input
        id="client-slots"
        type="number"
        min={1}
        max={20}
        value={slots}
        onChange={(e) => {
          setSlots(e.target.value);
          setFieldError(null);
        }}
        disabled={mutation.isPending}
        aria-invalid={fieldError?.field === 'slots'}
        aria-describedby={fieldError?.field === 'slots' ? 'client-slots-error' : undefined}
        className="mt-1.5 h-11 w-full rounded-md border border-border-default bg-bg-elevated px-3 text-sm text-text-primary outline-none focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)] aria-[invalid=true]:border-status-red"
      />
      {fieldError?.field === 'slots' && (
        <p id="client-slots-error" role="alert" className="mt-1.5 text-[12.5px] text-status-red">
          {fieldError.message}
        </p>
      )}

      <label
        className="mt-4 block text-[13px] font-semibold text-text-primary"
        htmlFor="client-pieces"
      >
        Pieces per visit
      </label>
      <input
        id="client-pieces"
        type="number"
        min={1}
        value={pieces}
        onChange={(e) => setPieces(e.target.value)}
        disabled={mutation.isPending}
        className="mt-1.5 h-11 w-full rounded-md border border-border-default bg-bg-elevated px-3 text-sm text-text-primary outline-none focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)]"
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
          disabled={!name.trim() || mutation.isPending}
          className="inline-flex items-center gap-2 rounded-md bg-accent-gold px-4 py-2 text-[13.5px] font-semibold text-bg-base transition-[filter] hover:brightness-[1.06] disabled:opacity-60"
        >
          {mutation.isPending && <Loader2 size={15} className="animate-spin" />}
          Create client
        </button>
      </div>
    </Modal>
  );
}

// ─── Edit ────────────────────────────────────────────────────────────────────

/**
 * Name and slot count are TWO endpoints, deliberately: the rename is a
 * last-write-wins string, while the slot count adds or removes shoot rows for
 * the current period through `ShootPlannerService.adjustSlotCount`. Only the
 * fields you actually changed are sent, so editing a name never rebuilds a
 * client's shoot slots as a side effect.
 */
function EditClientModal({
  row,
  isAdmin,
  onClose,
  onSaved,
}: {
  row: ClientRow;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(row.name);
  const [slots, setSlots] = useState(String(row.shootSlotsPerMonth));

  const nameChanged = name.trim() !== row.name && name.trim().length > 0;
  const slotsChanged = Number(slots) !== row.shootSlotsPerMonth && Number(slots) >= 1;

  const mutation = useMutation({
    mutationFn: async () => {
      if (nameChanged) {
        await api(`/v1/clients/${row.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: name.trim() }),
        });
      }
      if (slotsChanged) {
        await api(`/v1/clients/${row.id}/shoot-slots`, {
          method: 'PATCH',
          body: JSON.stringify({ slotsPerMonth: Number(slots) }),
        });
      }
    },
    onSuccess: () => {
      onSaved();
      onClose();
      toast.success('Client updated.');
    },
    onError: () => toast.error('Could not save those changes. Try again.'),
  });

  return (
    <Modal title={`Edit ${row.name}`} onClose={onClose}>
      <label className="mt-5 block text-[13px] font-semibold text-text-primary" htmlFor="edit-name">
        Name
      </label>
      <input
        id="edit-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={mutation.isPending}
        maxLength={120}
        className="mt-1.5 h-11 w-full rounded-md border border-border-default bg-bg-elevated px-3 text-sm text-text-primary outline-none focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)]"
      />

      {/* Slot adjustment is admin-only on the API (shoot-planner routes), so a
          manager sees the value and cannot change it. */}
      <label className="mt-4 block text-[13px] font-semibold text-text-primary" htmlFor="edit-slots">
        Shoot slots per month{' '}
        {!isAdmin && <span className="text-text-muted">(admins only)</span>}
      </label>
      <input
        id="edit-slots"
        type="number"
        min={1}
        max={20}
        value={slots}
        onChange={(e) => setSlots(e.target.value)}
        disabled={mutation.isPending || !isAdmin}
        className="mt-1.5 h-11 w-full rounded-md border border-border-default bg-bg-elevated px-3 text-sm text-text-primary outline-none focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)] disabled:opacity-60"
      />
      {isAdmin && slotsChanged && (
        <p className="mt-1.5 text-[12.5px] text-text-muted">
          {Number(slots) > row.shootSlotsPerMonth
            ? 'Extra shoot rows will be added to the current period.'
            : 'Unused shoot rows will be removed from the current period.'}
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
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={(!nameChanged && !slotsChanged) || mutation.isPending}
          className="inline-flex items-center gap-2 rounded-md bg-accent-gold px-4 py-2 text-[13.5px] font-semibold text-bg-base transition-[filter] hover:brightness-[1.06] disabled:opacity-60"
        >
          {mutation.isPending && <Loader2 size={15} className="animate-spin" />}
          Save changes
        </button>
      </div>
    </Modal>
  );
}
