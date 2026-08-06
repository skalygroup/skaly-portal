'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';

import { MessageContent } from '@/components/modules/chat/message-content';
import {
  applyMention,
  findMentionQuery,
  matchStaff,
} from '@/components/modules/chat/mention-autocomplete';
import { SlidePanel } from '@/components/modules/tasks/slide-panel';
import { api } from '@/lib/api';
import { handleMutationError } from '@/lib/mutation-errors';
import { useNotifySocket } from '@/lib/socket';

import type { StaffMeResponse } from '@skaly/shared/schemas/auth';
import type { CommentModule } from '@skaly/shared/schemas/comments';

/**
 * Comments on a grid row (07-API-CONTRACT §Comments, ADR-032).
 *
 * ── Flat, not threaded, and no tombstones ────────────────────────────────────
 * The sprint guide describes a threaded renderer with soft-deleted tombstones.
 * `comments` has neither `parent_id` nor `deleted_at` (migration 022), and
 * CommentService says so in as many words — so this renders what the API
 * actually returns: one conversation per client-row, oldest first, plus the
 * acknowledge flow the guide omits and the contract has.
 *
 * ── The renderer is chat's ───────────────────────────────────────────────────
 * `MessageContent` already solves the NFR §4.3 problem for chat: linkify and
 * mention-highlight by producing ELEMENTS, never an HTML string, so there is
 * nothing for `dangerouslySetInnerHTML` to be needed for. A second renderer here
 * would be a second place for that property to be lost. Same for the composer's
 * @-token maths — `mention-autocomplete` is imported, not reimplemented.
 *
 * The one difference: chat messages carry server-resolved mention names, comments
 * do not. The staff list the autocomplete already needs doubles as the name set
 * to match against, which is the same answer one round-trip earlier.
 *
 * ── Live updates ─────────────────────────────────────────────────────────────
 * There is no `comment:new` socket event and there must not be one — `new_comment`
 * is a notification TYPE riding `notify:new` (the `report_ready` mistake). The
 * open panel filters that stream for its own record and invalidates. A missed
 * event costs a stale thread until the next fetch, not a wrong one.
 */

