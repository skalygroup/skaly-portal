import type { StaffMeResponse } from '@skaly/shared/schemas/auth';

import { createClient } from '@/lib/supabase/server';

/**
 * Server-side fetch of the current user's profile (GET /v1/staff/me) for Server
 * Components. Reads the access token from the session cookies and forwards it as
 * a bearer so the API hits its Redis staff_lookup cache (same key the middleware
 * warms). Returns null when there's no session or the API rejects — callers
 * decide how to degrade. The middleware is the real gate; this is for rendering.
 */
export async function getStaffMe(): Promise<StaffMeResponse | null> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;

  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/v1/staff/me`, {
      headers: { authorization: `Bearer ${session.access_token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as StaffMeResponse;
  } catch {
    return null;
  }
}
