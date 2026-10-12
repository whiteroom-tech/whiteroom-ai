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

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const controls = (track: 'liveEvidence' | 'demoEvidence', observed: number) =>
  ['core.connect', 'core.handoff', 'core.resume'].map((controlId, i) => ({
    controlId, name: controlId,
    result: i < observed ? { [track]: { status: 'observed', timestamp: ago(60 - i * 10) } } : {},
  })) as unknown as RunStatusResult['controls'];
const agent = (totalTasks: number) => ({ agentId: 'support-bot', role: 'worker', status: 'active', watchMinutes: 2, watchCount: 1, totalTasks, totalTokens: totalTasks * 1200, pairedWith: null, currentWatch: { watchNumber: 1, minutesWorked: 0.7, tokensUsed: 2400, tasksCompleted: totalTasks } });

/** The demo, as it looks once the engine's script has run. */
const DEMO_RUN: RunStatusResult = {
  sandboxId: 'preview-demo',
  mode: 'demo',
  expiresInSeconds: 1787,
  controls: controls('demoEvidence', 3),
  agents: [{ ...agent(3), agentId: 'demo-agent' }],
  auditLog: [
    { id: 'd1', timestamp: ago(80), type: 'register', agentId: 'demo-agent' },
    { id: 'd2', timestamp: ago(78), type: 'watch_start', agentId: 'demo-agent' },
    { id: 'd3', timestamp: ago(75), type: 'task_complete', agentId: 'demo-agent' },
    { id: 'd4', timestamp: ago(70), type: 'self_handover', agentId: 'demo-agent' },
    { id: 'd5', timestamp: ago(65), type: 'task_complete', agentId: 'demo-agent' },
    { id: 'd6', timestamp: ago(60), type: 'demo_activity', agentId: null },
    { id: 'd7', timestamp: ago(55), type: 'policy_decision', agentId: 'demo-agent' },
    { id: 'd8', timestamp: ago(50), type: 'policy_enforcement_verified', agentId: null },
    { id: 'd9', timestamp: ago(45), type: 'policy_chain_verified', agentId: null },
  ],
};

/** A live Anthropic test with every check passed. */
const PASSED_RUN: RunStatusResult = {
  sandboxId: 'preview-passed',
  mode: 'connected',
  expiresInSeconds: 1320,
  controls: controls('liveEvidence', 3),
  agents: [agent(6)],
  auditLog: [
    { id: 'p1', timestamp: ago(300), type: 'register', agentId: 'support-bot' },
    { id: 'p2', timestamp: ago(295), type: 'task_complete', agentId: 'support-bot' },
    { id: 'p3', timestamp: ago(120), type: 'self_handover', agentId: 'support-bot' },
    { id: 'p4', timestamp: ago(60), type: 'task_complete', agentId: 'support-bot' },
  ],
};

/** A live Anthropic test that has seen no calls yet. The page has had it open for 10 seconds (SEEN_FOR). */
const WAITING_RUN: RunStatusResult = {
  sandboxId: 'preview-waiting',
  mode: 'connected',
  expiresInSeconds: 1790,
  controls: controls('liveEvidence', 0),
  agents: [],
  auditLog: [],
};

/** The same, open for two minutes with no calls: "Nothing happening?" has opened on its own. */
const IDLE_RUN: RunStatusResult = { ...WAITING_RUN, sandboxId: 'preview-idle', expiresInSeconds: 1680 };

/** How long the page has "seen" each sample test: idle help counts from then, not from a test length. */
const SEEN_FOR: Partial<Record<PreviewState, number>> = { waiting: 10, idle: 120 };

const PREVIEW_STATES = { failed: FAILED_RUN, demo: DEMO_RUN, passed: PASSED_RUN, waiting: WAITING_RUN, idle: IDLE_RUN } as const;
/** "empty": the start screen with no past tests. */
export type PreviewState = keyof typeof PREVIEW_STATES | 'empty';

const PAST_TESTS = [
  { sandboxId: 's3', destroyedAt: new Date(Date.now() - 3_600_000).toISOString(), overall: 'pass', totalTasks: 4, isTrial: false },
  { sandboxId: 's2', destroyedAt: new Date(Date.now() - 86_400_000).toISOString(), overall: 'partial', totalTasks: 2, isTrial: false },
  { sandboxId: 's4', destroyedAt: new Date(Date.now() - 1.5 * 86_400_000).toISOString(), overall: 'empty', totalTasks: 0, isTrial: false },
  // Recorded before Oct 12: nothing checked was stored as partial. Shown as Not tested.
  { sandboxId: 's5', destroyedAt: new Date(Date.now() - 1.8 * 86_400_000).toISOString(), overall: 'partial', totalTasks: 0, isTrial: false },
  { sandboxId: 's1', destroyedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), overall: 'pass', totalTasks: 6, isTrial: true },
] as const;

// Renders as a signed-in user without a real session. The local sandbox route
// has no session behind it, so status checks come back empty and the page
// stays on its first steps, unless a sample test is shown (?state=…).
export function SandboxPreview({ state }: { state?: PreviewState }) {
  return (
    <AppShell>
      <TestRunFlow
        previewUserId="preview"
        previewRun={state && state !== 'empty' ? PREVIEW_STATES[state] : undefined}
        previewSeenSecondsAgo={state ? SEEN_FOR[state] : undefined}
        previewPastTests={state === 'empty' ? [] : [...PAST_TESTS]}
      />
    </AppShell>
  );
}
