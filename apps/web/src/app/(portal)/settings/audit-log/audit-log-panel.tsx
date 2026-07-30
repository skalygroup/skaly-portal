'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, Download, Loader2 } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { AuditDiff } from '@/components/settings/audit-diff';
import { PanelHeader } from '@/components/settings/panel-chrome';
import { api, apiFetch } from '@/lib/api';
import { streamToDisk } from '@/lib/stream-download';
import { cn } from '@/lib/utils';

interface AuditEntry {
  id: string;
  createdAt: string;
  actorId: string;
  actorName: string;
  actorRole: string | null;
  source: string;
  tableName: string;
  action: string;
  recordId: string | null;
  oldValue: unknown;
  newValue: unknown;
  ipAddress: string | null;
}

interface Page {
  data: AuditEntry[];
  nextCursor: string | null;
}

/** NFR §5.3's filter set. One object, so the query key and the export URL are
 *  built from the SAME source and cannot select different rows. */
interface Filters {
  from: string;
  to: string;
  staffId: string;
  tableName: string;
  action: string;
  changedBySource: string;
}

const EMPTY: Filters = {
  from: '',
  to: '',
  staffId: '',
  tableName: '',
  action: '',
  changedBySource: '',
};

const ACTIONS = ['INSERT', 'UPDATE', 'DELETE', 'LOCK', 'UNLOCK', 'DEACTIVATE'];
const SOURCES = ['user', 'system', 'bot'];

/** Blank fields are OMITTED, never sent as empty strings — the API validates
 *  `action` against an enum, and `?action=` would 400 the whole page. */
function toQuery(filters: Filters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  return params.toString();
}

const ROW_HEIGHT = 52;

