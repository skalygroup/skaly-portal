import { RecoveryCodesCard } from '@/components/profile/recovery-codes-card';

/**
 * Still the Sprint 1 stub for everything but security. Sprint 11 STEP 8 adds the
 * recovery-codes section here because the redeem path needs somewhere to send
 * people who want to regenerate; the rest of the profile is not this sprint's.
 */
export default function ProfilePage() {
  return (
    <div className="flex max-w-2xl flex-col gap-6 p-6">
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-bold text-text-primary">
        Profile
      </h1>
      <RecoveryCodesCard />
    </div>
  );
}
