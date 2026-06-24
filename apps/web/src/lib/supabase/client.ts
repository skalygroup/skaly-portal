import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser-side Supabase client. Memoised to a single instance per tab: Supabase
 * keeps the auth session + realtime socket on the client object, so creating a
 * fresh one on every render would drop subscriptions and re-read storage need-
 * lessly. Safe to call from any client component — it always returns the same
 * client after the first call.
 *
 * Server Components / Route Handlers / middleware must use ./server.ts instead.
 */
let browserClient: ReturnType<typeof createBrowserClient> | undefined;

export function createClient() {
  if (browserClient) return browserClient;
  browserClient = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return browserClient;
}