interface CommentDTO {
  id: string;
  content: string;
  author: { staffId: string; name: string; role: string };
  acknowledgedBy: { staffId: string; name: string } | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

interface StaffItem {
  id: string;
  name: string;
  role: string;
}

export const commentsKey = (module: CommentModule, recordId: string, period: string) =>
  ['comments', module, recordId, period] as const;

/** Which grid row's thread the one mounted panel is showing. */
export interface CommentTarget {
  module: CommentModule;
  recordId: string;
  recordName: string;
  period: string;
  locked?: boolean;
}

interface CommentPanelState {
  target: CommentTarget | null;
  open: (target: CommentTarget) => void;
  close: () => void;
}

export const useCommentPanelStore = create<CommentPanelState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

/** Deep links already honoured this session — see CommentTrigger's effect. */
const deepLinkOpened = new Set<string>();

/** DM Mono, per UIUX §16 — timestamps are data, not prose. */
const mono = { fontFamily: 'var(--font-mono)' } as const;

function formatStamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * The button that lives in a grid's Client column, and the panel it opens.
 *
 * Also the landing point for `new_comment`'s deep link: the notification's URL is
 * `/<module>?period=…&comments=<recordId>` (CommentService.fanOut), so a trigger
 * whose record matches that param opens itself. Without this the link would drop
 * the user on the right grid with no idea which row was commented on.
 */
export function CommentTrigger({ compact = false, ...target }: CommentTarget & { compact?: boolean }) {
  const open = useCommentPanelStore((s) => s.open);
  const deepLinked = useSearchParams()?.get('comments') ?? null;

  // Once per param value, ever. The trigger lives in a TanStack cell, and cells
  // remount whenever the grid rebuilds its column defs — an effect that merely
  // guarded on `open` would re-open the panel every rebuild, including right
  // after the user closed it.
  useEffect(() => {
    if (deepLinked !== target.recordId || deepLinkOpened.has(deepLinked)) return;
    deepLinkOpened.add(deepLinked);
    open(target);
    // `target` is a fresh object each render; the param and the record are what
    // decide whether this fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinked, target.recordId, open]);

  return (
    <button
      type="button"
      aria-label={`Comments on ${target.recordName}`}
      data-testid={`comments-open-${target.recordId}`}
      onClick={() => open(target)}
      className={compact ? 'shrink-0 rounded p-0.5' : 'mt-1 flex items-center gap-1 rounded text-xs'}
      style={{ color: 'var(--text-muted)' }}
    >
      <MessageSquare size={12} />
      {compact ? null : 'Comments'}
    </button>
  );
}

/**
 * The one mounted panel, in the portal layout beside MonthLockSync.
 *
 * ⚠️ It is NOT inside the trigger, and that is the whole point. The trigger sits
 * in a TanStack table cell; TanStack remounts every cell when the `columns` memo
 * rebuilds, and the grids rebuild theirs whenever `me`, `staff` or the lock
 * state resolves. A panel whose open flag lived in the cell therefore closed
 * itself mid-typing — the same remount hazard dropper-ui-store.ts was written
 * for, which is why the state lives in a store here too.
 *
 * Keyed by record so switching rows starts a clean panel rather than carrying
 * the previous row's draft across.
 */
export function CommentPanelHost() {
  const target = useCommentPanelStore((s) => s.target);
  const close = useCommentPanelStore((s) => s.close);
  if (!target) return null;
  return (
    <CommentPanel
      key={`${target.module}:${target.recordId}:${target.period}`}
      {...target}
      open
      onClose={close}
    />
  );
}

export function CommentPanel({
  module,
  recordId,
  recordName,
  period,
  locked = false,
  open,
  onClose,
}: CommentTarget & { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const queryKey = useMemo(() => commentsKey(module, recordId, period), [module, recordId, period]);

  const { data: comments = [], isPending } = useQuery({
    queryKey,
    queryFn: async () =>
      (
        await api<{ data: CommentDTO[] }>(
          `/v1/comments?module=${module}&recordId=${recordId}&period=${period}`,
        )
      ).data,
    staleTime: 30_000,
    // Not fetched until someone opens the panel: three grids × twenty rows would
    // otherwise be sixty requests for a conversation nobody asked to see.
    enabled: open,
  });

  const { data: me } = useQuery({
    queryKey: ['staff-me'],
    queryFn: async () => api<StaffMeResponse>('/v1/staff/me'),
    staleTime: 5 * 60_000,
  });

  const { data: staff = [] } = useQuery({
    queryKey: ['staff'],
    queryFn: async () => (await api<{ data: StaffItem[] }>('/v1/staff')).data,
    staleTime: 5 * 60_000,
    enabled: open,
  });

  const onNotification = useCallback(
    (n: { type?: string; payload?: { recordId?: string; module?: string } }) => {
      // ⚠️ `payload`, not `data`. NotificationService emits the notification ROW
      // (`returningAll`), whose jsonb column is `payload` — the service's own
      // `data` argument is the name on the way IN. Reading `n.data` here matched
      // nothing, so the thread never refreshed, and the unit test agreed with it
      // because it fired the shape the component expected. The E2E is what
      // caught it: it fires the shape the SERVER sends.
      if (n?.type !== 'new_comment') return;
      // Every notification of every type lands here. Without the guard, one task
      // assignment refetches every open comment thread in the building.
      if (n.payload?.recordId !== recordId || n.payload?.module !== module) return;
      void qc.invalidateQueries({ queryKey });
    },
    [qc, queryKey, recordId, module],
  );
  useNotifySocket('notify:new', onNotification);

  // ── Composer ────────────────────────────────────────────────────────────────
  const [draft, setDraft] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const caret = composerRef.current?.selectionStart ?? draft.length;
  const mentionToken = findMentionQuery(draft, caret);
  const suggestions = mentionToken ? matchStaff(staff, mentionToken.query) : [];

  const chooseMention = useCallback(
    (name: string) => {
      if (!mentionToken) return;
      const next = applyMention(draft, mentionToken, name);
      setDraft(next.text);
      setMentionIndex(0);
      // Restore the caret after React commits the value, or it jumps to the end.
      requestAnimationFrame(() => composerRef.current?.setSelectionRange(next.caret, next.caret));
    },
    [draft, mentionToken],
  );

  const post = useMutation({
    mutationFn: async (content: string) =>
      (
        await api<{ data: CommentDTO }>('/v1/comments', {
          method: 'POST',
          body: JSON.stringify({ module, recordId, period, content }),
        })
      ).data,
    onSuccess: (comment) => {
      // The author is excluded from their own fan-out (ADR-006), so no `notify:new`
      // is coming to refetch this — append the row the server returned.
      qc.setQueryData<CommentDTO[]>(queryKey, (prev) => [...(prev ?? []), comment]);
      setDraft('');
    },
    onError: (err) => handleMutationError(err, 'Could not post that comment. Please try again.'),
  });

  const acknowledge = useMutation({
    mutationFn: async (id: string) =>
      api(`/v1/comments/${id}/acknowledge`, {
        method: 'PATCH',
        body: JSON.stringify({ acknowledged: true }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      toast.success('Comment acknowledged.');
    },
    onError: (err) => handleMutationError(err, 'Could not acknowledge that comment.'),
  });

  const submit = useCallback(() => {
    const content = draft.trim();
    if (!content || post.isPending) return;
    post.mutate(content);
  }, [draft, post]);

  const staffNames = useMemo(() => staff.map((s) => s.name), [staff]);
  const canAcknowledge = me?.role === 'admin' || me?.role === 'manager';

  return (
    <SlidePanel open={open} onClose={onClose} title={`Comments · ${recordName}`}>
      <div className="flex h-full flex-col">
        <div className="flex-1 space-y-4" data-testid="comment-thread">
          {isPending ? (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Loading comments…
            </p>
          ) : comments.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              No comments on this row yet.
            </p>
          ) : (
            comments.map((c) => (
              <article key={c.id} data-testid="comment" className="text-sm">
                <header className="flex items-baseline gap-2">
                  <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {c.author.name}
                  </span>
                  <time
                    dateTime={c.createdAt}
                    className="text-[11px]"
                    style={{ ...mono, color: 'var(--text-muted)' }}
                  >
                    {formatStamp(c.createdAt)}
                  </time>
                </header>
                <div style={{ color: 'var(--text-secondary)' }}>
                  <MessageContent
                    content={c.content}
                    mentionNames={staffNames}
                    highlightNames={me?.name ? [me.name] : []}
                  />
                </div>
                {c.acknowledgedBy ? (
                  <p
                    data-testid="comment-acknowledged"
                    className="mt-1 text-[11px]"
                    style={{ color: 'var(--status-green)' }}
                  >
                    ✓ Noted by {c.acknowledgedBy.name}
                  </p>
                ) : canAcknowledge ? (
                  <button
                    type="button"
                    data-testid={`comment-acknowledge-${c.id}`}
                    onClick={() => acknowledge.mutate(c.id)}
                    disabled={acknowledge.isPending}
                    className="mt-1 rounded text-[11px] font-semibold"
                    style={{ color: 'var(--accent-gold)' }}
                  >
                    Acknowledge
                  </button>
                ) : null}
              </article>
            ))
          )}
        </div>

        <div className="pt-4">
          {suggestions.length > 0 && (
            <ul
              data-testid="comment-mention-suggestions"
              role="listbox"
              aria-label="Mention a colleague"
              className="mb-1 overflow-hidden rounded-md border"
              style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
            >
              {suggestions.map((s, i) => (
                <li key={s.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === mentionIndex}
                    data-testid="comment-mention-option"
                    // onMouseDown, not onClick: onClick fires after blur, and
                    // blurring loses the caret the insertion depends on.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      chooseMention(s.name);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-sm"
                    style={{
                      background:
                        i === mentionIndex
                          ? 'color-mix(in srgb, var(--accent-gold) 12%, transparent)'
                          : 'transparent',
                      color: 'var(--text-primary)',
                    }}
                  >
                    {s.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={composerRef}
            aria-label="Write a comment"
            data-testid="comment-composer"
            value={draft}
            // UX only. A locked period is refused with 423 server-side whether or
            // not this is disabled (ADR-029's rule) — this just stops someone
            // typing a paragraph that was never going to be accepted.
            disabled={locked}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // The autocomplete owns the arrows and Enter while it is open, or
              // Enter would post a half-typed "@Rah".
              if (suggestions.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % suggestions.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMentionIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  chooseMention(suggestions[mentionIndex]!.name);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={3}
            placeholder={locked ? 'This period is locked.' : 'Write a comment…'}
            className="w-full resize-none rounded-md px-3 py-2 text-sm disabled:opacity-50"
            style={{
              background: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-subtle)',
            }}
          />
        </div>
      </div>
    </SlidePanel>
  );
}
