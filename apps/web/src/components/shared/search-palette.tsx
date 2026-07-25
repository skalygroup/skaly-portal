'use client';

import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { SearchScope } from '@skaly/shared';
import type { StaffMeResponse } from '@skaly/shared/schemas/auth';

import { SlidePanel } from '@/components/modules/tasks/slide-panel';
import { api } from '@/lib/api';
import { currentIstPeriod } from '@/lib/hooks/use-month-context';

/**
 * CMD+K search palette (UIUX §17, APPFLOW §12, FR-SEARCH-01/02).
 *
 * Mounted ONCE in the (portal) layout, never per page — one hotkey listener, and
 * available from every portal route.
 *
 * ⚠️ `shouldFilter={false}` is load-bearing. cmdk fuzzy-filters its children
 * client-side by default, which would silently drop server results whose text
 * doesn't match cmdk's own heuristic — the server already ranked them (ts_rank /
 * trigram similarity, ADR-015) and its ranking is the one that counts.
 *
 * The palette holds all 20 results per category and reveals the rest behind
 * [Show more] with NO second request (FR-SEARCH-03).
 */

// The four category shapes, exactly as the route serialises them
// (apps/api/src/routes/search/index.ts).
interface TaskHit {
  id: string;
  description: string;
  period: string;
  status: string;
  clientName: string | null;
}
interface ClientHit {
  id: string;
  name: string;
}
interface StaffHit {
  id: string;
  name: string;
  role: string;
  avatarUrl: string | null;
}
interface CommentHit {
  id: string;
  content: string;
  module: string;
  recordContext: string;
  period: string;
}
interface SearchResults {
  tasks: TaskHit[];
  clients: ClientHit[];
  staff: StaffHit[];
  comments: CommentHit[];
}

const EMPTY: SearchResults = { tasks: [], clients: [], staff: [], comments: [] };

/** Below this the palette does not query at all (FR-SEARCH-02) — the API allows
 *  one character, but a single letter is a scan of the whole table for nothing. */
const MIN_QUERY = 2;
const VISIBLE = 5;
const DEBOUNCE_MS = 200;

/** comments.module (migration 022's CHECK) → the page that owns that record. */
const MODULE_PATH: Record<string, string> = {
  shoot_planner: '/shoot-planner',
  content_dropper: '/content-dropper',
  content_calendar: '/content-calendar',
};

const mono = { fontFamily: 'var(--font-mono)' } as const;

