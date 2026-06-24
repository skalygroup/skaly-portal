import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Server-side Supabase client for Server Components, Route Handlers, and
 * middleware. Reads (and, where allowed, writes) the session cookies via
 * next/headers. NEVER import this from a client component — `next/headers` is
 * server-only and Next 15 will error at build time.
 *
 * cookies() is async in Next 15, so this factory is async too.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Thrown when called from a Server Component (cookies are read-only
            // there). Safe to ignore: the middleware refreshes the session and
            // writes the cookies on the response instead.
          }
        },
      },
    },
  );
}
