'use client';

import { AppShell } from '@/components/AppShell';
import { TestRunFlow } from '@/components/sandbox/TestRunFlow';
import type { RunStatusResult } from '@/lib/sandbox/api';

/** A live Azure OpenAI test whose agent's calls were refused for a wrong key. */
const FAILED_RUN: RunStatusResult = {
  sandboxId: 'preview-failed',
  mode: 'connected',
  provider: 'azure-openai',
  endpointHost: 'acme.openai.azure.com',
  expiresInSeconds: 1500,
  controls: ['core.connect', 'core.handoff', 'core.resume'].map(controlId => ({ controlId, name: controlId, result: {} })) as unknown as RunStatusResult['controls'],
  agents: [{ agentId: 'support-bot', role: 'worker', status: 'active', watchMinutes: 2, watchCount: 0, totalTasks: 0, totalTokens: 0, pairedWith: null, currentWatch: null }],
  auditLog: [{ id: 'e1', timestamp: new Date(Date.now() - 60_000).toISOString(), type: 'register', agentId: 'support-bot' }],
  failedCalls: {
    count: 2,
    last: {
      at: new Date(Date.now() - 30_000).toISOString(),
      agentId: 'support-bot',
      status: 401,
      reason: 'upstream_error',
      message: 'Access denied due to invalid subscription key or wrong API endpoint.',
    },
  },
};

// Renders as a signed-in user without a real session. The local sandbox route
// has no session behind it, so status checks come back empty and the page
// stays on its first steps, unless a sample test is shown (?state=failed).
export function SandboxPreview({ state }: { state?: 'failed' }) {
  return (
    <AppShell>
      <TestRunFlow
        previewUserId="preview"
        previewRun={state === 'failed' ? FAILED_RUN : undefined}
        previewPastTests={[
          { sandboxId: 's3', destroyedAt: new Date(Date.now() - 3_600_000).toISOString(), overall: 'pass', totalTasks: 4, isTrial: false },
          { sandboxId: 's2', destroyedAt: new Date(Date.now() - 86_400_000).toISOString(), overall: 'partial', totalTasks: 2, isTrial: false },
          { sandboxId: 's4', destroyedAt: new Date(Date.now() - 1.5 * 86_400_000).toISOString(), overall: 'empty', totalTasks: 0, isTrial: false },
          { sandboxId: 's1', destroyedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), overall: 'pass', totalTasks: 6, isTrial: true },
        ]}
      />
    </AppShell>
  );
}
