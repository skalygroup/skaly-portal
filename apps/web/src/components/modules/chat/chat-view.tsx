'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { applyMention, findMentionQuery, matchStaff } from './mention-autocomplete';
import { MessageContent } from './message-content';
import { ThreadPanel } from './thread-panel';
import { useChatScroll } from './use-chat-scroll';

import type { ChatListResponse, ChatMessageDTOWire } from '@skaly/shared';
import type { StaffMeResponse } from '@skaly/shared/schemas/auth';

import { api } from '@/lib/api';
import { useConnectionState } from '@/lib/hooks/use-connection-state';
import { usePresence } from '@/lib/hooks/use-presence';
import { getSocket, useChatSocket, WS_CHAT } from '@/lib/socket';

/** Consecutive messages from one author within this window share a header. */
const GROUP_WINDOW_MS = 5 * 60_000;
/** Client-side typing throttle — matches the server's TYPING_THROTTLE_MS. */
const TYPING_THROTTLE_MS = 2_000;
/** Stop broadcasting "typing" after this much silence. */
const TYPING_IDLE_MS = 3_000;

const QUERY_KEY = ['chat', 'messages'] as const;

interface TypingPayload {
  staffId: string;
  isTyping: boolean;
}

/**
 * The common chat (04-APPFLOW chat flow, UIUX §16).
 *
 * Message rows do five things — grouping, mention highlight, presence, tombstones and
 * thread counts. Only two of those are really the ROW's job: grouping is a property of
 * the LIST (it depends on the previous message, which a row cannot see), and mention
 * highlighting belongs to the CONTENT renderer, which owns the escaping rules. So the
 * split here is list → row → content, not one component doing all five.
 */
