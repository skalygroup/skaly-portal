'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { AnimatePresence, motion } from 'framer-motion';
import { Calendar, FileText, Loader2, Mail, Phone } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { SignupRequestStatus } from '@/lib/get-signup-requests';
import type { Role, SignupRequestAdminItem } from '@skaly/shared/schemas/auth';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const TABS: { value: SignupRequestStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  manager: 'Manager',
  team_member: 'Team member',
  freelancer: 'Freelancer',
};

// Admin may assign ANY role on approval — including admin (APPFLOW §2.7).
const ASSIGN_ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'team_member', label: 'Team member' },
  { value: 'manager', label: 'Manager' },
  { value: 'freelancer', label: 'Freelancer' },
  { value: 'admin', label: 'Admin' },
];

const queryKey = (status: SignupRequestStatus) => ['signup-requests', status] as const;

export function SignupRequestsClient({
  status,
  initialData,
}: {
  status: SignupRequestStatus;
  initialData: SignupRequestAdminItem[];
}) {
  const qc = useQueryClient();
  const [approving, setApproving] = useState<SignupRequestAdminItem | null>(null);
  const [rejecting, setRejecting] = useState<SignupRequestAdminItem | null>(null);

  const { data = [], isLoading } = useQuery({
    queryKey: queryKey(status),
    queryFn: () =>
      api<SignupRequestAdminItem[]>(`/v1/settings/signup-requests?status=${status}`),
    initialData,
    staleTime: 30_000,
  });

  // Drop a row from the current tab's cache so its card animates out after a
  // successful review (it no longer belongs in the pending list).
  function removeFromList(id: string) {
    qc.setQueryData<SignupRequestAdminItem[]>(queryKey(status), (old) =>
      (old ?? []).filter((r) => r.id !== id),
    );
  }

  async function viewCv(id: string) {
    try {
      const { url } = await api<{ url: string }>(`/v1/auth/signup-requests/${id}/cv`);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      toast.error('Could not open the CV. Try again.');
    }
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-bold text-text-primary">
          Signup Requests
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Review and action people requesting access to the portal.
        </p>
      </header>

      {/* Tab strip — switches the ?status= query param */}
      <div className="mb-6 inline-flex rounded-lg border border-border-subtle bg-bg-surface p-1">
        {TABS.map((tab) => (
          <Link
            key={tab.value}
            href={`/settings/signup-requests?status=${tab.value}`}
            aria-current={status === tab.value ? 'page' : undefined}
            className={cn(
              'rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
              status === tab.value
                ? 'bg-[var(--accent-gold-dim)] text-accent-gold'
                : 'text-text-muted hover:text-text-primary',
            )}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-16 text-text-muted">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">Loading requests…</span>
        </div>
      ) : data.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-default bg-bg-surface px-6 py-16 text-center">
          <p className="text-sm text-text-muted">No {status} requests right now.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <AnimatePresence mode="popLayout">
            {data.map((req) => (
              <motion.div
                key={req.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.2 } }}
              >
                <RequestCard
                  req={req}
                  status={status}
                  onViewCv={() => viewCv(req.id)}
                  onApprove={() => setApproving(req)}
                  onReject={() => setRejecting(req)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {approving && (
        <ApproveModal
          req={approving}
          onClose={() => setApproving(null)}
          onApproved={(name) => {
            removeFromList(approving.id);
            setApproving(null);
            toast.success(`Approved. ${name} has been notified.`);
          }}
        />
      )}
      {rejecting && (
        <RejectModal
          req={rejecting}
          onClose={() => setRejecting(null)}
          onRejected={(name) => {
            removeFromList(rejecting.id);
            setRejecting(null);
            toast.success(`Rejected. ${name} has been notified.`);
          }}
        />
      )}
    </div>
  );
}

// ─── Card ──────────────────────────────────────────────────────────────────

function RequestCard({
  req,
  status,
  onViewCv,
  onApprove,
  onReject,
}: {
  req: SignupRequestAdminItem;
  status: SignupRequestStatus;
  onViewCv: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const submitted = req.createdAt
    ? formatDistanceToNow(new Date(req.createdAt), { addSuffix: true })
    : '—';

  return (
    <article className="rounded-xl border border-border-subtle bg-bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h3 className="truncate text-[15px] font-semibold text-text-primary">{req.name}</h3>
            <span className="shrink-0 rounded-full border border-accent-gold/30 bg-[var(--accent-gold-dim)] px-2 py-0.5 text-[11px] font-medium text-accent-gold">
              {ROLE_LABELS[req.roleRequested]}
            </span>
          </div>
          <p className="mt-0.5 text-[12px] text-text-muted">Submitted {submitted}</p>
        </div>
        {status === 'pending' && (
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={onReject}
              className="rounded-md border border-border-default bg-bg-elevated px-3.5 py-1.5 text-[13px] font-semibold text-text-secondary transition-colors hover:border-status-red/60 hover:text-status-red"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={onApprove}
              className="rounded-md bg-accent-gold px-3.5 py-1.5 text-[13px] font-semibold text-bg-base transition-[filter] hover:brightness-[1.06]"
            >
              Approve
            </button>
          </div>
        )}
        {status !== 'pending' && (
          <span
            className={cn(
              'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
              status === 'approved'
                ? 'bg-status-green/10 text-status-green'
                : 'bg-status-red/10 text-status-red',
            )}
          >
            {status === 'approved' ? 'Approved' : 'Rejected'}
          </span>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        <Detail icon={<Mail size={14} />} value={req.email} />
        <Detail icon={<Phone size={14} />} value={req.mobileNumber} />
        <Detail icon={<Calendar size={14} />} value={req.dateOfBirth ?? '—'} />
      </dl>

      {req.message && (
        <p className="mt-4 rounded-lg border border-border-subtle bg-bg-base/40 px-3.5 py-2.5 text-[13px] leading-relaxed text-text-secondary">
          {req.message}
        </p>
      )}

      {/* Rejected cards expose the admin's own internal note (never the applicant's). */}
      {status === 'rejected' && (req.rejectionNote || req.publicRejectionMessage) && (
        <div className="mt-3 flex flex-col gap-2 text-[12.5px]">
          {req.rejectionNote && (
            <p className="text-text-muted">
              <span className="font-semibold text-text-secondary">Internal note:</span>{' '}
              {req.rejectionNote}
            </p>
          )}
          {req.publicRejectionMessage && (
            <p className="text-text-muted">
              <span className="font-semibold text-text-secondary">Message to user:</span>{' '}
              {req.publicRejectionMessage}
            </p>
          )}
        </div>
      )}

      {req.cvFileKey && (
        <button
          type="button"
          onClick={onViewCv}
          className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-semibold text-accent-gold transition-colors hover:text-accent-gold-hover"
        >
          <FileText size={14} />
          View CV →
        </button>
      )}
    </article>
  );
}

function Detail({ icon, value }: { icon: React.ReactNode; value: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-text-secondary">
      <span className="shrink-0 text-text-muted">{icon}</span>
      <span className="truncate">{value}</span>
    </div>
  );
}

// ─── Modals ──────────────────────────────────────────────────────────────────

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
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
        className="w-full max-w-md rounded-2xl border border-border-subtle bg-bg-surface p-6 shadow-[0_30px_70px_-30px_rgba(0,0,0,0.85)]"
      >
        <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-text-primary">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

function ApproveModal({
  req,
  onClose,
  onApproved,
}: {
  req: SignupRequestAdminItem;
  onClose: () => void;
  onApproved: (name: string) => void;
}) {
  const [role, setRole] = useState<Role>(req.roleRequested);

  const mutation = useMutation({
    mutationFn: () =>
      api(`/v1/auth/signup-requests/${req.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ roleAssigned: role }),
      }),
    onSuccess: () => onApproved(req.name),
    onError: () => toast.error('Could not approve. Try again.'),
  });

  return (
    <Modal title={`Approve ${req.name}`} onClose={onClose}>
      <p className="mt-1.5 text-[13.5px] text-text-secondary">
        Choose the role to assign. They&apos;ll be emailed a link to set their password.
      </p>

      <label className="mt-5 block text-[13px] font-semibold text-text-primary" htmlFor="assign-role">
        Assign role
      </label>
      <select
        id="assign-role"
        value={role}
        onChange={(e) => setRole(e.target.value as Role)}
        disabled={mutation.isPending}
        style={{ colorScheme: 'dark' }}
        className="mt-1.5 h-11 w-full rounded-md border border-border-default bg-bg-elevated px-3 text-sm text-text-primary outline-none focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)]"
      >
        {ASSIGN_ROLE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
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
          disabled={mutation.isPending}
          className="inline-flex items-center gap-2 rounded-md bg-accent-gold px-4 py-2 text-[13.5px] font-semibold text-bg-base transition-[filter] hover:brightness-[1.06] disabled:opacity-60"
        >
          {mutation.isPending && <Loader2 size={15} className="animate-spin" />}
          Confirm approval
        </button>
      </div>
    </Modal>
  );
}

function RejectModal({
  req,
  onClose,
  onRejected,
}: {
  req: SignupRequestAdminItem;
  onClose: () => void;
  onRejected: (name: string) => void;
}) {
  const [note, setNote] = useState('');
  const [publicMessage, setPublicMessage] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      api(`/v1/auth/signup-requests/${req.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({
          rejectionNote: note.trim(),
          publicRejectionMessage: publicMessage.trim() || undefined,
        }),
      }),
    onSuccess: () => onRejected(req.name),
    onError: () => toast.error('Could not reject. Try again.'),
  });

  const canSubmit = note.trim().length > 0 && !mutation.isPending;

  return (
    <Modal title={`Reject ${req.name}`} onClose={onClose}>
      <label className="mt-4 block text-[13px] font-semibold text-text-primary" htmlFor="reject-note">
        Internal note <span className="text-text-muted">(only you see this — required)</span>
      </label>
      <textarea
        id="reject-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        maxLength={2000}
        disabled={mutation.isPending}
        placeholder="Why is this request being rejected?"
        className="mt-1.5 w-full resize-y rounded-md border border-border-default bg-bg-elevated px-3 py-2.5 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)]"
      />

      <label
        className="mt-4 block text-[13px] font-semibold text-text-primary"
        htmlFor="reject-public"
      >
        Message to user <span className="text-text-muted">(optional)</span>
      </label>
      <textarea
        id="reject-public"
        value={publicMessage}
        onChange={(e) => setPublicMessage(e.target.value)}
        rows={2}
        maxLength={300}
        disabled={mutation.isPending}
        placeholder="Shown to the applicant. Leave blank for none."
        className="mt-1.5 w-full resize-y rounded-md border border-border-default bg-bg-elevated px-3 py-2.5 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)]"
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
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 rounded-md bg-status-red px-4 py-2 text-[13.5px] font-semibold text-white transition-[filter] hover:brightness-[1.06] disabled:opacity-50"
        >
          {mutation.isPending && <Loader2 size={15} className="animate-spin" />}
          Confirm rejection
        </button>
      </div>
    </Modal>
  );
}
