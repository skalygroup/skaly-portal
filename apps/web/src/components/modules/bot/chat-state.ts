/**
 * The bot chat state machine — pure, so it unit-tests in node without jsdom
 * (mirrors lib/hooks/use-polling's extracted core). The React panel drives it
 * with useReducer; the socket + POST feed it actions.
 *
 * The load-bearing rule is C-01 streaming correctness: bot:token deltas append
 * to the in-flight assistant message, the terminal bot:message finalises it, and
 * an event for a different sessionId is ignored so a stale stream can't
 * cross-contaminate the panel.
 */

export interface BotCard {
  type: string;
  [k: string]: unknown;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  card?: BotCard;
  /** True while this assistant message is still receiving tokens — the panel
   *  shows the Thinking indicator when it's streaming and still empty. */
  streaming?: boolean;
}

export interface ChatState {
  /** The active bot session. Null until the first turn adopts one (from the 202
   *  ack or the first socket event). */
  sessionId: string | null;
  messages: ChatMessage[];
  /** A turn is in flight (awaiting tokens / the terminal message). */
  busy: boolean;
}

export type ChatAction =
  | { type: 'restore'; sessionId: string | null; messages: Array<{ role: string; content: string }> }
  | {
      type: 'send';
      userId: string;
      assistantId: string;
      text: string;
      /** Set when this send came from a confirmation card's buttons (ADR-014). It
       *  stamps the OUTGOING card as resolved so the buttons can render their
       *  outcome — see the note on ChatMessage.card. */
      decision?: 'confirm' | 'cancel';
    }
  | { type: 'session'; sessionId: string }
  | { type: 'token'; sessionId: string; delta: string }
  | { type: 'message'; sessionId: string; content: string; card?: BotCard }
  | { type: 'reset' };

export const initialChatState: ChatState = { sessionId: null, messages: [], busy: false };

/** True when the event belongs to the active session. A null active session
 *  adopts the event's session (first-event-wins) so the opening tokens of a
 *  brand-new conversation — which can arrive before the 202 sets the id — are
 *  never dropped. Once set, a mismatched id is a stale stream and is ignored. */
function belongs(state: ChatState, sessionId: string): boolean {
  return state.sessionId === null || state.sessionId === sessionId;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'restore':
      return {
        sessionId: action.sessionId,
        busy: false,
        messages: action.messages.map((m, i) => ({
          id: `restored-${i}`,
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content,
        })),
      };

    case 'send': {
      // A confirmation card's buttons stamp their outcome onto the card they belong
      // to — the LAST message, which is the one carrying it. Held here rather than in
      // the component so the resolved state cannot drift from the transcript, and so
      // it survives a re-render without a useState per card.
      //
      // Whether the buttons are still CLICKABLE is not stored at all: it derives from
      // "is this the last message", which covers the button path, a typed "yes", and
      // an unrelated new question with one rule instead of three.
      const messages = action.decision
        ? state.messages.map((m, i) =>
            i === state.messages.length - 1 && m.card
              ? { ...m, card: { ...m.card, resolved: action.decision } }
              : m,
          )
        : state.messages;

      return {
        ...state,
        busy: true,
        messages: [
          ...messages,
          { id: action.userId, role: 'user', content: action.text },
          { id: action.assistantId, role: 'assistant', content: '', streaming: true },
        ],
      };
    }

    case 'session':
      // Adopt the id from the 202 ack (only meaningful on a fresh session).
      return state.sessionId === null ? { ...state, sessionId: action.sessionId } : state;

    case 'token': {
      if (!belongs(state, action.sessionId)) return state;
      const messages = state.messages.map((m) =>
        m.streaming ? { ...m, content: m.content + action.delta } : m,
      );
      return { ...state, sessionId: action.sessionId, messages };
    }

    case 'message': {
      if (!belongs(state, action.sessionId)) return state;
      // Finalise the in-flight assistant message: authoritative content + card,
      // stop streaming. The render settles once (no half-built card flicker).
      const messages = state.messages.map((m) =>
        m.streaming
          ? { ...m, content: action.content, card: action.card, streaming: false }
          : m,
      );
      return { sessionId: action.sessionId, messages, busy: false };
    }

    case 'reset':
      return { ...initialChatState };

    default:
      return state;
  }
}
