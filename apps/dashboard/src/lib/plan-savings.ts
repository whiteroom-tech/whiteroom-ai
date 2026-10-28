'use server';

import { auth } from '@/auth';
import { getSubscriptionRow, getTrialEndsAt } from '@/lib/entitlements';
import { isActiveStatus } from '@/lib/plans';
import { billedFrom, monthToDateSavingsCents } from '@/lib/savings-billing';
import { stripe } from '@/lib/stripe';

/**
 * This month's billable savings for the signed-in account, in whole cents,
 * counted exactly as the billing sync bills them, for the Settings plan line.
 * `billed: false` when no subscription bills savings (none yet, comped, or
 * still on a retired price), so the line is hidden; null when it can't be
 * read. Takes no arguments: the account is always the session's own.
 */
export async function getMonthSavings(): Promise<{ savedCents: number } | { billed: false } | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  try {
    const sub = await getSubscriptionRow(userId);
    if (!sub?.stripeSubscriptionId || !isActiveStatus(sub.status) || !process.env.STRIPE_SECRET_KEY) return { billed: false };
    const firstDay = await billedFrom(stripe(), sub.stripeSubscriptionId, await getTrialEndsAt(userId));
    if (!firstDay) return { billed: false };
    const savedCents = await monthToDateSavingsCents(userId, firstDay);
    return savedCents === null ? null : { savedCents };
  } catch {
    return null;
  }
}
