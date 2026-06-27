import { SignupRequestsClient } from './signup-requests-client';

import { getSignupRequests, type SignupRequestStatus } from '@/lib/get-signup-requests';

const VALID: SignupRequestStatus[] = ['pending', 'approved', 'rejected'];

/**
 * Admin review queue for signup requests (Sprint 1 STEP 14). Server Component:
 * resolves the active tab from ?status= and prefetches that list for no-flash
 * SSR, then hands off to the client for the live list + approve/reject flows.
 * The route is admin-gated by middleware + the API; the nav link is admin-only.
 */
export default async function SignupRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const active: SignupRequestStatus = VALID.includes(status as SignupRequestStatus)
    ? (status as SignupRequestStatus)
    : 'pending';

  const initialData = await getSignupRequests(active);

  return <SignupRequestsClient status={active} initialData={initialData} />;
}
