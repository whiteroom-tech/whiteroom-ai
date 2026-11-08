'use server';

import { auth } from '@/auth';
import { ensureHomeFleetFor, homeFleetDeps } from '@/lib/home-fleet-server';
import type { HomeFleetResult } from '@/lib/home-fleet-shared';

/**
 * Opening Sandbox or Fleet key: makes the signed-in Free account's home fleet
 * when it has none, or replaces one retired after 30 idle days. Anything else
 * (a paid account, no account session) is `not_free`, and the page goes on as
 * before. Acts only for the signed-in account and takes nothing from the page.
 */
export async function ensureHomeFleet(): Promise<HomeFleetResult> {
  const userId = (await auth().catch(() => null))?.user?.id;
  if (!userId) return { kind: 'not_free' };
  try {
    return await ensureHomeFleetFor(userId, homeFleetDeps);
  } catch {
    // The reason can carry engine or database detail: not logged, not shown.
    console.error('[home-fleet] ensure failed');
    return { kind: 'failed' };
  }
}
