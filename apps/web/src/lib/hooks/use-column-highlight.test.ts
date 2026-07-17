import { beforeEach, describe, expect, test } from 'vitest';

import { useColumnHighlightStore } from './use-column-highlight';

// §4.4 state rules, incl. the failure path: a pending save holds the highlight
// through blur; only an explicit clear (success or the 1.5s failure timer)
// releases it.

const store = () => useColumnHighlightStore.getState();

beforeEach(() => {
  useColumnHighlightStore.setState({ activeColumnId: null, pending: new Set() });
});

describe('gold column highlight store (UIUX §4.4)', () => {
  test('focus sets the column; blur clears it when idle', () => {
    store().setActiveColumn('slot-2');
    expect(store().activeColumnId).toBe('slot-2');
    store().clearColumn('slot-2');
    expect(store().activeColumnId).toBeNull();
  });

  test('rule 2/4 (failure path): an in-flight save holds the highlight through blur', () => {
    store().setActiveColumn('slot-2');
    store().markPending('slot-2'); // save fired
    store().clearColumn('slot-2'); // user blurred / clicked away
    expect(store().activeColumnId).toBe('slot-2'); // still highlighted

    // The failure timer clears pending, then the column.
    store().clearPending('slot-2');
    store().setActiveColumn(null);
    expect(store().activeColumnId).toBeNull();
    expect(store().pending.size).toBe(0);
  });
});
