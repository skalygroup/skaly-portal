'use client';

import { useEffect } from 'react';

import { createClient } from '@/lib/supabase/client';

/**
 * Silent session refresh (IMPL-PLAN §4.2: "silent refresh at the 55-minute
 * mark"). Supabase's default session lasts 60 minutes; checking every minute and
 * refreshing once fewer than 5 minutes remain renews it ~55 minutes in — before
 * the access token can expire mid-session and bounce the user to /login.
 *
 * No-ops when signed out (auth pages mount this too), and is safe to mount once
 * app-wide: createClient() returns the single memoised browser client.
 */
export function useSessionRefresh() {
  useEffect(() => {
    const supabase = createClient();

    const interval = setInterval(
      async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.expires_at) return;

        const msUntilExpiry = session.expires_at * 1000 - Date.now();
        if (msUntilExpiry < 5 * 60 * 1000) {
          await supabase.auth.refreshSession();
        }
      },
      60 * 1000, // check every minute
    );

    return () => clearInterval(interval);
  }, []);
}
