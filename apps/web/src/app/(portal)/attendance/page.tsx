import { Suspense } from 'react';

import { AttendanceGrid } from '@/components/modules/attendance/attendance-grid';

/**
 * Staff Attendance (04-APPFLOW §4). The grid is a client component driven by
 * the ?period= URL param (useMonthContext), so it sits under Suspense —
 * Next 15 requires a boundary around useSearchParams.
 */
export default function AttendancePage() {
  return (
    <main className="px-8 py-6">
      <h1
        className="mb-6 text-2xl font-bold"
        style={{ fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}
      >
        Staff Attendance
      </h1>
      <Suspense
        fallback={
          <p className="py-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            Loading attendance…
          </p>
        }
      >
        <AttendanceGrid />
      </Suspense>
    </main>
  );
}
