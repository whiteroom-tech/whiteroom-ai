'use server';

import { auth } from '@/auth';
import { monthToDateSavingsCents } from '@/lib/savings-billing';

/**
 * This month's billable savings for the signed-in account, in whole cents,
 * for the Settings plan line. Null when it can't be read. Takes no
 * arguments: the account is always the session's own.
 */
export async function getMonthSavings(): Promise<{ savedCents: number } | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  try {
    const savedCents = await monthToDateSavingsCents(userId);
    return savedCents === null ? null : { savedCents };
  } catch {
    return null;
  }
}
