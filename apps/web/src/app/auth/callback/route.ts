import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';

/**
 * OAuth (Google) redirect target. Supabase sends the user here with a `code`
 * after they approve at Google; we exchange it for a session (which @supabase/ssr
 * persists into cookies) and bounce to the app root. Next.js middleware then
 * routes admins/managers to /mfa-setup if they still need to enrol.
 *
 * Lives at /auth/callback — deliberately OUTSIDE the (auth) route group, since
 * it's a server Route Handler, not a page that should wear the auth layout.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}/`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=oauth_failed`);
}
