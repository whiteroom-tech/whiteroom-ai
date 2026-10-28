import 'server-only';
import { auth } from '@/auth';
import { resolvePlan } from '@/lib/entitlements';
import { limitsFor } from '@/lib/plans';

/** Days of history the signed-in account's plan keeps; undefined if it can't be read (date pickers are then unbounded). Server only. */
export async function planRetentionDays(): Promise<number | undefined> {
  try {
    const userId = (await auth())?.user?.id;
    return userId ? limitsFor((await resolvePlan(userId)).plan).retentionDays : undefined;
  } catch {
    return undefined;
  }
}
