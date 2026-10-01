'use client';

import { AppShell } from '@/components/AppShell';
import { TestRunFlow } from '@/components/sandbox/TestRunFlow';

// Renders as a signed-in user without a real session. The local sandbox route
// has no session behind it, so status checks come back empty and the page
// stays on its first steps.
export function SandboxPreview() {
  return (
    <AppShell>
      <TestRunFlow
        previewUserId="preview"
        previewPastTests={[
          { sandboxId: 's3', destroyedAt: new Date(Date.now() - 3_600_000).toISOString(), overall: 'pass', totalTasks: 4, isTrial: false },
          { sandboxId: 's2', destroyedAt: new Date(Date.now() - 86_400_000).toISOString(), overall: 'partial', totalTasks: 2, isTrial: false },
          { sandboxId: 's1', destroyedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), overall: 'pass', totalTasks: 6, isTrial: true },
        ]}
      />
    </AppShell>
  );
}
