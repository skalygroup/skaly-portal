'use client';

import { Plus, Send } from 'lucide-react';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { BotCard } from './bot-card';
import { chatReducer, initialChatState, type BotCard as BotCardPayload, type ChatMessage } from './chat-state';

import { api, ApiError } from '@/lib/api';
import { useNotifySocket } from '@/lib/socket';

/**
 * The AI bot chat panel (STEP 7). C-01: the POST returns only a 202 ack — every
 * visible token + card arrives over /ws/notify (bot:token deltas, a terminal
 * bot:message). Real-time scope is the two bot events only (ADR-010); no grid
 * subscriptions here.
 */

interface SessionView {
  sessionId: string | null;
  messages: Array<{ role: string; content: string }>;
}
type TokenEvent = { sessionId: string; delta: string };
type MessageEvent = { sessionId: string; content: string; card?: BotCardPayload };

const uid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());

export function BotChat() {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [input, setInput] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Restore the conversation on mount (or the empty state).
  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api<{ data: SessionView }>('/v1/bot/session/current');
        if (data.messages.length > 0) {
          dispatch({ type: 'restore', sessionId: data.sessionId, messages: data.messages });
        }
      } catch {
        /* empty/unreachable → start fresh */
      }
    })();
  }, []);

  // Streaming: append deltas, finalise on the terminal message. Handlers are
  // stable (dispatch is stable) so the socket subscription isn't torn down each
  // render. sessionId matching lives in the reducer.
  const onToken = useCallback((e: TokenEvent) => dispatch({ type: 'token', ...e }), []);
  const onMessage = useCallback(
    (e: MessageEvent) => dispatch({ type: 'message', sessionId: e.sessionId, content: e.content, card: e.card }),
    [],
  );
  useNotifySocket<TokenEvent>('bot:token', onToken);
  useNotifySocket<MessageEvent>('bot:message', onMessage);

  // Keep the newest message in view as tokens stream in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [state.messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || state.busy) return;
    setInput('');
    dispatch({ type: 'send', userId: uid(), assistantId: uid(), text });
    try {
      const { data } = await api<{ data: { messageId: string; sessionId: string } }>('/v1/bot/message', {
        method: 'POST',
        body: JSON.stringify({ content: text }),
      });
      dispatch({ type: 'session', sessionId: data.sessionId });
    } catch (err) {
      // The reply normally streams over the socket; only a failed ACK lands here
      // (rate limit, network). Surface friendly copy — never a code.
      const msg =
        err instanceof ApiError && err.status === 429
          ? "You're sending messages a bit fast. Please wait a moment and try again."
          : "I couldn't send that just now. Please try again.";
      dispatch({ type: 'message', sessionId: state.sessionId ?? '', content: msg });
    }
  }, [input, state.busy, state.sessionId]);

  /**
   * A confirmation card's [Confirm] / [Cancel] (ADR-014).
   *
   * The body carries ONLY `confirmationId` + `decision`. `content` is the display
   * line archived to the transcript — the server's gate never reads it when
   * `decision` is present, which is what makes consent structured rather than
   * inferred from prose.
   *
   * Not routed through `send()`: that would put the words in the composer and make
   * them look typed, and it would be blocked by its own `busy` guard.
   */
  const decide = useCallback(
    async (decision: 'confirm' | 'cancel', confirmationId: string) => {
      if (state.busy) return;
      const text = decision === 'confirm' ? 'Yes, go ahead' : 'Cancel';
      dispatch({ type: 'send', userId: uid(), assistantId: uid(), text, decision });
      try {
        const { data } = await api<{ data: { messageId: string; sessionId: string } }>('/v1/bot/message', {
          method: 'POST',
          body: JSON.stringify({ content: text, confirmationId, decision }),
        });
        dispatch({ type: 'session', sessionId: data.sessionId });
      } catch {
        // The outcome normally streams over the socket; only a failed ACK lands here.
        dispatch({
          type: 'message',
          sessionId: state.sessionId ?? '',
          content: "I couldn't send that just now. Please try again.",
        });
      }
    },
    [state.busy, state.sessionId],
  );

  const newConversation = useCallback(async () => {
    setConfirmClear(false);
    try {
      await api('/v1/bot/session/current', { method: 'DELETE' });
    } catch {
      /* clearing is best-effort; reset the panel regardless */
    }
    dispatch({ type: 'reset' });
  }, []);

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--bg-base)' }}>
      <header
        className="flex items-center justify-between px-6 py-4"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <h1 className="text-lg" style={{ fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}>
          Assistant
        </h1>
        {confirmClear ? (
          <span className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            Clear conversation history?
            <button onClick={() => void newConversation()} style={{ color: 'var(--accent-gold)' }}>
              Clear
            </button>
            <button onClick={() => setConfirmClear(false)} style={{ color: 'var(--text-muted)' }}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirmClear(true)}
            className="flex items-center gap-1 text-sm"
            style={{ color: 'var(--text-secondary)' }}
            aria-label="New conversation"
          >
            <Plus size={16} /> New conversation
          </button>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
        {state.messages.length === 0 ? (
          <p className="mt-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            Ask about tasks, attendance, shoots, holidays, and more.
          </p>
        ) : (
          <ul className="mx-auto flex max-w-2xl flex-col gap-4">
            {state.messages.map((m, i) => (
              <MessageBubble
                key={m.id}
                message={m}
                // A confirmation is actionable only on the LAST message. Any newer
                // turn — a button press, a typed "yes", an unrelated question —
                // moves it off the end and the buttons go inert. One rule, and it
                // needs no per-card state to enforce.
                isLast={i === state.messages.length - 1}
                onDecision={decide}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="px-6 py-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Ask the assistant…"
            className="flex-1 resize-none rounded-lg px-3 py-2 text-sm outline-none"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
          />
          <button
            onClick={() => void send()}
            disabled={state.busy || input.trim().length === 0}
            className="rounded-lg p-2 disabled:opacity-40"
            style={{ background: 'var(--accent-gold)', color: 'var(--bg-base)' }}
            aria-label="Send"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  isLast = false,
  onDecision,
}: {
  message: ChatMessage;
  isLast?: boolean;
  onDecision?: (decision: 'confirm' | 'cancel', confirmationId: string) => void;
}) {
  const isUser = message.role === 'user';
  return (
    <li className={isUser ? 'self-end' : 'self-start'} style={{ maxWidth: '85%' }}>
      <div
        className="whitespace-pre-wrap rounded-xl px-3 py-2 text-sm"
        style={{
          background: isUser ? 'var(--bg-selected)' : 'var(--bg-surface)',
          color: 'var(--text-primary)',
        }}
      >
        {message.streaming && message.content.length === 0 ? <ThinkingDots /> : message.content}
      </div>
      {message.card ? (
        <BotCard payload={message.card} actionable={isLast} onDecision={onDecision} />
      ) : null}
    </li>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex gap-1" aria-label="Thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-1.5 w-1.5 animate-bounce rounded-full"
          style={{ background: 'var(--text-muted)', animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}