export function ChatView({ me }: { me: StaffMeResponse | null }) {
  const queryClient = useQueryClient();
  const connection = useConnectionState();
  const {
    messages,
    scrollRef,
    sentinelRef,
    isPending,
    isFetchingNextPage,
    hasNextPage,
    pendingCount,
    scrollToBottom,
    onIncoming,
  } = useChatScroll();

  const [typingIds, setTypingIds] = useState<string[]>([]);

  // ── Incoming messages: append from the payload, never refetch ──────────────
  const onMessage = useCallback(
    (msg: ChatMessageDTOWire & { actorStaffId?: string }) => {
      // Sender exclusion (ADR-022 rule b): the author already rendered this
      // optimistically, so re-appending would show it twice.
      if (me && msg.actorStaffId === me.id) return;

      queryClient.setQueryData<{ pages: ChatListResponse[]; pageParams: unknown[] }>(QUERY_KEY, (prev) => {
        if (!prev) return prev;
        const [first, ...rest] = prev.pages;
        if (!first) return prev;
        // Page 0 is the NEWEST page and is newest-first, so a new message goes at
        // its head.
        if (first.data.some((m) => m.id === msg.id)) return prev;
        return { ...prev, pages: [{ ...first, data: [msg, ...first.data] }, ...rest] };
      });
      onIncoming();
    },
    [me, onIncoming, queryClient],
  );
  useChatSocket<ChatMessageDTOWire & { actorStaffId?: string }>('chat:message', onMessage);

  // ── Deletions: TOMBSTONE in place, never remove ───────────────────────────
  const onDeleted = useCallback(
    ({ id }: { id: string }) => {
      queryClient.setQueryData<{ pages: ChatListResponse[]; pageParams: unknown[] }>(QUERY_KEY, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          // Removing the row would reflow the conversation under whoever is reading
          // it; the tombstone holds its place.
          pages: prev.pages.map((p) => ({
            ...p,
            data: p.data.map((m) => (m.id === id ? { ...m, isDeleted: true, content: '', mentions: [] } : m)),
          })),
        };
      });
    },
    [queryClient],
  );
  useChatSocket<{ id: string }>('chat:deleted', onDeleted);

  // ── Typing indicators ─────────────────────────────────────────────────────
  const typingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const onTyping = useCallback(
    ({ staffId, isTyping }: TypingPayload) => {
      const timers = typingTimers.current;
      clearTimeout(timers.get(staffId));
      if (!isTyping) {
        timers.delete(staffId);
        setTypingIds((prev) => prev.filter((id) => id !== staffId));
        return;
      }
      setTypingIds((prev) => (prev.includes(staffId) ? prev : [...prev, staffId]));
      // Self-expiring: a client that dies mid-type would otherwise leave someone
      // "typing…" forever, since the stop event never arrives.
      timers.set(
        staffId,
        setTimeout(() => {
          timers.delete(staffId);
          setTypingIds((prev) => prev.filter((id) => id !== staffId));
        }, TYPING_IDLE_MS + 1_000),
      );
    },
    [],
  );
  useChatSocket<TypingPayload>('chat:typing', onTyping);

  useEffect(() => {
    const timers = typingTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of messages) if (m.senderId && m.senderName) map.set(m.senderId, m.senderName);
    return map;
  }, [messages]);

  const typingLabel = useMemo(() => {
    const names = typingIds.filter((id) => id !== me?.id).map((id) => nameById.get(id) ?? 'Someone');
    if (names.length === 0) return null;
    if (names.length === 1) return `${names[0]} is typing…`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
    return `${names[0]} and ${names.length - 1} others are typing…`;
  }, [typingIds, nameById, me?.id]);

  // ── Presence + thread panel ───────────────────────────────────────────────
  const { isOnline } = usePresence();
  const [threadParent, setThreadParent] = useState<ChatMessageDTOWire | null>(null);

  // ── Composer ──────────────────────────────────────────────────────────────
  const [draft, setDraft] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const lastTypingSent = useRef(0);
  const stopTypingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: staff = [] } = useQuery({
    queryKey: ['staff'],
    queryFn: async () =>
      (await api<{ data: { id: string; name: string; role: string }[] }>('/v1/staff')).data,
    staleTime: 5 * 60_000,
  });

  // The active @-token, recomputed from the draft and the caret. Derived rather than
  // stored, so it can never disagree with what is actually in the textarea.
  const caret = composerRef.current?.selectionStart ?? draft.length;
  const mentionToken = findMentionQuery(draft, caret);
  const suggestions = mentionToken ? matchStaff(staff, mentionToken.query) : [];

  const chooseMention = useCallback(
    (name: string) => {
      if (!mentionToken) return;
      const next = applyMention(draft, mentionToken, name);
      setDraft(next.text);
      setMentionIndex(0);
      // Restore the caret after React commits the new value, or it jumps to the end.
      requestAnimationFrame(() => {
        const el = composerRef.current;
        if (el) el.setSelectionRange(next.caret, next.caret);
      });
    },
    [draft, mentionToken],
  );

  const sendMutation = useMutation({
    mutationFn: async (content: string) =>
      (await api<{ data: ChatMessageDTOWire }>('/v1/chat/messages', {
        method: 'POST',
        body: JSON.stringify({ content }),
      })).data,
    onSuccess: (msg) => {
      queryClient.setQueryData<{ pages: ChatListResponse[]; pageParams: unknown[] }>(QUERY_KEY, (prev) => {
        if (!prev) return prev;
        const [first, ...rest] = prev.pages;
        if (!first || first.data.some((m) => m.id === msg.id)) return prev;
        return { ...prev, pages: [{ ...first, data: [msg, ...first.data] }, ...rest] };
      });
      scrollToBottom();
    },
  });

  const emitTyping = useCallback((isTyping: boolean) => {
    getSocket(WS_CHAT).emit('chat:typing', { isTyping });
  }, []);

  const onDraftChange = useCallback(
    (value: string) => {
      setDraft(value);
      const now = Date.now();
      // Throttled client-side as well as server-side. Both, because a client-only
      // throttle is a request rather than a limit — and a server-only one still lets
      // this tab emit on every keystroke.
      if (now - lastTypingSent.current > TYPING_THROTTLE_MS) {
        lastTypingSent.current = now;
        emitTyping(true);
      }
      if (stopTypingTimer.current) clearTimeout(stopTypingTimer.current);
      stopTypingTimer.current = setTimeout(() => {
        lastTypingSent.current = 0;
        emitTyping(false);
      }, TYPING_IDLE_MS);
    },
    [emitTyping],
  );

  const submit = useCallback(() => {
    const content = draft.trim();
    if (!content || sendMutation.isPending) return;
    setDraft('');
    if (stopTypingTimer.current) clearTimeout(stopTypingTimer.current);
    lastTypingSent.current = 0;
    emitTyping(false);
    sendMutation.mutate(content);
  }, [draft, emitTyping, sendMutation]);

  const disabled = connection !== 'connected';

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      <div className="flex min-w-0 flex-1 flex-col">
      <div ref={scrollRef} className="relative flex-1 overflow-y-auto px-6 py-4" data-testid="chat-scroll">
        {/* Top sentinel — crossing it loads OLDER messages. */}
        <div ref={sentinelRef} data-testid="chat-sentinel" style={{ height: 1 }} />

        {hasNextPage && (
          <p className="py-2 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            {isFetchingNextPage ? 'Loading earlier messages…' : ''}
          </p>
        )}
        {isPending && (
          <p className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            Loading chat…
          </p>
        )}

        {messages.map((msg, i) => {
          const prev = messages[i - 1];
          // Grouping is a LIST property — it depends on the previous message, which a
          // row cannot see.
          const grouped =
            prev !== undefined &&
            prev.senderId === msg.senderId &&
            !prev.isDeleted &&
            !msg.isDeleted &&
            new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
          return (
            <MessageRow
              key={msg.id}
              msg={msg}
              grouped={grouped}
              meName={me?.name ?? null}
              online={msg.senderId ? isOnline(msg.senderId) : false}
              onOpenThread={setThreadParent}
            />
          );
        })}
      </div>

      {pendingCount > 0 && (
        <button
          type="button"
          data-testid="new-messages-pill"
          onClick={scrollToBottom}
          className="mx-auto -mt-10 mb-2 rounded-full px-3 py-1 text-xs font-medium shadow"
          style={{ background: 'var(--accent-gold)', color: 'var(--bg-base)' }}
        >
          ↓ {pendingCount} new message{pendingCount > 1 ? 's' : ''}
        </button>
      )}

      <div className="border-t px-6 py-3" style={{ borderColor: 'var(--border-subtle, #262b33)' }}>
        <p className="h-4 text-xs" data-testid="typing-indicator" style={{ color: 'var(--text-muted)' }}>
          {typingLabel}
        </p>
        {suggestions.length > 0 && (
          <ul
            data-testid="mention-suggestions"
            role="listbox"
            aria-label="Mention a colleague"
            className="mb-1 overflow-hidden rounded-md border"
            style={{
              background: 'var(--bg-elevated, #1a1d22)',
              borderColor: 'var(--border-subtle, #262b33)',
            }}
          >
            {suggestions.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === mentionIndex}
                  data-testid="mention-option"
                  // onMouseDown, not onClick: onClick fires after blur, and blurring
                  // the textarea first loses the caret the insertion depends on.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    chooseMention(s.name);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm"
                  style={{
                    background: i === mentionIndex ? 'color-mix(in srgb, var(--accent-gold) 12%, transparent)' : 'transparent',
                    color: 'var(--text-primary, #e8eaed)',
                  }}
                >
                  <PresenceDot online={isOnline(s.id)} />
                  {s.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={composerRef}
          aria-label="Message"
          data-testid="chat-composer"
          value={draft}
          disabled={disabled}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            // The autocomplete owns the arrow keys and Enter while it is open —
            // otherwise Enter would send a half-typed "@Rah" instead of completing it.
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
              if (e.key === 'Escape') {
                e.preventDefault();
                setDraft((d) => `${d} `); // close the token without losing the text
                return;
              }
            }
            // Enter sends, Shift+Enter is a newline.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder={disabled ? 'Reconnecting — you can read, but not send' : 'Write a message…'}
          title={disabled ? 'Disconnected. Messages cannot be sent until the connection returns.' : undefined}
          className="w-full resize-none rounded-md px-3 py-2 text-sm disabled:opacity-50"
          style={{
            background: 'var(--bg-elevated, #1a1d22)',
            color: 'var(--text-primary, #e8eaed)',
            border: '1px solid var(--border-subtle, #262b33)',
          }}
        />
      </div>
      </div>

      <ThreadPanel parent={threadParent} meName={me?.name ?? null} onClose={() => setThreadParent(null)} />
    </div>
  );
}

