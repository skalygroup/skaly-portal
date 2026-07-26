/**
 * The @-mention autocomplete's pure half (UIUX chat composer).
 *
 * Separated from the component because all the fiddly parts are string arithmetic —
 * where the token starts, what replaces it, where the caret lands afterwards — and
 * every one of those is far easier to get right, and to test, without a DOM.
 *
 * The component keeps the keyboard handling and the list; this keeps the maths.
 */

export interface MentionQuery {
  /** Index of the `@` that opened this token. */
  start: number;
  /** The text typed after the `@`, which may contain ONE space. */
  query: string;
}

/**
 * The active mention token at `caret`, or null.
 *
 * Allows a single interior space so "@Rahul Men" still matches "Rahul Menon" — display
 * names here are two words far more often than one. A second space closes the token,
 * which is what stops an entire sentence after an "@" being treated as a search.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;

  // An `@` must start a word — mid-word (an email) is not a mention.
  const prev = at > 0 ? before[at - 1] : ' ';
  if (prev !== undefined && !/\s/.test(prev)) return null;

  const query = before.slice(at + 1);
  if (query.includes('\n')) return null;
  // At most one space, and never a trailing double space.
  if ((query.match(/ /g) ?? []).length > 1) return null;

  return { start: at, query };
}

/** Case-insensitive prefix match, best-first, capped for the popover. */
export function matchStaff<T extends { name: string }>(staff: readonly T[], query: string, limit = 6): T[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return staff.slice(0, limit);

  const starts: T[] = [];
  const contains: T[] = [];
  for (const s of staff) {
    const name = s.name.toLowerCase();
    if (name.startsWith(q)) starts.push(s);
    else if (name.includes(q)) contains.push(s);
  }
  // Prefix matches first: typing "ra" should offer Rahul before Chitra.
  return [...starts, ...contains].slice(0, limit);
}

/**
 * Replace the active token with `@Name ` and report the new caret.
 *
 * The trailing space is deliberate: it closes the token so the autocomplete does not
 * immediately reopen on the name that was just chosen.
 */
export function applyMention(
  text: string,
  token: MentionQuery,
  name: string,
): { text: string; caret: number } {
  const caretInOld = token.start + 1 + token.query.length;
  const insert = `@${name} `;
  return {
    text: text.slice(0, token.start) + insert + text.slice(caretInOld),
    caret: token.start + insert.length,
  };
}
