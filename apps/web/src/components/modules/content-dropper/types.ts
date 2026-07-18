/**
 * Content Dropper wire types (07-API-CONTRACT §9). Mirrors the API's PipelineDTO
 * — status + stagesComplete are DERIVED server-side (no stored column), so the
 * frontend just renders them.
 */
export type PipelineStatus = 'Awaiting' | 'Editing' | 'Review' | 'Posted';

export interface PipelineUpdatedBy {
  staffId: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface PipelineRow {
  id: string;
  period: string;
  clientId: string;
  clientName: string;
  visitType: string | null;
  lastShootDate: string | null; // YYYY-MM-DD
  rawReceivedAt: string | null; // ISO timestamp
  finalsReadyAt: string | null; // ISO timestamp
  postedAt: string | null; // ISO timestamp
  comingShootDate: string | null; // YYYY-MM-DD
  comingShootSource: string | null; // 'trigger' | 'manual' | null
  version: number;
  updatedBy: PipelineUpdatedBy | null;
  status: PipelineStatus;
  stagesComplete: number; // 0–3
}

/** The three manual stages and their timestamp fields (reconciliation #2). */
export const STAGES = [
  { key: 'raw', label: 'RAW', field: 'rawReceivedAt' },
  { key: 'finals', label: 'Finals', field: 'finalsReadyAt' },
  { key: 'posted', label: 'Posted', field: 'postedAt' },
] as const satisfies ReadonlyArray<{ key: string; label: string; field: keyof PipelineRow }>;

export type Stage = (typeof STAGES)[number]['key'];