export function AuditLogPanel() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const query = toQuery(filters);

  // The staff list drives the actor filter; every role may read it (it is the
  // shared @mention lookup), so this needs no extra gating.
  const { data: staff = [] } = useQuery({
    queryKey: ['staff', 'list'],
    queryFn: async () => (await api<{ data: { id: string; name: string }[] }>('/v1/staff')).data,
    staleTime: 5 * 60_000,
  });

  /**
   * Keyset pagination, not offset. `audit_log` is append-only and heavily
   * inserted, so an OFFSET page would skip or repeat rows as new entries land
   * above the window mid-scroll.
   *
   * NOT `useRealtimeQuery`: this surface has no live events, and it should not.
   * A log that reorders under the reader's cursor while they are reading it is
   * worse than one that is a few seconds old.
   */
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteQuery({
    queryKey: ['settings', 'audit-log', query],
    queryFn: ({ pageParam }) =>
      api<Page>(`/v1/audit-log?${[query, pageParam && `cursor=${pageParam}`].filter(Boolean).join('&')}`),
    initialPageParam: '',
    getNextPageParam: (last: Page) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });

  const rows = useMemo(() => data?.pages.flatMap((p) => p.data) ?? [], [data]);

  /**
   * Virtualised because NFR §2.2 puts this at ~50k rows over 12 months, and the
   * expandable diff means rows are not a fixed height once opened —
   * `measureElement` handles that without the panel tracking heights itself.
   */
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !hasNextPage || isFetchingNextPage) return;
    // One viewport of slack, so the next page is in flight before the user hits
    // the bottom rather than after.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  async function exportCsv() {
    setExporting(true);
    try {
      // The SAME filter string the table is showing — the export is "what I am
      // looking at", not "everything", and building it from one `toQuery` is
      // what guarantees that.
      const res = await apiFetch(`/v1/audit-log/export?${query}`);
      if (!res.ok) throw new Error(`Export failed: ${res.status}`);

      const stamp = [filters.from, filters.to].filter(Boolean).join('-to-') || 'all';
      const outcome = await streamToDisk(res, `audit-log-${stamp}.csv`);
      if (outcome === 'saved') toast.success('Export saved.');
    } catch {
      toast.error('Could not export the audit log. Try again.');
    } finally {
      setExporting(false);
    }
  }

  const set = (key: keyof Filters) => (value: string) =>
    setFilters((f) => ({ ...f, [key]: value }));

  return (
    <div>
      <PanelHeader
        title="Audit Log"
        description="Every write, who made it, and what changed. Read-only by design."
        action={
          <button
            type="button"
            onClick={() => void exportCsv()}
            disabled={exporting}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border-default bg-bg-elevated px-3.5 py-2 text-[13px] font-semibold text-text-secondary transition-colors hover:border-accent-gold hover:text-text-primary disabled:opacity-60"
          >
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        }
      />

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From" htmlFor="audit-from">
          <input
            id="audit-from"
            type="date"
            value={filters.from}
            onChange={(e) => set('from')(e.target.value)}
            className={INPUT}
          />
        </Field>
        <Field label="To" htmlFor="audit-to">
          <input
            id="audit-to"
            type="date"
            value={filters.to}
            onChange={(e) => set('to')(e.target.value)}
            className={INPUT}
          />
        </Field>
        <Field label="Actor" htmlFor="audit-actor">
          <select
            id="audit-actor"
            value={filters.staffId}
            onChange={(e) => set('staffId')(e.target.value)}
            style={{ colorScheme: 'dark' }}
            className={INPUT}
          >
            <option value="">Anyone</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Table" htmlFor="audit-table">
          <input
            id="audit-table"
            value={filters.tableName}
            onChange={(e) => set('tableName')(e.target.value)}
            placeholder="staff"
            maxLength={50}
            className={INPUT}
          />
        </Field>
        <Field label="Action" htmlFor="audit-action">
          <select
            id="audit-action"
            value={filters.action}
            onChange={(e) => set('action')(e.target.value)}
            style={{ colorScheme: 'dark' }}
            className={INPUT}
          >
            <option value="">Any</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Source" htmlFor="audit-source">
          <select
            id="audit-source"
            value={filters.changedBySource}
            onChange={(e) => set('changedBySource')(e.target.value)}
            style={{ colorScheme: 'dark' }}
            className={INPUT}
          >
            <option value="">Any</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <button
          type="button"
          onClick={() => setFilters(EMPTY)}
          className="h-10 rounded-md px-3 text-[13px] font-semibold text-text-muted transition-colors hover:text-text-primary"
        >
          Clear
        </button>
      </div>

      {/*
        There are no edit or delete controls in this component, and there is no
        place to add one: migration 026 revokes UPDATE and DELETE on `audit_log`
        from the app role, so a mutation button could only ever render an error.
        The read-only-ness is structural, not a styling choice.
      */}
      {isLoading ? (
        <div className="flex items-center gap-2 py-16 text-text-muted">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">Loading…</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-default bg-bg-surface px-6 py-16 text-center">
          <p className="text-sm text-text-muted">Nothing matches those filters.</p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          data-testid="audit-scroll"
          className="h-[560px] overflow-auto rounded-xl border border-border-subtle bg-bg-surface"
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]!;
              const open = expanded === row.id;
              return (
                <div
                  key={row.id}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  data-testid="audit-row"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${item.start}px)`,
                  }}
                  className="border-b border-border-subtle"
                >
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : row.id)}
                    aria-expanded={open}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-hover"
                  >
                    <ChevronRight
                      size={14}
                      className={cn('shrink-0 text-text-muted transition-transform', open && 'rotate-90')}
                    />
                    <span className="w-40 shrink-0 font-[family-name:var(--font-mono)] text-[11.5px] text-text-muted">
                      {row.createdAt.slice(0, 19).replace('T', ' ')}
                    </span>
                    <span className="w-36 shrink-0 truncate text-[13px] font-medium text-text-primary">
                      {row.actorName}
                    </span>
                    <span className={cn(ACTION_PILL, actionTone(row.action))}>{row.action}</span>
                    <span className="w-40 shrink-0 truncate font-[family-name:var(--font-mono)] text-[12px] text-text-secondary">
                      {row.tableName}
                    </span>
                    {/* `source` distinguishes a bot write from a human one — the
                        single most useful column when reconstructing "who did
                        this", and invisible without it (ADR-016). */}
                    <span className="font-[family-name:var(--font-mono)] text-[11px] text-text-muted">
                      {row.source}
                    </span>
                  </button>
                  {open && <AuditDiff oldValue={row.oldValue} newValue={row.newValue} />}
                </div>
              );
            })}
          </div>
          {isFetchingNextPage && (
            <p className="flex items-center justify-center gap-2 py-4 text-[12.5px] text-text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading more…
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const INPUT =
  'h-10 rounded-md border border-border-default bg-bg-elevated px-3 text-[13px] text-text-primary outline-none focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)]';

const ACTION_PILL =
  'w-24 shrink-0 rounded-full px-2 py-0.5 text-center font-[family-name:var(--font-mono)] text-[10.5px]';

function actionTone(action: string): string {
  if (action === 'DELETE' || action === 'DEACTIVATE') return 'bg-status-red/10 text-status-red';
  if (action === 'INSERT') return 'bg-status-green/10 text-status-green';
  return 'bg-bg-elevated text-text-secondary';
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-[11.5px] font-semibold text-text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}
