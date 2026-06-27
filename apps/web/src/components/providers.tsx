'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';

import { useSessionRefresh } from '@/lib/hooks/use-session-refresh';

/**
 * App-wide client providers: TanStack Query + the Sonner toaster. Mounted once
 * in the root layout so every route (auth and portal) shares one QueryClient
 * and one toast surface.
 *
 * No next-themes ThemeProvider — the portal is dark-only (the dark palette is
 * the :root default in globals.css), so a theme switcher would be dead weight.
 */
export function Providers({ children }: { children: ReactNode }) {
  // Silent session refresh for every signed-in page (no-ops when signed out).
  useSessionRefresh();

  // One QueryClient per browser session, created lazily so it isn't shared
  // across requests on the server.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster position="top-right" theme="dark" richColors closeButton />
    </QueryClientProvider>
  );
}
