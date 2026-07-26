'use client';

import { NOTIFICATION_REGISTRY } from '@skaly/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import * as Icons from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { NotificationDTO, NotificationListResponse, NotificationType } from '@skaly/shared';

import { api } from '@/lib/api';
import { useNotifySocket } from '@/lib/socket';

/**
 * Notification bell + panel (UIUX §16, APPFLOW bell → panel → deep link).
 *
 * Mounted ONCE in the (portal) layout, like SearchPalette — one socket subscription
 * and one cache entry for the whole app.
 *
 * ⚠️ THE BADGE AND THE PANEL READ THE SAME CACHE ENTRY. `meta.unreadCount` rides the
 * list response, so there is exactly one source of truth. The classic bug here is a
 * badge patched from the `notify:new` payload while the panel reads a separate query
 * that was never seeded — a count of 3 above an empty list, which reads as a broken
 * bell and is really two sources disagreeing.
 *
 * ⚠️ `notify:new` PREPENDS FROM THE PAYLOAD — no refetch (ADR-022's patch principle
 * applied to notifications). The payload is deliberately the complete row, so a bell
 * that refetched on every notification would be the org-wide fan-out problem in
 * miniature: 50 users, one task assignment, 50 GETs.
 */
const QUERY_KEY = ['notifications'] as const;
const BADGE_CAP = 99;

/** The row shape the API returns, plus the socket's snake_case echo of the DB row. */
interface NotifyNewPayload {
  id: string;
  type: string;
  title: string;
  message: string | null;
  payload: Record<string, unknown> | null;
  is_read: boolean;
  created_at: string;
}

/** The socket sends the raw row; the REST list sends the DTO. Normalise to the DTO. */
const fromSocket = (p: NotifyNewPayload): NotificationDTO => ({
  id: p.id,
  type: p.type,
  title: p.title,
  body: p.message,
  payload: p.payload ?? {},
  isRead: p.is_read,
  createdAt: p.created_at,
});

/** Lucide names come from the registry, so a new type needs no code here. */
function TypeIcon({ type }: { type: string }) {
  const spec = NOTIFICATION_REGISTRY[type as NotificationType];
  const Fallback = Icons.Bell;
  const Icon = (spec ? (Icons as unknown as Record<string, typeof Icons.Bell>)[spec.icon] : null) ?? Fallback;
  const colour =
    spec?.severity === 'critical'
      ? 'var(--status-error, #ef4444)'
      : spec?.severity === 'warning'
        ? 'var(--accent-gold)'
        : spec?.severity === 'success'
          ? 'var(--status-success, #22c55e)'
          : 'var(--text-secondary)';
  return <Icon size={18} style={{ color: colour }} aria-hidden />;
}

