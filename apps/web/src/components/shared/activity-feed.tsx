'use client';

import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import Link from 'next/link';

import { api } from '@/lib/api';
import { useMonthContext } from '@/lib/hooks/use-month-context';

/**
 * Home activity feed (UIUX §5 right column, ADR-015).
 *
 * The last 10 events for the month, already humanised and role-filtered by
 * ActivityFeedService — this renders `actor + text + timestamp` and nothing else.
 * It is NOT the audit log: unmapped audit rows are dropped server-side, so an
 * empty feed is a real answer, not a missing template.
 *
 * The period FOLLOWS the sidebar's selector (§6.1). It was pinned to the current
 * IST month on the grounds that "/home has no month switcher" — true until the
 * selector landed in the shared sidebar, and now every portal route has one. A
 * feed still showing August under a banner reading "Viewing 2026-07" is the
 * inconsistency that argument was protecting against in the first place.
 */
interface FeedItem {
  id: string;
  actor: string;
  text: string;
  link: string | null;
  at: string;
}

const FEED_LIMIT = 10;

export function ActivityFeed() {
  const { period } = useMonthContext();

  const { data: items = [], isPending, isError } = useQuery({
    queryKey: ['activity-feed', period],
    queryFn: async () =>
      (await api<{ data: FeedItem[] }>(`/v1/activity-feed?period=${period}&limit=${FEED_LIMIT}`))
        .data,
    staleTime: 30_000,
  });

  return (
    <section aria-label="Activity feed">
      <h2
        className="mb-3 text-xs font-semibold uppercase tracking-wide"
        style={{ color: 'var(--text-muted)' }}
      >
        Activity
      </h2>

      {isPending ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Loading…
        </p>
      ) : isError ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Couldn’t load the activity feed.
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Nothing yet this month.
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.id} className="text-sm">
              <FeedLine item={item} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FeedLine({ item }: { item: FeedItem }) {
  const body = (
    <>
      <span style={{ color: 'var(--text-primary)' }}>{item.actor}</span>{' '}
      <span style={{ color: 'var(--text-secondary)' }}>{item.text}</span>{' '}
      <time
        dateTime={item.at}
        className="text-xs"
        style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}
      >
        {format(parseISO(item.at), 'd MMM HH:mm')}
      </time>
    </>
  );

  return item.link ? (
    <Link href={item.link} className="hover:underline">
      {body}
    </Link>
  ) : (
    <span>{body}</span>
  );
}
