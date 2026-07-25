import { describe, test, expect } from 'vitest';

import {
  buildSummary,
  formatCalendarDate,
  isAffirmative,
  isExpired,
  makePending,
  resolveTurn2,
  PENDING_TTL_MS,
} from '../../src/lib/bot/confirmation.js';

import type {
  ConfirmationSummary,
  PendingConfirmation,
  SummarySpec,
} from '../../src/lib/bot/confirmation.js';

/**
 * The confirmation state machine (ADR-014). Pure logic — no Redis, no Anthropic,
 * no services. Every branch of `resolveTurn2` is asserted: this is the gate
 * between a probabilistic system and an irreversible write, so "probably fine" is
 * not a coverage level.
 */
const NOW = new Date('2026-07-25T10:00:00.000Z');
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

const SUMMARY: ConfirmationSummary = {
  action: 'Mark task as Done',
  entity: 'Task',
  target: 'Edit the Naaz Furniture reel',
  changes: [{ field: 'Status', from: 'In Progress', to: 'Done' }],
};

function pendingAt(offsetMs = 0, confirmationId = ID): PendingConfirmation {
  return makePending({
    confirmationId,
    toolName: 'update_task_status',
    input: { taskId: 'abc', status: 'Done' },
    summary: SUMMARY,
    now: new Date(NOW.getTime() + offsetMs),
  });
}

/** A record created 6 minutes ago — past the 5-minute window. */
const EXPIRED = pendingAt(-6 * 60 * 1000);
const FRESH = pendingAt();

describe('isAffirmative', () => {
  const allowed = [
    'yes',
    'y',
    'yeah',
    'yep',
    'confirm',
    'confirmed',
    'go ahead',
    'do it',
    'proceed',
    'ok',
    'okay',
  ];

  test('every allowlist entry passes, in any case and with trailing punctuation', () => {
    for (const word of allowed) {
      expect(isAffirmative(word), word).toBe(true);
      expect(isAffirmative(word.toUpperCase()), word.toUpperCase()).toBe(true);
      expect(isAffirmative(`${word}.`), `${word}.`).toBe(true);
      expect(isAffirmative(`${word}!`), `${word}!`).toBe(true);
      expect(isAffirmative(`  ${word}  `), `padded ${word}`).toBe(true);
    }
  });

  test('a qualified yes is NOT consent — the load-bearing case (ADR-014 §1)', () => {
    // The user is asking for something the summary does not say. Treating this as
    // consent would execute Thursday's deadline after they asked for Friday.
    expect(isAffirmative('yes, but make it Friday')).toBe(false);
    expect(isAffirmative('yes but change the client')).toBe(false);
    expect(isAffirmative('yes please, and also assign Rahul')).toBe(false);
  });

  test('refusals, hedges and empties are not consent', () => {
    for (const text of ['no', 'nope', 'maybe', 'sure why not', 'i think so', '', '   ', 'yeahhh', 'okay?']) {
      expect(isAffirmative(text), JSON.stringify(text)).toBe(false);
    }
  });
});

describe('isExpired', () => {
  test('inside the 5-minute window is live; past it is expired', () => {
    expect(isExpired(FRESH, NOW)).toBe(false);
    expect(isExpired(FRESH, new Date(NOW.getTime() + PENDING_TTL_MS - 1000))).toBe(false);
    expect(isExpired(FRESH, new Date(NOW.getTime() + PENDING_TTL_MS))).toBe(true);
    expect(isExpired(EXPIRED, NOW)).toBe(true);
  });
});

describe('resolveTurn2 — structured decisions win outright', () => {
  test('confirm with the matching id → execute', () => {
    expect(resolveTurn2(FRESH, { content: 'Yes, go ahead', decision: 'confirm', confirmationId: ID }, NOW)).toEqual({
      kind: 'execute',
      pending: FRESH,
    });
  });

  test('cancel → cancelled', () => {
    expect(resolveTurn2(FRESH, { content: 'Cancel', decision: 'cancel', confirmationId: ID }, NOW)).toEqual({
      kind: 'cancelled',
    });
  });

  test('a mismatched confirmationId → stale_id, never execute', () => {
    expect(
      resolveTurn2(FRESH, { content: 'Yes', decision: 'confirm', confirmationId: OTHER_ID }, NOW),
    ).toEqual({ kind: 'stale_id' });
  });

  test('a decision with no pending record → stale_id', () => {
    expect(resolveTurn2(null, { content: 'Yes', decision: 'confirm', confirmationId: ID }, NOW)).toEqual({
      kind: 'stale_id',
    });
  });

  test('a decision with no confirmationId at all → stale_id (the id is not optional in practice)', () => {
    expect(resolveTurn2(FRESH, { content: 'Yes', decision: 'confirm' }, NOW)).toEqual({ kind: 'stale_id' });
  });

  test('confirm on an expired record → expired, not execute', () => {
    expect(
      resolveTurn2(EXPIRED, { content: 'Yes', decision: 'confirm', confirmationId: ID }, NOW),
    ).toEqual({ kind: 'expired' });
  });

  test('cancel on an expired record → cancelled ("no changes made" is true either way)', () => {
    expect(
      resolveTurn2(EXPIRED, { content: 'Cancel', decision: 'cancel', confirmationId: ID }, NOW),
    ).toEqual({ kind: 'cancelled' });
  });

  test('a stale [Confirm] does not execute whatever is pending NOW', () => {
    // The user clicked Confirm on card A; by the time it lands, card B is pending.
    const cardB = pendingAt(0, OTHER_ID);
    expect(
      resolveTurn2(cardB, { content: 'Yes', decision: 'confirm', confirmationId: ID }, NOW),
    ).toEqual({ kind: 'stale_id' });
  });
});

