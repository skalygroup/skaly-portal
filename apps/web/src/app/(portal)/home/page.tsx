import { ActivityFeed } from '@/components/shared/activity-feed';

/**
 * Home (UIUX §5): content left 70%, activity feed right 30%.
 *
 * The role-specific widgets for the left column are not this sprint — Sprint 9
 * ships the feed. The column is laid out now so adding them later is a fill, not
 * a re-layout.
 */
export default function HomePage() {
  return (
    <main className="grid gap-8 px-8 py-6 lg:grid-cols-[7fr_3fr]">
      <div>
        <h1 className="text-2xl" style={{ fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}>
          Home
        </h1>
      </div>
      <aside style={{ borderLeft: '1px solid var(--border-subtle)' }} className="lg:pl-6">
        <ActivityFeed />
      </aside>
    </main>
  );
}
