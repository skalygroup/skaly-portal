import { Suspense } from 'react';

import { ActivityFeed } from '@/components/shared/activity-feed';
import { HomeSummary } from '@/components/shared/home-summary';
import { HomeTasks } from '@/components/shared/home-tasks';
import { getStaffMe } from '@/lib/get-staff-me';

/**
 * Home (UIUX §5): content left 70%, activity feed right 30%.
 *
 * WHAT THIS PAGE IS FOR: answering "what needs me today" before you click
 * anything. It held a bare `<h1>Home</h1>` beside the feed, which told a person
 * nothing they did not already know.
 *
 * WHAT IT DELIBERATELY IS NOT: every widget §5 lists. A landing page that shows
 * everything shows nothing — so this is four headline numbers, the five tasks
 * that are actually next, and the activity feed. Pipeline overview, mini calendar
 * rows and quick-action modals are left out on purpose; each is a second copy of
 * a module surface, and the module is one click away in the sidebar.
 *
 * Server component only for the greeting — the three panels below fetch their own
 * data client-side and fail independently, so a slow feed cannot hold up the
 * numbers and a failed summary cannot blank the task list.
 */
export const dynamic = 'force-dynamic';

/** IST, because the whole product's "today" is IST (BaseService.currentIstDate). */
function greeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      hour12: false,
    }).format(new Date()),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default async function HomePage() {
  const me = await getStaffMe();
  const firstName = me?.name?.split(' ')[0] ?? 'there';
  const today = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());

  return (
    <div className="grid gap-8 px-8 py-6 lg:grid-cols-[7fr_3fr]">
      <div className="min-w-0">
        <header className="mb-6">
          <p
            className="text-[11px] uppercase tracking-[0.18em]"
            style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}
          >
            {today}
          </p>
          <h1
            className="mt-1 text-2xl font-bold"
            style={{ fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}
          >
            {greeting()}, {firstName}
            <span style={{ color: 'var(--accent-gold)' }}>.</span>
          </h1>
        </header>

        {/* All three read `?period=` via useMonthContext, which Next 15 requires a
            Suspense boundary for. One boundary each, not one around all three, so
            a slow feed cannot hold the numbers back. */}
        <Suspense fallback={<div className="h-[92px]" />}>
          <HomeSummary />
        </Suspense>

        <div className="mt-8">
          <Suspense fallback={null}>
            <HomeTasks />
          </Suspense>
        </div>
      </div>

      <aside style={{ borderLeft: '1px solid var(--border-subtle)' }} className="min-w-0 lg:pl-6">
        <Suspense fallback={null}>
          <ActivityFeed />
        </Suspense>
      </aside>
    </div>
  );
}
