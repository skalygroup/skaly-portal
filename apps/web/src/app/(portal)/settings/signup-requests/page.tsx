import { SignupRequestsClient } from './signup-requests-client';

import { getSignupRequests, type SignupRequestStatus } from '@/lib/get-signup-requests';
import { requirePanel } from '@/lib/settings-panels';

const VALID: SignupRequestStatus[] = ['pending', 'approved', 'rejected'];

/**
 * Admin review queue for signup requests (Sprint 1 STEP 14). Server Component:
 * resolves the active tab from ?status= and prefetches that list for no-flash
 * SSR, then hands off to the client for the live list + approve/reject flows.
 *
 * Sprint 11 STEP 9: gated by `requirePanel` like its six siblings, so a typed
 * URL answers a real 403 rather than rendering an empty queue fetched with a
 * token the API will reject anyway.
 */
export default async function SignupRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requirePanel('module.settings_signup_requests.read');

  const { status } = await searchParams;
  const active: SignupRequestStatus = VALID.includes(status as SignupRequestStatus)
    ? (status as SignupRequestStatus)
    : 'pending';

  const initialData = await getSignupRequests(active);

  return <SignupRequestsClient status={active} initialData={initialData} />;
}
