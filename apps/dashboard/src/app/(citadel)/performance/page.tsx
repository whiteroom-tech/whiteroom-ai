import { Suspense } from 'react';
import { planRetentionDays } from '@/lib/plan-retention';
import { PerformancePage } from './_components/PerformancePage';

// The plan's history length bounds the Custom range's date pickers, as on Runs.
export default async function Page() {
  return (
    <Suspense>
      <PerformancePage retentionDays={await planRetentionDays()} />
    </Suspense>
  );
}
