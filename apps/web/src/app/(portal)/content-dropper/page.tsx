import { Suspense } from 'react';

import { ContentDropperGrid } from '@/components/modules/content-dropper/content-dropper-grid';

/**
 * Content Dropper (04-APPFLOW §7, UIUX §10). admin/manager only — the API is the
 * gate. Client component under Suspense: useMonthContext reads useSearchParams
 * (Next 15 boundary requirement).
 */
export default function ContentDropperPage() {
  return (
    <main className="px-8 py-6">
      <h1
        className="mb-6 text-2xl font-bold"
        style={{ fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}
      >
        Content Dropper
      </h1>
      <Suspense
        fallback={
          <p className="py-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            Loading content dropper…
          </p>
        }
      >
        <ContentDropperGrid />
      </Suspense>
    </main>
  );
}