export function SearchPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<SearchScope>('current');
  /** Non-manager staff results open this instead of navigating (APPFLOW §12). */
  const [profile, setProfile] = useState<StaffHit | null>(null);

  // The input renders from `q` on every keystroke; only the QUERY waits for the
  // debounce. Putting the debounce in front of the rendered character is what
  // breaks NFR §1.4's 16ms input lag.
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  // Global hotkey. Registered once because this component is mounted once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const { data: me } = useQuery({
    queryKey: ['staff-me'],
    queryFn: async () => api<StaffMeResponse>('/v1/staff/me'),
    staleTime: 5 * 60_000,
    enabled: open,
  });
  const isManager = me?.role === 'admin' || me?.role === 'manager';

  const { data = EMPTY, isFetching } = useQuery({
    queryKey: ['search', debounced, scope],
    queryFn: async () =>
      (
        await api<{ data: SearchResults }>(
          `/v1/search?q=${encodeURIComponent(debounced)}&scope=${scope}`,
        )
      ).data,
    enabled: open && debounced.length >= MIN_QUERY,
    staleTime: 30_000,
  });

  const close = (): void => {
    setOpen(false);
    setQ('');
  };
  const go = (href: string): void => {
    close();
    router.push(href);
  };

  const typed = debounced.length >= MIN_QUERY;
  const groupKey = `${debounced}:${scope}`; // remounts the groups, collapsing [Show more]

  return (
    <>
      <Command.Dialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        label="Search"
        shouldFilter={false}
        overlayClassName="fixed inset-0 z-50"
        contentClassName="fixed left-1/2 top-[12vh] z-50 w-[600px] max-w-[92vw] -translate-x-1/2"
      >
        <div
          className="overflow-hidden rounded-xl"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            boxShadow: '0 24px 64px rgba(0,0,0,0.55)',
          }}
        >
          <Command.Input
            value={q}
            onValueChange={setQ}
            placeholder="Search tasks, clients, staff…"
            className="w-full bg-transparent px-4 py-3.5 text-sm outline-none"
            style={{ color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)' }}
          />

          <div
            className="flex gap-2 px-4 py-2.5"
            style={{ borderBottom: '1px solid var(--border-subtle)' }}
          >
            {(
              [
                ['current', 'This month'],
                ['all_time', 'All time'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setScope(value)}
                aria-pressed={scope === value}
                className="rounded-full px-3 py-1 text-xs transition-colors"
                style={{
                  background: scope === value ? 'var(--accent-gold-dim)' : 'transparent',
                  border: `1px solid ${scope === value ? 'var(--accent-gold-border)' : 'var(--border-subtle)'}`,
                  color: scope === value ? 'var(--accent-gold)' : 'var(--text-secondary)',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <Command.List className="max-h-[52vh] overflow-y-auto px-2 py-2">
            {!typed ? (
              <p className="px-2 py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                Type at least {MIN_QUERY} characters to search tasks, clients, staff and comments.
              </p>
            ) : (
              <>
                <Command.Empty className="px-2 py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  {isFetching ? 'Searching…' : 'No matches.'}
                </Command.Empty>

                <ResultGroup
                  key={`tasks:${groupKey}`}
                  label="Tasks"
                  items={data.tasks}
                  line={(t) => t.description}
                  meta={(t) => [t.status, t.clientName, scope === 'all_time' ? t.period : null].filter(Boolean).join(' · ')}
                  onSelect={(t) => go(`/tasks?period=${t.period}&highlight=${t.id}`)}
                />
                <ResultGroup
                  key={`clients:${groupKey}`}
                  label="Clients"
                  items={data.clients}
                  line={(c) => c.name}
                  meta={() => ''}
                  // Clients have no period of their own (ADR-015 §4) — land on the
                  // current month's pipeline, where the client row lives.
                  onSelect={() => go(`/content-dropper?period=${currentIstPeriod()}`)}
                />
                <ResultGroup
                  key={`staff:${groupKey}`}
                  label="Staff"
                  items={data.staff}
                  line={(s) => s.name}
                  meta={(s) => s.role.replace('_', ' ')}
                  onSelect={(s) => {
                    // A team_member / freelancer has no staff settings page to land
                    // on, so the public profile opens in place instead.
                    if (isManager) return go(`/settings/staff/${s.id}`);
                    close();
                    setProfile(s);
                  }}
                />
                <ResultGroup
                  key={`comments:${groupKey}`}
                  label="Comments"
                  items={data.comments}
                  line={(c) => c.content}
                  meta={(c) => c.recordContext}
                  // TODO(Sprint 12): open the comment box for comment.recordId —
                  // the comment UI does not exist yet, so this lands on its module.
                  onSelect={(c) =>
                    go(`${MODULE_PATH[c.module] ?? '/home'}?period=${c.period}`)
                  }
                />
              </>
            )}
          </Command.List>
        </div>
      </Command.Dialog>

      {/* The search hit already carries every field GET /v1/staff/:id/profile
          returns (id, name, role, avatarUrl), so the modal needs no request. */}
      <SlidePanel open={profile !== null} onClose={() => setProfile(null)} title="Profile">
        {profile ? (
          <div className="flex items-center gap-4">
            {profile.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={profile.avatarUrl} alt="" className="h-14 w-14 rounded-full object-cover" />
            ) : (
              <div
                className="flex h-14 w-14 items-center justify-center rounded-full text-lg"
                style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}
              >
                {profile.name.charAt(0)}
              </div>
            )}
            <div>
              <p className="text-base" style={{ color: 'var(--text-primary)' }}>
                {profile.name}
              </p>
              <p className="text-sm capitalize" style={{ color: 'var(--text-muted)' }}>
                {profile.role.replace('_', ' ')}
              </p>
            </div>
          </div>
        ) : null}
      </SlidePanel>
    </>
  );
}

/**
 * One category. Renders the first {@link VISIBLE} items and reveals the rest of
 * the 20 already in hand behind [Show more] — no second request.
 *
 * Remounted per query+scope by its `key`, which is what collapses it again.
 */
function ResultGroup<T extends { id: string }>({
  label,
  items,
  line,
  meta,
  onSelect,
}: {
  label: string;
  items: T[];
  line: (item: T) => string;
  meta: (item: T) => string;
  onSelect: (item: T) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  if (items.length === 0) return null;

  const shown = showAll ? items : items.slice(0, VISIBLE);

  return (
    <Command.Group
      heading={label}
      className="px-1 py-1 text-xs [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
      style={{ color: 'var(--text-muted)' }}
    >
      {shown.map((item) => (
        <Command.Item
          key={item.id}
          value={item.id}
          onSelect={() => onSelect(item)}
          className="flex cursor-pointer items-baseline justify-between gap-3 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-[var(--accent-gold-dim)]"
          style={{ color: 'var(--text-primary)' }}
        >
          <span className="truncate">{line(item)}</span>
          <span className="shrink-0 text-xs" style={{ ...mono, color: 'var(--text-muted)' }}>
            {meta(item)}
          </span>
        </Command.Item>
      ))}

      {items.length > VISIBLE && !showAll ? (
        <Command.Item
          value={`${label}-show-more`}
          onSelect={() => setShowAll(true)}
          className="cursor-pointer rounded-md px-2 py-1.5 text-xs"
          style={{ color: 'var(--accent-gold)' }}
        >
          Show more ({items.length - VISIBLE})
        </Command.Item>
      ) : null}
    </Command.Group>
  );
}
