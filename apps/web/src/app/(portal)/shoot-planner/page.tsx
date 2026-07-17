import { Suspense } from 'react';

import { ShootPlannerGrid } from '@/components/modules/shoot-planner/shoot-planner-grid';

/**
 * Shoot Planner (04-APPFLOW §6, UIUX §9). Client component under Suspense —
 * useMonthContext reads useSearchParams (Next 15 boundary requirement).
 */
export default function ShootPlannerPage() {
  return (
    <main className="px-8 py-6">
      <h1
        className="mb-6 text-2xl font-bold"
        style={{ fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}
      >
        Shoot Planner
      </h1>
      <Suspense
        fallback={
          <p className="py-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            Loading shoot planner…
          </p>
        }
      >
        <ShootPlannerGrid />
      </Suspense>
    </main>
  );
}
