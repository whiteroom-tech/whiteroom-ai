'use client';

import { AppShell } from '@/components/AppShell';
import { TestRunFlow } from '@/components/sandbox/TestRunFlow';

// Renders as a signed-in user without a real session. The local sandbox route
// has no session behind it, so status checks come back empty and the page
// stays on its first steps.
export function SandboxPreview() {
  return (
    <AppShell>
      <TestRunFlow previewUserId="preview" />
    </AppShell>
  );
}
