/**
 * Wire shapes for GET/PATCH /v1/attendance (07-API-CONTRACT §5). Field names
 * are the backend DTO's camelCase — `dayType` is the state column (day_type),
 * never `status`.
 */

export type DayType = 'working' | 'sunday' | 'holiday';

export interface AttendanceLog {
  id: string;
  period: string;
  staffId: string;
  date: string; // 'YYYY-MM-DD'
  dayType: DayType;
  present: boolean;
  workLog: string | null;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface HolidayItem {
  id: string;
  date: string; // 'YYYY-MM-DD'
  name: string;
}

export interface StaffColumn {
  id: string;
  name: string;
  role: string;
  avatarUrl: string | null;
}

export interface AttendanceGridData {
  attendanceLogs: AttendanceLog[];
  holidays: HolidayItem[];
  staffList: StaffColumn[];
  editableStaffIds: string[];
}

export interface MonthItem {
  period: string;
  label: string;
  locked: boolean;
}

/** work_log ceiling — mirrors the backend service/Zod limit. */
export const WORK_LOG_MAX = 2000;
