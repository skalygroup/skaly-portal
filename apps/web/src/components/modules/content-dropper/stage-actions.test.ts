// @vitest-environment node
// Logic test: the pure Content Dropper stage helpers — the client-side sequence
// pre-check (APPFLOW §7), the optimistic stamp + derived recompute, and the
// cache transforms. The component wires these; the render-level interactions
// (toasts, cross-module invalidation) are covered by the Step 8 Playwright E2E.
import { describe, expect, it } from 'vitest';

import { applyOptimisticStage, checkSequence, deriveStatus, replaceRow, withStage } from './stage-actions';

import type { PipelineRow } from './types';

function row(over: Partial<PipelineRow> = {}): PipelineRow {
  return {
    id: 'p1',
    period: '2026-07',
    clientId: 'c1',
    clientName: 'Acme',
    visitType: null,
    lastShootDate: null,
    rawReceivedAt: null,
    finalsReadyAt: null,
    postedAt: null,
    comingShootDate: null,
    comingShootSource: null,
    version: 1,
    updatedBy: null,
    status: 'Awaiting',
    stagesComplete: 0,
    ...over,
  };
}

describe('checkSequence (client-side pre-check)', () => {
  it('blocks finals when raw is not set', () => {
    expect(checkSequence(row(), 'finals')).toEqual({ ok: false, message: 'Mark RAW first' });
  });

  it('blocks posted when finals is not set', () => {
    expect(checkSequence(row({ rawReceivedAt: 't' }), 'posted')).toEqual({ ok: false, message: 'Mark Finals first' });
  });

  it('allows raw unconditionally, and finals/posted once the prerequisite is set', () => {
    expect(checkSequence(row(), 'raw').ok).toBe(true);
    expect(checkSequence(row({ rawReceivedAt: 't' }), 'finals').ok).toBe(true);
    expect(checkSequence(row({ rawReceivedAt: 't', finalsReadyAt: 't' }), 'posted').ok).toBe(true);
  });
});

describe('deriveStatus', () => {
  it('reflects the highest set stage', () => {
    expect(deriveStatus(row())).toBe('Awaiting');
    expect(deriveStatus(row({ rawReceivedAt: 't' }))).toBe('Editing');
    expect(deriveStatus(row({ rawReceivedAt: 't', finalsReadyAt: 't' }))).toBe('Review');
    expect(deriveStatus(row({ rawReceivedAt: 't', finalsReadyAt: 't', postedAt: 't' }))).toBe('Posted');
  });
});

describe('withStage (optimistic stamp)', () => {
  it('stamps the marked stage and recomputes status + stagesComplete', () => {
    const next = withStage(row(), 'raw');
    expect(next.rawReceivedAt).not.toBeNull();
    expect(next.status).toBe('Editing');
    expect(next.stagesComplete).toBe(1);
  });

  it('does not mutate the source row', () => {
    const original = row();
    withStage(original, 'raw');
    expect(original.rawReceivedAt).toBeNull();
    expect(original.stagesComplete).toBe(0);
  });
});

describe('cache transforms', () => {
  it('applyOptimisticStage only touches the matching row', () => {
    const rows = [row({ id: 'p1', clientId: 'c1' }), row({ id: 'p2', clientId: 'c2' })];
    const next = applyOptimisticStage(rows, 'p1', 'raw');
    expect(next[0]!.rawReceivedAt).not.toBeNull();
    expect(next[1]!.rawReceivedAt).toBeNull();
  });

  it('replaceRow swaps in the authoritative row (fresh version)', () => {
    const rows = [row({ id: 'p1', version: 1 })];
    const returned = row({ id: 'p1', version: 2, rawReceivedAt: 't', status: 'Editing', stagesComplete: 1 });
    const next = replaceRow(rows, returned);
    expect(next[0]!.version).toBe(2);
    expect(next[0]).toBe(returned);
  });
});