/** The 6px presence dot (UIUX §16) — green when online, hollow when not. */
function PresenceDot({ online }: { online: boolean }) {
  return (
    <span
      aria-label={online ? 'Online' : 'Offline'}
      data-testid={online ? 'presence-online' : 'presence-offline'}
      className="inline-block shrink-0 rounded-full"
      style={{
        width: 6,
        height: 6,
        background: online ? 'var(--status-green, #22c55e)' : 'transparent',
        border: online ? 'none' : '1px solid var(--text-muted, #6b7280)',
      }}
    />
  );
}

/** Initials fallback — no avatar_url is the common case for a new staff member. */
function Avatar({ name, url }: { name: string; url: string | null }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element -- avatars are remote R2 URLs
    return <img src={url} alt="" width={28} height={28} className="rounded-full" />;
  }
  return (
    <span
      aria-hidden
      data-testid="avatar-initials"
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold"
      style={{ background: 'var(--bg-elevated, #1a1d22)', color: 'var(--text-secondary, #9aa3ad)' }}
    >
      {initials}
    </span>
  );
}

function MessageRow({
  msg,
  grouped,
  meName,
  online,
  onOpenThread,
}: {
  msg: ChatMessageDTOWire;
  grouped: boolean;
  meName: string | null;
  online: boolean;
  onOpenThread: (msg: ChatMessageDTOWire) => void;
}) {
  if (msg.isDeleted) {
    return (
      <div data-testid="message-tombstone" className="py-1 pl-10 text-sm italic" style={{ color: 'var(--text-muted)' }}>
        Message deleted
      </div>
    );
  }

  return (
    <div data-testid="message-row" className={`flex gap-3 ${grouped ? 'py-0.5' : 'pt-3'}`}>
      {/* The avatar column is reserved even when grouped, so consecutive messages
          stay aligned under the header rather than stepping left. */}
      <div className="w-7 shrink-0">
        {!grouped && (
          <div className="relative">
            <Avatar name={msg.senderName ?? '?'} url={msg.senderAvatarUrl} />
            <span className="absolute -bottom-0.5 -right-0.5">
              <PresenceDot online={online} />
            </span>
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary, #e8eaed)' }}>
              {msg.senderName ?? 'Unknown'}
            </span>
            <time
              dateTime={msg.createdAt}
              className="text-[11px]"
              style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}
            >
              {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
          </div>
        )}
        <div className="text-sm" style={{ color: 'var(--text-secondary, #9aa3ad)' }}>
          <MessageContent
            content={msg.content}
            mentionNames={msg.mentions.map((m) => m.name)}
            highlightNames={meName ? [meName] : []}
          />
        </div>
        <button
          type="button"
          data-testid={msg.replyCount > 0 ? 'thread-count' : 'thread-open'}
          onClick={() => onOpenThread(msg)}
          className="mt-0.5 text-xs"
          style={{ color: msg.replyCount > 0 ? 'var(--accent-gold)' : 'var(--text-muted)' }}
        >
          {msg.replyCount > 0
            ? `${msg.replyCount} ${msg.replyCount === 1 ? 'reply' : 'replies'}`
            : 'Reply'}
        </button>
      </div>
    </div>
  );
}
