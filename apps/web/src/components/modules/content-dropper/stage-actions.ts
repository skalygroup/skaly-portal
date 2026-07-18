/**
 * Pure Content Dropper stage logic — the sequence pre-check, the optimistic
 * stage stamp, and the cache transforms. Kept out of the component so it can be
 * unit-tested directly (mirrors shoot-planner/slot-actions.ts). The server is
 * the real gate; the client pre-check is UX (APPFLOW §7).
 */
import type { PipelineRow, PipelineStatus, Stage } from './types';

const STAGE_FIELD: Record<Stage, 'rawReceivedAt' | 'finalsReadyAt' | 'postedAt'> = {
  raw: 'rawReceivedAt',
  finals: 'finalsReadyAt',
  posted: 'postedAt',
};

export type SequenceCheck = { ok: true } | { ok: false; message: string };

/** Client-side sequence pre-check: finals needs raw, posted needs finals. */
export function checkSequence(
  row: Pick<PipelineRow, 'rawReceivedAt' | 'finalsReadyAt'>,
  stage: Stage,
): SequenceCheck {
  if (stage === 'finals' && !row.rawReceivedAt) return { ok: false, message: 'Mark RAW first' };
  if (stage === 'posted' && !row.finalsReadyAt) return { ok: false, message: 'Mark Finals first' };
  return { ok: true };
}

export function deriveStatus(
  r: Pick<PipelineRow, 'rawReceivedAt' | 'finalsReadyAt' | 'postedAt'>,
): PipelineStatus {
  if (r.postedAt) return 'Posted';
  if (r.finalsReadyAt) return 'Review';
  if (r.rawReceivedAt) return 'Editing';
  return 'Awaiting';
}

/** Optimistic: stamp the marked stage now + recompute derived status/stagesComplete. */
export function withStage(row: PipelineRow, stage: Stage): PipelineRow {
  const next = { ...row, [STAGE_FIELD[stage]]: new Date().toISOString() };
  next.stagesComplete = [next.rawReceivedAt, next.finalsReadyAt, next.postedAt].filter(Boolean).length;
  next.status = deriveStatus(next);
  return next;
}

/** Apply an optimistic stage mark to the matching row in a grid list. */
export function applyOptimisticStage(rows: PipelineRow[], id: string, stage: Stage): PipelineRow[] {
  return rows.map((r) => (r.id === id ? withStage(r, stage) : r));
}

/** Replace a row with the authoritative one returned by the server. */
export function replaceRow(rows: PipelineRow[], returned: PipelineRow): PipelineRow[] {
  return rows.map((r) => (r.id === returned.id ? returned : r));
}
