import { describe, expect, test } from 'vitest';

import { diffLines } from './audit-diff';

/**
 * The diff reducer, tested as a pure function because that is the only part of
 * it with an opinion. The distinction that earns the test is ABSENT vs NULL: a
 * key that was removed and a key that was set to null are different events, and
 * collapsing them (`?? null`, or a truthiness check) makes a "cleared the field"
 * audit entry indistinguishable from a schema change.
 */
describe('diffLines', () => {
  test('shows only the keys that changed', () => {
    expect(diffLines({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual([
      { key: 'b', before: '2', after: '3' },
    ]);
  });

  test('an INSERT has no old side, so every key is the change', () => {
    expect(diffLines(null, { name: 'Asha', role: 'admin' })).toEqual([
      { key: 'name', before: undefined, after: 'Asha' },
      { key: 'role', before: undefined, after: 'admin' },
    ]);
  });

  test('a DELETE has no new side', () => {
    expect(diffLines({ name: 'Asha' }, null)).toEqual([
      { key: 'name', before: 'Asha', after: undefined },
    ]);
  });

  test('⭐ set-to-null is not the same as removed', () => {
    const cleared = diffLines({ note: 'x' }, { note: null });
    const removed = diffLines({ note: 'x' }, {});

    expect(cleared).toEqual([{ key: 'note', before: 'x', after: 'null' }]);
    expect(removed).toEqual([{ key: 'note', before: 'x', after: undefined }]);
    expect(cleared).not.toEqual(removed);
  });

  test('strings render bare; everything else is JSON', () => {
    expect(diffLines({}, { s: 'plain', n: 4, b: false, o: { k: 1 } })).toEqual([
      { key: 'b', before: undefined, after: 'false' },
      { key: 'n', before: undefined, after: '4' },
      { key: 'o', before: undefined, after: '{"k":1}' },
      { key: 's', before: undefined, after: 'plain' },
    ]);
  });

  test('an unchanged entry yields nothing rather than every key', () => {
    expect(diffLines({ a: 1 }, { a: 1 })).toEqual([]);
  });

  test('non-object audit values degrade to empty, not a crash', () => {
    // `old_value` is JSONB and nothing stops a caller writing a scalar.
    expect(diffLines('oops', 42)).toEqual([]);
  });
});
