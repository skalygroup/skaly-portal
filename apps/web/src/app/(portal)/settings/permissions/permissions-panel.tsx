'use client';

import { ROLE_DEFAULTS } from '@skaly/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { Role } from '@skaly/shared/schemas/auth';

import { PanelHeader } from '@/components/settings/panel-chrome';
import { PermissionControl, type PermissionState } from '@/components/settings/permission-control';
import { api } from '@/lib/api';

interface StaffRow {
  id: string;
  name: string;
  role: string;
  active: boolean;
}

/** GET /v1/staff/:id/permissions — the override ROWS, not the effective map. */
interface OverridesResponse {
  staffId: string;
  role: Role;
  overrides: { permissionKey: string; value: boolean }[];
}

/**
 * The three groups, derived from the key prefix — never a hand-written list of
 * keys. AUTH-MATRIX §6.2 is a naming convention precisely so that the UI can be
 * generated from it; typing the keys here would be a second registry that goes
 * stale the first time a tool is added and nobody remembers this file.
 */
const GROUPS = [
  { id: 'bot', title: 'Bot Tools', match: (k: string) => k.startsWith('bot.tool.') },
  { id: 'modules', title: 'Modules', match: (k: string) => k.startsWith('module.') },
  // Everything left over: chat.access, report.generate, months.unlock. Defined as
  // the remainder so a new family cannot fall off the screen by being unlisted.
  { id: 'features', title: 'Features', match: () => true },
] as const;

/** `module.settings_staff.read` → "Settings staff · read"; `bot.tool.list_tasks`
 *  → "List tasks". Derived, so a new key is labelled without being registered. */
function humanise(key: string): string {
  const withoutPrefix = key.replace(/^bot\.tool\.|^module\./, '');
  return withoutPrefix
    .split('.')
    .map((part) => part.replaceAll('_', ' '))
    .map((part, i) => (i === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' · ');
}

/**
 * Every key, bucketed once at module scope. First matching group wins and the
 * last group matches everything, so the buckets are exhaustive by construction —
 * a key added to ROLE_DEFAULTS appears on this screen without being registered
 * anywhere, which is the only way the panel and the resolver stay in step.
 */
const GROUPED = GROUPS.map((group, i) => ({
  ...group,
  keys: Object.keys(ROLE_DEFAULTS)
    .sort()
    .filter((k) => GROUPS.findIndex((g) => g.match(k)) === i),
})).filter((g) => g.keys.length > 0);

const overridesKey = (staffId: string) => ['settings', 'permissions', staffId] as const;

export function PermissionsPanel({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState('');

  const { data: staff = [] } = useQuery({
    queryKey: ['settings', 'staff'],
    queryFn: async () => (await api<{ data: StaffRow[] }>('/v1/settings/staff')).data,
    staleTime: 30_000,
  });

  const { data: perms, isLoading } = useQuery({
    queryKey: overridesKey(selectedId),
    queryFn: async () =>
      (await api<{ data: OverridesResponse }>(`/v1/staff/${selectedId}/permissions`)).data,
    enabled: selectedId !== '',
    staleTime: 0,
  });

  /** key → override value. Absent = inherit; that distinction is the whole panel. */
  const overrides = useMemo(
    () => new Map((perms?.overrides ?? []).map((o) => [o.permissionKey, o.value])),
    [perms],
  );

  /**
   * ONE mutation for all three states, because they are one decision. Allow and
   * Deny are the same PUT with a different body; Inherit is the DELETE — the row
   * has to GO, not be set to a third value (§6.1: precedence is decided by the
   * row's existence).
   */
  const setPermission = useMutation({
    mutationFn: async ({ key, next }: { key: string; next: PermissionState }) => {
      const path = `/v1/staff/${selectedId}/permissions/${key}`;
      return next === null
        ? api(path, { method: 'DELETE' })
        : api(path, { method: 'PUT', body: JSON.stringify({ value: next }) });
    },
    // Refetch rather than patch the cache: the server is the resolver (ADR-029
    // §4), and a panel that trusts its own optimistic guess is exactly the second
    // resolver Sprint 8.1 removed.
    onSuccess: () => qc.invalidateQueries({ queryKey: overridesKey(selectedId) }),
    onError: () => toast.error('Could not save that permission. Try again.'),
  });

  const selected = staff.find((s) => s.id === selectedId);
  // ROLE_DEFAULTS is keyed on the TARGET's role, which is the server's floor for
  // them — not the admin's own role, and not the role on the stale staff row if
  // the two ever disagree. `perms.role` comes back with the overrides for exactly
  // that reason.
  const role = perms?.role;

  return (
    <div>
      <PanelHeader
        title="Permissions"
        description="Per-person overrides on top of what their role already allows."
      />

      <label className="block text-[13px] font-semibold text-text-primary" htmlFor="perm-staff">
        Staff member
      </label>
      <select
        id="perm-staff"
        value={selectedId}
        onChange={(e) => setSelectedId(e.target.value)}
        style={{ colorScheme: 'dark' }}
        className="mt-1.5 h-11 w-full max-w-sm rounded-md border border-border-default bg-bg-elevated px-3 text-sm text-text-primary outline-none focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)]"
      >
        <option value="">Choose someone…</option>
        {staff
          .filter((s) => s.active)
          .map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.role.replaceAll('_', ' ')}
            </option>
          ))}
      </select>

      {selectedId === '' ? (
        <p className="mt-8 rounded-xl border border-dashed border-border-default bg-bg-surface px-6 py-16 text-center text-sm text-text-muted">
          Pick someone to see what they can do, and change it.
        </p>
      ) : isLoading || !role ? (
        <p className="mt-8 py-16 text-center text-sm text-text-muted">Loading permissions…</p>
      ) : (
        <>
          <p className="mt-6 text-[13px] text-text-secondary">
            Showing <strong className="font-semibold text-text-primary">{selected?.name}</strong>.
            Inherit is the default and follows their role — it is not the same as Deny, and it is
            the only state that keeps them moving when a role default changes.
          </p>

          {GROUPED.map((group) => (
            <section key={group.id} className="mt-8">
              <h2 className="mb-3 font-[family-name:var(--font-display)] text-[15px] font-bold text-text-primary">
                {group.title}
              </h2>
              <div className="rounded-xl border border-border-subtle bg-bg-surface">
                {group.keys.map((key) => (
                  <PermissionControl
                    key={key}
                    permissionKey={key}
                    label={humanise(key)}
                    // `has` before `get` — an override of `false` is a DENY row and
                    // must not collapse into "no row" the way `get(k) ?? null` would.
                    value={overrides.has(key) ? overrides.get(key)! : null}
                    roleDefault={ROLE_DEFAULTS[key]?.[role] ?? false}
                    disabled={!canWrite || setPermission.isPending}
                    onChange={(next) => setPermission.mutate({ key, next })}
                  />
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
