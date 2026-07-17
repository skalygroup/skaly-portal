/** Wire shapes of GET /v1/shoot-planner (07-API-CONTRACT §8). */

export interface Slot {
  id: string;
  period: string;
  clientId: string;
  clientName: string;
  slotIndex: number;
  slotStatus: 'Unset' | 'Scheduled' | 'Confirmed' | 'Completed' | string;
  slotDate: string | null;
  piecesExpected: number;
  freelancerId: string | null;
  freelancerName: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ShootClient {
  id: string;
  name: string;
  shootSlotsPerMonth: number;
  piecesPerVisit: number;
}

export interface ShootGridData {
  slots: Slot[];
  clients: ShootClient[];
}
