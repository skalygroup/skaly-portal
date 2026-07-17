import { describe, expect, test } from 'vitest';

import { applyPatchToSlots, buildCtaPatch, buildFieldPatch, ctaLabel, periodBounds, replaceSlot } from './slot-actions';

import type { Slot } from './types';

// Pure-logic suite (repo pattern: no component-test infra — DOM behaviour is
// covered by the Step 8 Playwright spec).

const slot = (over: Partial<Slot> = {}): Slot => ({
  id: 's1',
  period: '2026-07',
  clientId: 'c1',
  clientName: 'Client',
  slotIndex: 1,
  slotStatus: 'Unset',
  slotDate: null,
  piecesExpected: 3,
  freelancerId: null,
  freelancerName: null,
  updatedAt: null,
  updatedBy: null,
  ...over,
});

const draft = { slotDate: '2026-07-15', piecesExpected: 3, freelancerId: 'f1' };

describe('buildCtaPatch — the lifecycle PATCH bodies (APPFLOW §6)', () => {
  test('Unset → Schedule sends the full draft; NEVER a version field', () => {
    const patch = buildCtaPatch(slot(), draft);
    expect(patch).toEqual({
      slotStatus: 'Scheduled',
      slotDate: '2026-07-15',
      piecesExpected: 3,
      freelancerId: 'f1',
    });
    expect(patch).not.toHaveProperty('version'); // slots are last-write-wins
  });

  test('Scheduled → Confirm sends the status plus only changed fields', () => {
    const s = slot({ slotStatus: 'Scheduled', slotDate: '2026-07-15', freelancerId: 'f1' });
    // Nothing changed → just the transition.
    expect(buildCtaPatch(s, draft)).toEqual({ slotStatus: 'Confirmed' });
    // Date changed → transition + new date.
    expect(buildCtaPatch(s, { ...draft, slotDate: '2026-07-20' })).toEqual({
      slotStatus: 'Confirmed',
      slotDate: '2026-07-20',
    });
  });

  test('Confirmed → Complete sends only the status', () => {
    const s = slot({ slotStatus: 'Confirmed', slotDate: '2026-07-15' });
    expect(buildCtaPatch(s, draft)).toEqual({ slotStatus: 'Completed' });
  });
});

describe('buildFieldPatch — reschedule / same-state edits', () => {
  test('emits only genuinely changed fields (an unchanged draft is empty)', () => {
    const s = slot({ slotStatus: 'Confirmed', slotDate: '2026-07-15', freelancerId: 'f1' });
    expect(buildFieldPatch(s, draft)).toEqual({});
    expect(buildFieldPatch(s, { ...draft, piecesExpected: 5, freelancerId: null })).toEqual({
      piecesExpected: 5,
      freelancerId: null,
    });
  });
});

describe('cache helpers — optimistic write + server replace', () => {
  test('applyPatchToSlots merges into the one slot; replaceSlot swaps the returned row', () => {
    const a = slot({ id: 'a' });
    const b = slot({ id: 'b' });
    const patched = applyPatchToSlots([a, b], 'a', { slotStatus: 'Scheduled', slotDate: '2026-07-10' });
    expect(patched[0]).toMatchObject({ id: 'a', slotStatus: 'Scheduled', slotDate: '2026-07-10' });
    expect(patched[1]).toEqual(b); // untouched

    const server = slot({ id: 'a', slotStatus: 'Confirmed', slotDate: '2026-07-10' });
    const replaced = replaceSlot(patched, server);
    expect(replaced[0]).toEqual(server);
  });
});

describe('periodBounds + ctaLabel', () => {
  test('date picker is constrained to the viewed period', () => {
    expect(periodBounds('2026-07')).toEqual({ min: '2026-07-01', max: '2026-07-31' });
    expect(periodBounds('2026-02')).toEqual({ min: '2026-02-01', max: '2026-02-28' });
  });

  test('CTA per state; Completed has none (reset is the only way back)', () => {
    expect(ctaLabel('Unset')).toBe('Schedule');
    expect(ctaLabel('Scheduled')).toBe('Confirm');
    expect(ctaLabel('Confirmed')).toBe('Mark as Completed');
    expect(ctaLabel('Completed')).toBeNull();
  });
});