/** DM Mono relative time — "now", "12m", "3h", "5d". */
function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** Today vs Earlier, per UIUX §16. Order within each group is preserved (newest first). */
function groupByDay(items: NotificationDTO[]): { today: NotificationDTO[]; earlier: NotificationDTO[] } {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today: NotificationDTO[] = [];
  const earlier: NotificationDTO[] = [];
  for (const n of items) {
    (new Date(n.createdAt) >= startOfToday ? today : earlier).push(n);
  }
  return { today, earlier };
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api<NotificationListResponse>('/v1/notifications'),
  });

  // Memoised because `?? []` is a NEW array every render, which would re-create
  // markAllRead's identity on each one.
  const items = useMemo(() => data?.data ?? [], [data]);
  const unread = data?.meta.unreadCount ?? 0;

  // ── notify:new → PREPEND from the payload, never refetch ────────────────────
  const onNew = useCallback(
    (raw: NotifyNewPayload) => {
      queryClient.setQueryData<NotificationListResponse>(QUERY_KEY, (prev) => {
        if (!prev) return prev;
        // The socket can redeliver on reconnect; a duplicate row would double the
        // badge and render twice with the same key.
        if (prev.data.some((n) => n.id === raw.id)) return prev;
        return {
          data: [fromSocket(raw), ...prev.data],
          meta: {
            ...prev.meta,
            unreadCount: prev.meta.unreadCount + 1,
            totalReturned: prev.meta.totalReturned + 1,
          },
        };
      });
    },
    [queryClient],
  );
  useNotifySocket<NotifyNewPayload>('notify:new', onNew);

  // ── notify:read → patch the exact rows, so a second tab stays in step ───────
  const onRead = useCallback(
    ({ ids }: { ids: string[] }) => {
      const marked = new Set(ids);
      queryClient.setQueryData<NotificationListResponse>(QUERY_KEY, (prev) => {
        if (!prev) return prev;
        let cleared = 0;
        const next = prev.data.map((n) => {
          if (marked.has(n.id) && !n.isRead) {
            cleared += 1;
            return { ...n, isRead: true };
          }
          return n;
        });
        return {
          data: next,
          meta: { ...prev.meta, unreadCount: Math.max(0, prev.meta.unreadCount - cleared) },
        };
      });
    },
    [queryClient],
  );
  useNotifySocket<{ ids: string[] }>('notify:read', onRead);

  // Close on outside click and on Escape (UIUX §16).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const markRead = useCallback(
    async (id: string) => {
      // Optimistic: the server echoes notify:read, and onRead is idempotent, so the
      // echo confirms rather than double-applies.
      onRead({ ids: [id] });
      await api(`/v1/notifications/${id}/read`, { method: 'PUT' }).catch(() => {
        void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      });
    },
    [onRead, queryClient],
  );

  const openNotification = useCallback(
    (n: NotificationDTO) => {
      void markRead(n.id);
      // Deep links come from the registry — no URL construction in this component,
      // so a new type never means a new conditional here.
      const href = NOTIFICATION_REGISTRY[n.type as NotificationType]?.linkBuilder(n.payload);
      setOpen(false);
      if (href) router.push(href);
    },
    [markRead, router],
  );

  const markAllRead = useCallback(async () => {
    onRead({ ids: items.filter((n) => !n.isRead).map((n) => n.id) });
    await api('/v1/notifications/read-all', { method: 'PUT' }).catch(() => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    });
  }, [items, onRead, queryClient]);

  const { today, earlier } = groupByDay(items);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        className="relative grid h-9 w-9 place-items-center rounded-md transition-colors"
        style={{ color: unread > 0 ? 'var(--accent-gold)' : 'var(--text-secondary)' }}
      >
        {/* Filled when unread, outlined otherwise (UIUX §16). */}
        <Icons.Bell size={24} fill={unread > 0 ? 'currentColor' : 'none'} aria-hidden />
        {unread > 0 && (
          <span
            data-testid="notification-badge"
            className="absolute -right-0.5 -top-0.5 grid min-w-[18px] place-items-center rounded-full px-1 text-[10px] font-medium"
            style={{
              background: 'var(--accent-gold)',
              color: 'var(--bg-base)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {/* Capped in the UI, never in the query — mark-all-read still has to
                clear the real number, and a second tab has to agree with it. */}
            {unread > BADGE_CAP ? `${BADGE_CAP}+` : unread}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-label="Notifications"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute right-0 z-50 mt-2 flex w-[380px] flex-col overflow-hidden rounded-lg border shadow-xl"
            style={{
              maxHeight: 480,
              background: 'var(--bg-surface, #14161a)',
              borderColor: 'var(--border-subtle, #262b33)',
            }}
          >
            <header
              className="flex shrink-0 items-center justify-between border-b px-4 py-3"
              style={{ borderColor: 'var(--border-subtle, #262b33)' }}
            >
              <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary, #e8eaed)' }}>
                Notifications
              </h2>
              {unread > 0 && (
                <button
                  type="button"
                  onClick={() => void markAllRead()}
                  className="text-xs transition-colors"
                  style={{ color: 'var(--accent-gold)' }}
                >
                  Mark all read
                </button>
              )}
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {items.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-muted, #6b7280)' }}>
                  Nothing yet. You&rsquo;re all caught up.
                </p>
              ) : (
                <>
                  <Group label="Today" items={today} onOpen={openNotification} />
                  <Group label="Earlier" items={earlier} onOpen={openNotification} />
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Group({
  label,
  items,
  onOpen,
}: {
  label: string;
  items: NotificationDTO[];
  onOpen: (n: NotificationDTO) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3
        className="sticky top-0 px-4 py-1.5 text-[11px] uppercase tracking-wide"
        style={{ background: 'var(--bg-surface, #14161a)', color: 'var(--text-muted, #6b7280)' }}
      >
        {label}
      </h3>
      {items.map((n) => (
        <Row key={n.id} n={n} onOpen={onOpen} />
      ))}
    </section>
  );
}

function Row({ n, onOpen }: { n: NotificationDTO; onOpen: (n: NotificationDTO) => void }) {
  // rollover_failed renders in full with no truncation (FR-NOTIF-04). Driven by the
  // registry's severity, not by a type name check, so the next critical type inherits it.
  const critical = NOTIFICATION_REGISTRY[n.type as NotificationType]?.severity === 'critical';

  return (
    <button
      type="button"
      onClick={() => onOpen(n)}
      data-testid="notification-row"
      data-unread={!n.isRead}
      className="flex w-full gap-3 border-b px-4 py-3 text-left transition-colors"
      style={{
        minHeight: 64,
        borderColor: 'var(--border-subtle, #262b33)',
        background: critical
          ? 'color-mix(in srgb, var(--status-error, #ef4444) 10%, transparent)'
          : n.isRead
            ? 'transparent'
            : 'color-mix(in srgb, var(--accent-gold) 6%, transparent)',
      }}
    >
      <span className="mt-0.5 shrink-0">
        <TypeIcon type={n.type} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium" style={{ color: 'var(--text-primary, #e8eaed)' }}>
          {n.title}
        </span>
        {n.body && (
          <span
            className={`mt-0.5 block text-xs ${critical ? '' : 'line-clamp-2'}`}
            style={{ color: 'var(--text-secondary, #9aa3ad)' }}
          >
            {n.body}
          </span>
        )}
      </span>
      <time
        dateTime={n.createdAt}
        className="shrink-0 text-[11px]"
        style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted, #6b7280)' }}
      >
        {relativeTime(n.createdAt)}
      </time>
    </button>
  );
}
