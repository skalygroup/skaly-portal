import { ShieldOff } from 'lucide-react';
import Link from 'next/link';

/**
 * Rendered by `forbidden()` with a real HTTP 403 (Auth-Matrix §3: direct URL
 * access to a route outside your access set is a 403, never a redirect).
 *
 * Says "you may not", not "it does not exist". A 404 here would be a small lie
 * that costs someone twenty minutes of wondering whether the link is stale.
 */
export default function Forbidden() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <ShieldOff size={32} className="text-text-muted" />
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-bold text-text-primary">
        You don&apos;t have access to this page
      </h1>
      <p className="max-w-md text-sm leading-relaxed text-text-secondary">
        This area is restricted to certain roles. If you think you should be able to see it, ask
        an admin to check your permissions in Settings.
      </p>
      <Link
        href="/home"
        className="mt-2 rounded-md bg-accent-gold px-4 py-2 text-[13.5px] font-semibold text-bg-base transition-[filter] hover:brightness-[1.06]"
      >
        Back to home
      </Link>
    </div>
  );
}
