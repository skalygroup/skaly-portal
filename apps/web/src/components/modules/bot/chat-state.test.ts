// @vitest-environment node
// The chat core is pure (no React, no DOM) — the streaming + sessionId-guard
// rules that make C-01 correct, tested directly.
import { describe, expect, it } from 'vitest';

import { chatReducer, initialChatState, type ChatState } from './chat-state';

function send(state: ChatState, text = 'hi'): ChatState {
  return chatReducer(state, { type: 'send', userId: 'u1', assistantId: 'a1', text });
}

describe('chatReducer', () => {
  it('send pushes the user message + an empty streaming assistant placeholder (Thinking)', () => {
    const s = send(initialChatState, 'How many overdue?');
    expect(s.busy).toBe(true);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]).toMatchObject({ role: 'user', content: 'How many overdue?' });
    // Empty + streaming → the panel renders the Thinking indicator until a token.
    expect(s.messages[1]).toMatchObject({ role: 'assistant', content: '', streaming: true });
  });

  it('tokens append incrementally to the in-flight assistant message', () => {
    let s = send(initialChatState);
    s = chatReducer(s, { type: 'session', sessionId: 'sess-1' });
    s = chatReducer(s, { type: 'token', sessionId: 'sess-1', delta: 'Here ' });
    s = chatReducer(s, { type: 'token', sessionId: 'sess-1', delta: 'are your tasks.' });
    expect(s.messages[1]).toMatchObject({ content: 'Here are your tasks.', streaming: true });
  });

  it('the terminal message finalises content + attaches the card and stops streaming', () => {
    let s = send(initialChatState);
    s = chatReducer(s, { type: 'session', sessionId: 'sess-1' });
    s = chatReducer(s, { type: 'token', sessionId: 'sess-1', delta: 'partial' });
    s = chatReducer(s, {
      type: 'message',
      sessionId: 'sess-1',
      content: 'Final answer.',
      card: { type: 'task_list', tasks: [] },
    });
    expect(s.busy).toBe(false);
    expect(s.messages[1]).toMatchObject({
      content: 'Final answer.',
      streaming: false,
      card: { type: 'task_list', tasks: [] },
    });
  });

  it('adopts the session from the first event when none is set (opening tokens are never dropped)', () => {
    let s = send(initialChatState); // sessionId still null (fresh conversation)
    s = chatReducer(s, { type: 'token', sessionId: 'sess-9', delta: 'x' });
    expect(s.sessionId).toBe('sess-9');
    expect(s.messages[1]!.content).toBe('x');
  });

  it('ignores an event whose sessionId does not match the active one (stale stream)', () => {
    let s = send(initialChatState);
    s = chatReducer(s, { type: 'session', sessionId: 'sess-1' });
    const before = s;
    s = chatReducer(s, { type: 'token', sessionId: 'sess-OTHER', delta: 'leak' });
    expect(s).toBe(before); // unchanged
    s = chatReducer(s, { type: 'message', sessionId: 'sess-OTHER', content: 'leak', card: undefined });
    expect(s.messages[1]!.content).toBe(''); // still empty, still streaming
    expect(s.busy).toBe(true);
  });

  it('a decision stamps the outgoing card as resolved (ADR-014 turn 2)', () => {
    // Turn 1 finishes with a confirmation card on the last message.
    let s = send(initialChatState);
    s = chatReducer(s, {
      type: 'message',
      sessionId: 'sess-1',
      content: 'Ready — confirm?',
      card: { type: 'confirmation', confirmationId: 'c-1' },
    });
    expect(s.messages.at(-1)!.card!.resolved).toBeUndefined();

    // Pressing Confirm sends the next turn AND resolves the card it belonged to, so
    // the buttons can render their outcome without any per-card component state.
    s = chatReducer(s, { type: 'send', userId: 'u2', assistantId: 'a2', text: 'Yes, go ahead', decision: 'confirm' });
    expect(s.messages[1]!.card!.resolved).toBe('confirm');
    expect(s.messages).toHaveLength(4);
  });

  it('cancel stamps cancel', () => {
    let s = send(initialChatState);
    s = chatReducer(s, {
      type: 'message',
      sessionId: 'sess-1',
      content: 'Ready — confirm?',
      card: { type: 'confirmation', confirmationId: 'c-1' },
    });
    s = chatReducer(s, { type: 'send', userId: 'u2', assistantId: 'a2', text: 'Cancel', decision: 'cancel' });
    expect(s.messages[1]!.card!.resolved).toBe('cancel');
  });

  it('an ordinary send stamps nothing — a typed "yes" leaves the card unresolved', () => {
    // It still becomes inert, because the card is no longer the LAST message. That
    // is derived at render time, not stored here.
    let s = send(initialChatState);
    s = chatReducer(s, {
      type: 'message',
      sessionId: 'sess-1',
      content: 'Ready — confirm?',
      card: { type: 'confirmation', confirmationId: 'c-1' },
    });
    s = chatReducer(s, { type: 'send', userId: 'u2', assistantId: 'a2', text: 'yes' });
    expect(s.messages[1]!.card!.resolved).toBeUndefined();
    // …and it is no longer last.
    expect(s.messages.at(-1)!.card).toBeUndefined();
  });

  it('a decision on a card-less last message changes nothing', () => {
    const s = chatReducer(initialChatState, {
      type: 'send',
      userId: 'u1',
      assistantId: 'a1',
      text: 'Yes, go ahead',
      decision: 'confirm',
    });
    expect(s.messages).toHaveLength(2);
    expect(s.messages.every((m) => m.card === undefined)).toBe(true);
  });

  it('restore rebuilds history and reset clears the panel', () => {
    let s = chatReducer(initialChatState, {
      type: 'restore',
      sessionId: 'sess-restored',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    });
    expect(s.sessionId).toBe('sess-restored');
    expect(s.messages).toHaveLength(2);

    s = chatReducer(s, { type: 'reset' });
    expect(s).toEqual(initialChatState);
  });
});
