'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useState } from 'react';

import { MessageContent } from './message-content';

import type { ChatMessageDTOWire } from '@skaly/shared';

import { api } from '@/lib/api';

/**
 * The thread side panel (04-APPFLOW chat flow).
 *
 * Replies load through GET /v1/chat/messages/:id/thread — a SEPARATE query from the
 * main list, deliberately. A thread is a different addressable thing: merging it into
 * the list cache would mean the list's pagination had to understand nesting, and the
 * reply count on the parent would need to stay in step with two sources.
 *
 * On a successful reply the parent's replyCount is patched in the LIST cache, so the
 * count updates without refetching a page of messages to learn one number.
 */
export function ThreadPanel({
  parent,
  meName,
  onClose,
}: {
  parent: ChatMessageDTOWire | null;
  meName: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const parentId = parent?.id ?? null;

  const { data: replies = [], isPending } = useQuery({
    queryKey: ['chat', 'thread', parentId],
    queryFn: async () =>
      (await api<{ data: ChatMessageDTOWire[] }>(`/v1/chat/messages/${parentId}/thread`)).data,
    // Only fetch when a thread is actually open.
    enabled: parentId !== null,
  });

  const reply = useMutation({
    mutationFn: async (content: string) =>
      (await api<{ data: ChatMessageDTOWire }>('/v1/chat/messages', {
        method: 'POST',
        body: JSON.stringify({ content, parentId }),
      })).data,
    onSuccess: (msg) => {
      queryClient.setQueryData<ChatMessageDTOWire[]>(['chat', 'thread', parentId], (prev) =>
        prev ? [...prev, msg] : [msg],
      );
      // Patch the parent's count in the LIST rather than refetching a page to learn
      // one number.
      queryClient.setQueryData<{ pages: { data: ChatMessageDTOWire[] }[] }>(
        ['chat', 'messages'],
        (prev) =>
          prev
            ? {
                ...prev,
                pages: prev.pages.map((p) => ({
                  ...p,
                  data: p.data.map((m) => (m.id === parentId ? { ...m, replyCount: m.replyCount + 1 } : m)),
                })),
              }
            : prev,
      );
      setDraft('');
    },
  });

  const submit = useCallback(() => {
    const content = draft.trim();
    if (!content || reply.isPending) return;
    reply.mutate(content);
  }, [draft, reply]);

  return (
    <AnimatePresence>
      {parent && (
        <motion.aside
          data-testid="thread-panel"
          aria-label="Thread"
          initial={{ x: 360, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 360, opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="flex h-full w-[360px] shrink-0 flex-col border-l"
          style={{ borderColor: 'var(--border-subtle, #262b33)', background: 'var(--bg-surface, #14161a)' }}
        >
          <header
            className="flex items-center justify-between border-b px-4 py-3"
            style={{ borderColor: 'var(--border-subtle, #262b33)' }}
          >
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary, #e8eaed)' }}>
              Thread
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close thread"
              data-testid="thread-close"
              className="text-xs"
              style={{ color: 'var(--text-muted)' }}
            >
              Close
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {/* The parent, for context — a reply with no question above it is unreadable. */}
            <div className="border-b pb-3" style={{ borderColor: 'var(--border-subtle, #262b33)' }}>
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary, #e8eaed)' }}>
                {parent.senderName ?? 'Unknown'}
              </p>
              <div className="text-sm" style={{ color: 'var(--text-secondary, #9aa3ad)' }}>
                <MessageContent
                  content={parent.content}
                  mentionNames={parent.mentions.map((m) => m.name)}
                  highlightNames={meName ? [meName] : []}
                />
              </div>
            </div>

            {isPending && (
              <p className="py-4 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                Loading replies…
              </p>
            )}

            {replies.map((r) => (
              <div key={r.id} data-testid="thread-reply" className="pt-3">
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary, #e8eaed)' }}>
                  {r.senderName ?? 'Unknown'}
                </p>
                <div className="text-sm" style={{ color: 'var(--text-secondary, #9aa3ad)' }}>
                  {r.isDeleted ? (
                    <span className="italic" style={{ color: 'var(--text-muted)' }}>
                      Message deleted
                    </span>
                  ) : (
                    <MessageContent
                      content={r.content}
                      mentionNames={r.mentions.map((m) => m.name)}
                      highlightNames={meName ? [meName] : []}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border-subtle, #262b33)' }}>
            <textarea
              aria-label="Reply"
              data-testid="thread-composer"
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Reply…"
              className="w-full resize-none rounded-md px-3 py-2 text-sm"
              style={{
                background: 'var(--bg-elevated, #1a1d22)',
                color: 'var(--text-primary, #e8eaed)',
                border: '1px solid var(--border-subtle, #262b33)',
              }}
            />
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
