import type { SignupRequestAdminItem } from '@skaly/shared/schemas/auth';

import { createClient } from '@/lib/supabase/server';

export type SignupRequestStatus = 'pending' | 'approved' | 'rejected';

/**
 * Server-side fetch of the admin signup-request list (GET
 * /v1/settings/signup-requests) for SSR initial data. Forwards the caller's
 * bearer so the API's admin guard runs and the response reflects their role.
 * Returns [] on any failure — the client useQuery re-fetches and surfaces real
 * errors; this is just the no-flash seed.
 */
export async function getSignupRequests(
  status: SignupRequestStatus,
): Promise<SignupRequestAdminItem[]> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return [];

  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL}/v1/settings/signup-requests?status=${status}`,
      { headers: { authorization: `Bearer ${session.access_token}` }, cache: 'no-store' },
    );
    if (!res.ok) return [];
    return (await res.json()) as SignupRequestAdminItem[];
  } catch {
    return [];
  }
}
