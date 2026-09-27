import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { getAccountOverview } from '@/lib/account';
import { getEntitlement } from '@/lib/entitlements';
import { purchasablePlans } from '@/lib/plans';
import { SettingsView } from './settings-view';

export const metadata: Metadata = { title: 'Settings' };

// Reads the signed-in user's own rows on every request — there is nothing
// here that survives a cache.
export const dynamic = 'force-dynamic';

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ billing?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');

  const [account, entitlement, params] = await Promise.all([
    getAccountOverview(),
    getEntitlement(),
    searchParams,
  ]);

  return (
    <SettingsView
      account={account}
      entitlement={entitlement}
      purchasablePlans={purchasablePlans()}
      billingResult={params.billing ?? null}
    />
  );
}
