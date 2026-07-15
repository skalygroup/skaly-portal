import { Suspense } from 'react';

import { TasksGrid } from '@/components/modules/tasks/tasks-grid';

/**
 * Work Allocation (04-APPFLOW §5). Client grid driven by the ?period= URL param
 * (useMonthContext), so it sits under Suspense — Next 15 requires a boundary
 * around useSearchParams.
 */
export default function TasksPage() {
  return (
    <main className="px-8 py-6">
      <Suspense
        fallback={
          <p className="py-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            Loading tasks…
          </p>
        }
      >
        <TasksGrid />
      </Suspense>
    </main>
  );
}
