import { Suspense } from 'react';
import { auth } from '@/auth';
import { resolvePlan } from '@/lib/entitlements';
import { limitsFor } from '@/lib/plans';
import { RunsTable } from '@/components/runs/RunsTable';

// README › Screens › 2a. RunsTable falls back to the event feed while the
// engine has no list_runs. The plan's history length bounds its date pickers.
export default async function RunsPage() {
  return (
    <Suspense>
      <RunsTable retentionDays={await planRetentionDays()} />
    </Suspense>
  );
}

/** Days of history the signed-in account's plan keeps; undefined if it can't be read (the pickers are then unbounded). */
async function planRetentionDays(): Promise<number | undefined> {
  try {
    const userId = (await auth())?.user?.id;
    return userId ? limitsFor((await resolvePlan(userId)).plan).retentionDays : undefined;
  } catch {
    return undefined;
  }
}