describe('resolveTurn2 — typed text', () => {
  test('a pending record + an exact affirmative → execute', () => {
    expect(resolveTurn2(FRESH, { content: 'yes' }, NOW)).toEqual({ kind: 'execute', pending: FRESH });
  });

  test('a pending record + an expired window + affirmative → expired', () => {
    expect(resolveTurn2(EXPIRED, { content: 'yes' }, NOW)).toEqual({ kind: 'expired' });
  });

  test('no pending record + "yes" → none (a bare yes never executes anything)', () => {
    expect(resolveTurn2(null, { content: 'yes' }, NOW)).toEqual({ kind: 'none' });
  });

  test('a pending record + an unrelated message → none', () => {
    expect(resolveTurn2(FRESH, { content: 'what are my overdue tasks?' }, NOW)).toEqual({ kind: 'none' });
  });

  test('a pending record + a qualified yes → none, so it re-plans as a fresh turn', () => {
    expect(resolveTurn2(FRESH, { content: 'yes, but make it Friday' }, NOW)).toEqual({ kind: 'none' });
  });

  test('a pending record + "no" → none', () => {
    expect(resolveTurn2(FRESH, { content: 'no' }, NOW)).toEqual({ kind: 'none' });
  });
});

describe('makePending', () => {
  test('expires exactly 5 minutes after turn 1', () => {
    expect(Date.parse(FRESH.expiresAt) - NOW.getTime()).toBe(PENDING_TTL_MS);
  });

  test('carries expectedVersion only when given one (ADR-008: unversioned tools send none)', () => {
    expect(FRESH.expectedVersion).toBeUndefined();
    const versioned = makePending({
      confirmationId: ID,
      toolName: 'update_pipeline_stage',
      input: { pipelineId: 'p1', stage: 'posted' },
      expectedVersion: 4,
      summary: SUMMARY,
      now: NOW,
    });
    expect(versioned.expectedVersion).toBe(4);
  });
});

describe('formatCalendarDate', () => {
  test("'YYYY-MM-DD' → 'd MMM yyyy' with no timezone shift", () => {
    // The whole point: no Date, no Intl, no zone — so no off-by-one either way.
    expect(formatCalendarDate('2026-07-15')).toBe('15 Jul 2026');
    expect(formatCalendarDate('2026-01-01')).toBe('1 Jan 2026');
    expect(formatCalendarDate('2026-12-31')).toBe('31 Dec 2026');
  });

  test('passes through anything that is not a calendar date', () => {
    expect(formatCalendarDate('Done')).toBe('Done');
    expect(formatCalendarDate('2026-13-01')).toBe('2026-13-01'); // month 13 → no name
  });
});

describe('buildSummary', () => {
  const spec: SummarySpec = {
    entity: 'Task',
    action: (input) => `Mark task as ${String(input.status)}`,
    target: (state) => String(state.description),
    period: (_input, state) => String(state.period),
    changes: [
      { field: 'Status', from: (s) => s.status, to: (i) => i.status },
      { field: 'Deadline', from: (s) => s.deadline, to: (i) => i.deadline },
    ],
  };

  test('renders action/target/period and the field diff from state + input', () => {
    const summary = buildSummary(
      spec,
      { status: 'Done', deadline: '2026-08-14' },
      { description: 'Edit the Naaz Furniture reel', period: '2026-07', status: 'In Progress', deadline: null },
    );
    expect(summary).toEqual({
      action: 'Mark task as Done',
      entity: 'Task',
      target: 'Edit the Naaz Furniture reel',
      period: '2026-07',
      changes: [
        { field: 'Status', from: 'In Progress', to: 'Done' },
        // null renders as an em dash, and the date as a human date.
        { field: 'Deadline', from: '—', to: '14 Aug 2026' },
      ],
    });
  });

  test('null, undefined and empty string all render as an em dash — never a bare null', () => {
    const summary = buildSummary(
      {
        entity: 'Task',
        action: () => 'Update task',
        target: () => 'A task',
        changes: [
          { field: 'Null', from: () => null, to: () => null },
          { field: 'Undefined', from: () => undefined, to: () => undefined },
          { field: 'Empty', from: () => '', to: () => '' },
        ],
      },
      {},
      {},
    );
    expect(summary.changes.every((c) => c.from === '—' && c.to === '—')).toBe(true);
  });

  test('booleans read as Yes/No', () => {
    const summary = buildSummary(
      {
        entity: 'Client',
        action: () => 'Add client',
        target: () => 'Naaz Furniture',
        changes: [{ field: 'Internal', from: () => false, to: () => true }],
      },
      {},
      {},
    );
    expect(summary.changes[0]).toEqual({ field: 'Internal', from: 'No', to: 'Yes' });
  });

  test('period is omitted when the spec has no period fn', () => {
    const summary = buildSummary(
      { entity: 'Client', action: () => 'Add client', target: () => 'X', changes: [] },
      {},
      {},
    );
    expect(summary.period).toBeUndefined();
  });
});
