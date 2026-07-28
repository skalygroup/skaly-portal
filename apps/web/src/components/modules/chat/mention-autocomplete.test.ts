import { describe, test, expect } from 'vitest';

import { applyMention, findMentionQuery, matchStaff } from './mention-autocomplete';

/**
 * The @-mention autocomplete's string arithmetic (Sprint 10 STEP 10).
 *
 * Kept out of the component because every interesting case here is about WHERE the
 * token starts and WHERE the caret lands — both far easier to get wrong than to test,
 * and both invisible in a rendering test that only checks a list appeared.
 */
const staff = [
  { id: '1', name: 'Rahul Menon' },
  { id: '2', name: 'Rahul Iyer' },
  { id: '3', name: 'Chitra Rao' },
  { id: '4', name: 'Chat Admin' },
];

describe('findMentionQuery', () => {
  test('finds the token the caret is inside', () => {
    const text = 'hey @Rah';
    expect(findMentionQuery(text, text.length)).toEqual({ start: 4, query: 'Rah' });
  });

  test('an empty @ opens the list with no filter', () => {
    expect(findMentionQuery('hey @', 5)).toEqual({ start: 4, query: '' });
  });

  test('⭐ allows ONE interior space so two-word names are reachable', () => {
    const text = '@Rahul Men';
    // Without this, "Rahul Menon" could never be completed — and two-word display
    // names are the norm here, not the exception.
    expect(findMentionQuery(text, text.length)).toEqual({ start: 0, query: 'Rahul Men' });
  });

  test('a SECOND space closes the token', () => {
    const text = '@Rahul Menon please look';
    // Otherwise an entire sentence after an "@" is treated as a search.
    expect(findMentionQuery(text, text.length)).toBeNull();
  });

  test('⭐ an @ mid-word is not a mention — that is an email', () => {
    const text = 'mail rahul@skalygroup.com';
    expect(findMentionQuery(text, text.length)).toBeNull();
  });

  test('a newline closes the token', () => {
    const text = '@Rahul\nnext line';
    expect(findMentionQuery(text, text.length)).toBeNull();
  });

  test('no @ at all is null', () => {
    expect(findMentionQuery('plain text', 10)).toBeNull();
  });

  test('the token is found relative to the CARET, not the end of the text', () => {
    const text = '@Rah and more text after';
    // Caret sits just after "@Rah"; the trailing prose must not be swallowed.
    expect(findMentionQuery(text, 4)).toEqual({ start: 0, query: 'Rah' });
  });
});

describe('matchStaff', () => {
  test('prefix matches come before contains matches', () => {
    const hits = matchStaff(staff, 'ra');
    // "Rahul …" starts with "ra"; "Chitra Rao" only contains it.
    expect(hits[0]!.name.toLowerCase().startsWith('ra')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(matchStaff(staff, 'RAHUL').map((s) => s.name)).toEqual(['Rahul Menon', 'Rahul Iyer']);
  });

  test('matches across a space', () => {
    expect(matchStaff(staff, 'rahul m').map((s) => s.name)).toEqual(['Rahul Menon']);
  });

  test('an empty query offers everyone, capped', () => {
    expect(matchStaff(staff, '', 2)).toHaveLength(2);
  });

  test('no match is empty, not everyone', () => {
    expect(matchStaff(staff, 'zzz')).toEqual([]);
  });
});

describe('applyMention', () => {
  test('replaces the token and appends a trailing space', () => {
    const text = 'hey @Rah';
    const token = findMentionQuery(text, text.length)!;
    // The trailing space closes the token so the list does not immediately reopen on
    // the name just chosen.
    expect(applyMention(text, token, 'Rahul Menon')).toEqual({
      text: 'hey @Rahul Menon ',
      caret: 'hey @Rahul Menon '.length,
    });
  });

  test('⭐ preserves text AFTER the caret', () => {
    const text = 'hey @Rah please look';
    const token = findMentionQuery(text, 8)!;
    // Replacing to the end of the string is the easy bug — it would eat the rest of
    // the sentence the moment someone completes a mention mid-message.
    expect(applyMention(text, token, 'Rahul Menon').text).toBe('hey @Rahul Menon  please look');
  });

  test('the caret lands after the inserted name, not at the end of the message', () => {
    const text = '@Rah tail';
    const token = findMentionQuery(text, 4)!;
    const out = applyMention(text, token, 'Rahul Menon');
    expect(out.caret).toBe('@Rahul Menon '.length);
    expect(out.text.slice(0, out.caret)).toBe('@Rahul Menon ');
  });

  test('works at the very start of the message', () => {
    const token = findMentionQuery('@Ch', 3)!;
    expect(applyMention('@Ch', token, 'Chat Admin').text).toBe('@Chat Admin ');
  });
});
