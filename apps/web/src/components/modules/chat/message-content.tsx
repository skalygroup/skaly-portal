'use client';

import { Fragment, type ReactNode } from 'react';

/**
 * Message content rendering — the NFR §4.3 surface.
 *
 * THERE IS NO `dangerouslySetInnerHTML` HERE, AND THERE MUST NEVER BE.
 *
 * The reasoning, because it is easy to get backwards: DOMPurify is belt-and-braces,
 * not the primary defence. React already escapes text children, so `{message.content}`
 * is safe against `<script>` and `<img onerror=…>` by construction. The real exposure
 * is `dangerouslySetInnerHTML`, and the only honest way to hold that line is to never
 * construct an HTML string in the first place.
 *
 * So the linkifier below produces ELEMENTS, not markup. There is no intermediate
 * string for anything to be injected into, which is why no sanitiser is needed on this
 * path — adding `dangerouslySetInnerHTML` and then reaching for DOMPurify to make it
 * safe would be strictly worse than the code here.
 *
 * Mentions are highlighted the same way: by splitting the text and wrapping the
 * matched RANGE in a <mark>, never by rewriting the content.
 */

/** http/https only. A `javascript:` URL in an href is the classic bypass. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')]+/gi;

/** `@Name` — matched against the message's resolved mentions, not guessed. */
function mentionPattern(names: readonly string[]): RegExp | null {
  if (names.length === 0) return null;
  // Longest first so "@Rahul Menon" wins over "@Rahul".
  const escaped = [...names]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`@(?:${escaped.join('|')})`, 'g');
}

interface Segment {
  kind: 'text' | 'link' | 'mention';
  value: string;
}

/**
 * Split raw content into typed segments. Pure and exported so the split logic can be
 * tested without rendering — the security property is "no segment ever becomes
 * markup", which is easiest to assert on the segments themselves.
 */
export function segmentContent(content: string, mentionNames: readonly string[]): Segment[] {
  const matches: { start: number; end: number; kind: 'link' | 'mention' }[] = [];

  for (const m of content.matchAll(URL_PATTERN)) {
    if (m.index !== undefined) matches.push({ start: m.index, end: m.index + m[0].length, kind: 'link' });
  }
  const mentions = mentionPattern(mentionNames);
  if (mentions) {
    for (const m of content.matchAll(mentions)) {
      if (m.index === undefined) continue;
      const start = m.index;
      const end = start + m[0].length;
      // A mention inside a URL is part of the URL, not a mention.
      if (matches.some((x) => x.kind === 'link' && start >= x.start && start < x.end)) continue;
      matches.push({ start, end, kind: 'mention' });
    }
  }

  matches.sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue; // overlapping — first match wins
    if (m.start > cursor) segments.push({ kind: 'text', value: content.slice(cursor, m.start) });
    segments.push({ kind: m.kind, value: content.slice(m.start, m.end) });
    cursor = m.end;
  }
  if (cursor < content.length) segments.push({ kind: 'text', value: content.slice(cursor) });
  return segments;
}

export function MessageContent({
  content,
  mentionNames,
  highlightNames,
}: {
  content: string;
  /** Every name mentioned in this message, from the server's resolution. */
  mentionNames: readonly string[];
  /** The subset to tint gold — normally just the current user (UIUX §16). */
  highlightNames: readonly string[];
}) {
  const segments = segmentContent(content, mentionNames);
  const highlighted = new Set(highlightNames.map((n) => `@${n}`.toLowerCase()));

  return (
    <span className="whitespace-pre-wrap break-words">
      {segments.map((seg, i): ReactNode => {
        if (seg.kind === 'link') {
          return (
            <a
              key={i}
              href={seg.value}
              target="_blank"
              // noopener: without it the opened page can reach back via window.opener.
              rel="noopener noreferrer"
              className="underline"
              style={{ color: 'var(--accent-gold)' }}
            >
              {seg.value}
            </a>
          );
        }
        if (seg.kind === 'mention') {
          const isMe = highlighted.has(seg.value.toLowerCase());
          return (
            <mark
              key={i}
              data-testid={isMe ? 'mention-self' : 'mention'}
              className="rounded px-0.5"
              style={{
                background: isMe ? 'color-mix(in srgb, var(--accent-gold) 25%, transparent)' : 'transparent',
                color: 'var(--accent-gold)',
                fontWeight: 500,
              }}
            >
              {seg.value}
            </mark>
          );
        }
        // Plain text as a React child — escaped by React, never parsed as markup.
        return <Fragment key={i}>{seg.value}</Fragment>;
      })}
    </span>
  );
}
