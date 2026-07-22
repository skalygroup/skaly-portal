import { Suspense } from 'react';

import { ContentCalendarGrid } from '@/components/modules/content-calendar/content-calendar-grid';

/**
 * Content Calendar (04-APPFLOW §8, UIUX §11). admin/manager edit, team_member
 * reads, freelancer 403 — the API is the gate. Client component under Suspense:
 * useMonthContext reads useSearchParams (Next 15 boundary requirement).
 */
export default function ContentCalendarPage() {
  return (
    <main className="px-8 py-6">
      <h1
        className="mb-6 text-2xl font-bold"
        style={{ fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}
      >
        Content Calendar
      </h1>
      <Suspense
        fallback={
          <p className="py-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            Loading content calendar…
          </p>
        }
      >
        <ContentCalendarGrid />
      </Suspense>
    </main>
  );
}
