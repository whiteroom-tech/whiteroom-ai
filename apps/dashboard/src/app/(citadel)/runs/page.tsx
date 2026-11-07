import { Suspense } from 'react';
import { planRetentionDays } from '@/lib/plan-retention';
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
