'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Loader2, ShieldCheck, ShieldOff, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { Role } from '@skaly/shared/schemas/auth';

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

/** GET /v1/settings/staff. The three optional fields are ADMIN-only — the API
 *  OMITS them for a manager rather than nulling them, so `in` is the right test
 *  and `=== null` would be a lie about a manager's view. */
interface StaffRow {
  id: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  active: boolean;
  joinedAt: string;
  email?: string;
  mfaEnrolled?: boolean;
  deactivatedAt?: string | null;
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  manager: 'Manager',
  team_member: 'Team member',
  freelancer: 'Freelancer',
};

const INVITE_ROLES: Role[] = ['team_member', 'manager', 'freelancer', 'admin'];

const QUERY_KEY = ['settings', 'staff'] as const;

type Pending =
  | { kind: 'deactivate'; row: StaffRow }
  | { kind: 'reactivate'; row: StaffRow }
  | { kind: 'reset-mfa'; row: StaffRow }
  | null;

export function StaffPanel({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<Pending>(null);
  const [inviting, setInviting] = useState(false);
  const [showFormer, setShowFormer] = useState(false);

  const { data = [], isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => (await api<{ data: StaffRow[] }>('/v1/settings/staff')).data,
    staleTime: 30_000,
  });

  const action = useMutation({
    mutationFn: async (p: NonNullable<Pending>) => {
      const path =
        p.kind === 'deactivate'
          ? `/v1/staff/${p.row.id}/deactivate`
          : p.kind === 'reactivate'
            ? `/v1/staff/${p.row.id}/reactivate`
            : `/v1/staff/${p.row.id}/mfa/reset`;
      await api(path, { method: 'PUT' });
    },
    onSuccess: (_r, p) => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      setPending(null);
      toast.success(
        p.kind === 'deactivate'
          ? `${p.row.name} has been deactivated and signed out.`
          : p.kind === 'reactivate'
            ? `${p.row.name} is active again.`
            : `${p.row.name} will re-enrol MFA on their next login.`,
      );
    },
    onError: (err) => {
      // A live-email collision on reinstate is a business answer, not a crash —
      // it is the one 409 this panel can produce (ADR-026).
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      toast.error(
        code === 'ALREADY_PROCESSED'
          ? 'Someone else already holds that email address. Resolve the duplicate first.'
          : 'That didn’t work. Try again.',
      );
    },
  });

  // Soft-deleted rows are only present for an admin (the API omits them for a
  // manager), so this split is empty rather than wrong on a manager's screen.
  const current = data.filter((r) => r.active);
  const former = data.filter((r) => !r.active);

  return (
    <div>
      <PanelHeader
        title="Staff"
        description="Everyone with portal access, and the people who used to have it."
        action={
          canWrite ? (
            <button
              type="button"
              onClick={() => setInviting(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent-gold px-3.5 py-2 text-[13px] font-semibold text-bg-base transition-[filter] hover:brightness-[1.06]"
            >
              <UserPlus size={15} />
              Invite
            </button>
          ) : undefined
        }
      />

      <PanelTable
        loading={isLoading}
        empty={current.length === 0}
        head={
          <>
            <Th>Name</Th>
            {/* Email and MFA are admin-only columns; a manager gets no empty
                cells, because the API sent no field to render.

                ⚠️ The rule this is REALLY expressing is "render the header iff
                the payload carried that field". `canWrite` is an exact proxy
                only because admin is currently the sole role the API sends
                email/mfaEnrolled to. If an override ever decouples
                field-inclusion from write access — a manager granted
                settings_staff.write while the API still omits email — this
                gates the wrong way and produces the column of em-dashes it
                exists to prevent. The durable form is `'email' in row`; switch
                to it the moment those two stop coinciding. */}
            {canWrite && <Th>Email</Th>}
            <Th>Role</Th>
            {canWrite && <Th>MFA</Th>}
            <Th>Status</Th>
            {canWrite && <Th className="text-right">Actions</Th>}
          </>
        }
      >
        {current.map((row) => (
          <tr key={row.id} className="border-b border-border-subtle last:border-0">
            <Td className="font-medium text-text-primary">{row.name}</Td>
            {canWrite && <Td>{row.email ?? '—'}</Td>}
            <Td>{ROLE_LABELS[row.role] ?? row.role}</Td>
            {canWrite && (
              <Td>
                {row.mfaEnrolled ? (
                  <span className="inline-flex items-center gap-1.5 text-status-green">
                    <ShieldCheck size={14} /> Enrolled
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-text-muted">
                    <ShieldOff size={14} /> Not set up
                  </span>
                )}
              </Td>
            )}
            <Td>
              <StatusPill active={row.active} />
            </Td>
            {canWrite && (
              <Td className="text-right">
                <div className="flex justify-end gap-2">
                  <RowAction onClick={() => setPending({ kind: 'reset-mfa', row })}>
                    Reset MFA
                  </RowAction>
                  <RowAction tone="danger" onClick={() => setPending({ kind: 'deactivate', row })}>
                    Deactivate
                  </RowAction>
                </div>
              </Td>
            )}
          </tr>
        ))}
      </PanelTable>

      {/* ── Former staff ──────────────────────────────────────────────────
          Collapsed, because it is a small list you consult rather than read.
          This section is the SURFACE that makes A4's fix reachable: without a
          [Reinstate] button somewhere, the re-onboarding path built in STEP 3
          exists only in tests. */}
      {canWrite && former.length > 0 && (
        <section className="mt-8">
          <button
            type="button"
            onClick={() => setShowFormer((s) => !s)}
            aria-expanded={showFormer}
            className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-semibold text-text-secondary transition-colors hover:text-text-primary"
          >
            <ChevronDown
              size={15}
              className={showFormer ? 'transition-transform' : '-rotate-90 transition-transform'}
            />
            Former staff ({former.length})
          </button>

          {showFormer && (
            <PanelTable
              head={
                <>
                  <Th>Name</Th>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Deactivated</Th>
                  <Th className="text-right">Actions</Th>
                </>
              }
            >
              {former.map((row) => (
                <tr key={row.id} className="border-b border-border-subtle last:border-0">
                  <Td className="font-medium text-text-primary">{row.name}</Td>
                  <Td>{row.email ?? '—'}</Td>
                  <Td>{ROLE_LABELS[row.role] ?? row.role}</Td>
                  <Td>{row.deactivatedAt ? row.deactivatedAt.slice(0, 10) : '—'}</Td>
                  <Td className="text-right">
                    <RowAction onClick={() => setPending({ kind: 'reactivate', row })}>
                      Reinstate
                    </RowAction>
                  </Td>
                </tr>
              ))}
            </PanelTable>
          )}
        </section>
      )}

      {pending?.kind === 'deactivate' && (
        <ConfirmDialog
          title={`Deactivate ${pending.row.name}?`}
          consequence={
            <>
              They will be <strong className="font-semibold text-text-primary">signed out
              immediately</strong> and won&apos;t be able to log back in. Their tasks, attendance
              and history stay exactly as they are, and you can reinstate them later from Former
              staff.
            </>
          }
          confirmLabel="Deactivate"
          pending={action.isPending}
          onConfirm={() => action.mutate(pending)}
          onCancel={() => setPending(null)}
        />
      )}

      {pending?.kind === 'reset-mfa' && (
        <ConfirmDialog
          title={`Reset MFA for ${pending.row.name}?`}
          consequence={
            <>
              Their authenticator is removed and{' '}
              <strong className="font-semibold text-text-primary">
                they will re-enrol on their next login
              </strong>
              . Their existing recovery codes are destroyed too, so make sure they can reach the
              portal to set up a new authenticator.
            </>
          }
          confirmLabel="Reset MFA"
          pending={action.isPending}
          onConfirm={() => action.mutate(pending)}
          onCancel={() => setPending(null)}
        />
      )}

      {pending?.kind === 'reactivate' && (
        <ConfirmDialog
          title={`Reinstate ${pending.row.name}?`}
          consequence={
            <>
              Their original account comes back with{' '}
              <strong className="font-semibold text-text-primary">all of their history intact</strong>
              , and they keep the same record rather than starting fresh. They&apos;ll be able to
              log in again straight away.
            </>
          }
          confirmLabel="Reinstate"
          destructive={false}
          pending={action.isPending}
          onConfirm={() => action.mutate(pending)}
          onCancel={() => setPending(null)}
        />
      )}

      {inviting && <InviteModal onClose={() => setInviting(false)} />}
    </div>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('team_member');

  const mutation = useMutation({
    mutationFn: () =>
      api('/v1/auth/invite', { method: 'POST', body: JSON.stringify({ email: email.trim(), role }) }),
    onSuccess: () => {
      toast.success(`Invite sent to ${email.trim()}.`);
      onClose();
    },
    onError: (err) => {
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      toast.error(
        code === 'ALREADY_PROCESSED'
          ? 'Someone already has an account with that email.'
          : 'Could not send the invite. Try again.',
      );
    },
  });

  return (
    <Modal title="Invite someone" onClose={onClose}>
      <p className="mt-1.5 text-[13.5px] text-text-secondary">
        They&apos;ll get an email with a link to set their password and join the portal.
      </p>

      <label className="mt-5 block text-[13px] font-semibold text-text-primary" htmlFor="invite-email">
        Email
      </label>
      <input
        id="invite-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={mutation.isPending}
        placeholder="name@skaly.in"
        className="mt-1.5 h-11 w-full rounded-md border border-border-default bg-bg-elevated px-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)]"
      />

      <label className="mt-4 block text-[13px] font-semibold text-text-primary" htmlFor="invite-role">
        Role
      </label>
      <select
        id="invite-role"
        value={role}
        onChange={(e) => setRole(e.target.value as Role)}
        disabled={mutation.isPending}
        style={{ colorScheme: 'dark' }}
        className="mt-1.5 h-11 w-full rounded-md border border-border-default bg-bg-elevated px-3 text-sm text-text-primary outline-none focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)]"
      >
        {INVITE_ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </select>

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
          disabled={!email.trim() || mutation.isPending}
          className="inline-flex items-center gap-2 rounded-md bg-accent-gold px-4 py-2 text-[13.5px] font-semibold text-bg-base transition-[filter] hover:brightness-[1.06] disabled:opacity-60"
        >
          {mutation.isPending && <Loader2 size={15} className="animate-spin" />}
          Send invite
        </button>
      </div>
    </Modal>
  );
}
