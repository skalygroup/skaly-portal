import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, test, expect } from 'vitest';

import { MessageContent, segmentContent } from './message-content';

/**
 * NFR §4.3 — the XSS pass (Sprint 10 STEP 11).
 *
 * The point of these tests is NOT that a sanitiser stripped something. It is that no
 * HTML string is ever constructed, so there is nothing to sanitise: React escapes text
 * children by construction, and the linkifier emits ELEMENTS.
 *
 * That is why the payloads below are asserted to appear as LITERAL TEXT rather than to
 * be absent. An assertion that `<script>` was removed would also pass if the whole
 * message silently vanished; asserting the user still sees exactly what was typed is
 * the stronger claim, and the one that matches "store raw, escape at render".
 */
afterEach(cleanup);

const render1 = (content: string, mentions: string[] = [], highlight: string[] = []) =>
  render(<MessageContent content={content} mentionNames={mentions} highlightNames={highlight} />);

describe('⭐ hostile content renders as literal text', () => {
  test('a <script> tag is text, not a script', () => {
    const payload = '<script>alert("xss")</script>';
    const { container } = render1(payload);

    expect(container.textContent).toBe(payload);
    // The decisive assertion: no element was created from the payload.
    expect(container.querySelector('script')).toBeNull();
  });

  test('an <img onerror=…> is text, not an image', () => {
    const payload = '<img src=x onerror="alert(1)">';
    const { container } = render1(payload);

    expect(container.textContent).toBe(payload);
    expect(container.querySelector('img')).toBeNull();
  });

  test('an inline event handler on a div stays inert', () => {
    const payload = '<div onclick="steal()">click me</div>';
    const { container } = render1(payload);

    expect(container.textContent).toBe(payload);
    expect(container.querySelector('div[onclick]')).toBeNull();
  });

  test('an svg/onload payload is inert', () => {
    const payload = '<svg/onload=alert(1)>';
    const { container } = render1(payload);
    expect(container.textContent).toBe(payload);
    expect(container.querySelector('svg')).toBeNull();
  });

  test('entities are not double-escaped — the user sees what they typed', () => {
    const payload = 'a < b && c > d';
    const { container } = render1(payload);
    // Round-tripping through a sanitiser is where &amp;amp; comes from.
    expect(container.textContent).toBe(payload);
  });
});

describe('the linkifier emits elements, never markup', () => {
  test('an http link becomes a real anchor with the safe rel', () => {
    render1('see https://skalygroup.com/docs for details');

    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://skalygroup.com/docs');
    // Without noopener the opened page can reach back through window.opener.
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  test('⭐ a javascript: URL is NOT linkified — the classic bypass', () => {
    const payload = 'javascript:alert(document.cookie)';
    const { container } = render1(payload);

    // Only http/https are matched, so this stays plain text with no href to click.
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe(payload);
  });

  test('a data: URL is not linkified either', () => {
    const { container } = render1('data:text/html;base64,PHNjcmlwdD4=');
    expect(container.querySelector('a')).toBeNull();
  });

  test('text around a link is preserved exactly', () => {
    const { container } = render1('before https://example.com after');
    expect(container.textContent).toBe('before https://example.com after');
  });
});

describe('mention highlighting', () => {
  test("the current user's mention is tinted; others are not", () => {
    render1('@Rahul Menon and @Chat Admin please look', ['Rahul Menon', 'Chat Admin'], ['Rahul Menon']);

    expect(screen.getByTestId('mention-self').textContent).toBe('@Rahul Menon');
    expect(screen.getByTestId('mention').textContent).toBe('@Chat Admin');
  });

  test('a longer name wins over a shorter one it starts with', () => {
    render1('@Rahul Menon here', ['Rahul', 'Rahul Menon'], []);
    expect(screen.getByTestId('mention').textContent).toBe('@Rahul Menon');
  });

  test('an @ inside a URL is not treated as a mention', () => {
    render1('https://x.com/@rahul is the profile', ['rahul'], []);
    expect(screen.queryByTestId('mention')).toBeNull();
    expect(screen.getByRole('link')).toBeDefined();
  });

  test('a mention whose name contains regex metacharacters does not break the matcher', () => {
    // A name like "A. B (Ops)" would blow up an unescaped RegExp.
    const { container } = render1('@A. B (Ops) hello', ['A. B (Ops)'], []);
    expect(container.textContent).toBe('@A. B (Ops) hello');
  });
});

describe('segmentContent — the split, tested without rendering', () => {
  test('plain text is one text segment', () => {
    expect(segmentContent('just words', [])).toEqual([{ kind: 'text', value: 'just words' }]);
  });

  test('a link splits into text/link/text', () => {
    expect(segmentContent('a https://x.com b', [])).toEqual([
      { kind: 'text', value: 'a ' },
      { kind: 'link', value: 'https://x.com' },
      { kind: 'text', value: ' b' },
    ]);
  });

  test('every segment is a plain string — nothing is ever markup', () => {
    const segments = segmentContent('<b>hi</b> https://x.com @Me', ['Me']);
    for (const s of segments) expect(typeof s.value).toBe('string');
    // Reassembling the segments returns the ORIGINAL content, unmodified. If any step
    // rewrote the text, this is where it would show.
    expect(segments.map((s) => s.value).join('')).toBe('<b>hi</b> https://x.com @Me');
  });
});
