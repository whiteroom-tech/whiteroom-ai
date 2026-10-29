'use client';

import { useState } from 'react';
import { SegmentedControl } from '@whiteroom/ui';
import { AppShell } from '@/components/AppShell';
import { AgentDetail } from '@/components/agent/AgentDetail';
import type { AgentInfo, AuditEntry, FleetDiagnosis, GovernanceRule, RunSummary } from '@/lib/whiteroom/types';
import type { AgentWeek } from '@/lib/home-agents';

const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const ENTRIES: AuditEntry[] = [
  { id: '1', type: 'task_complete', timestamp: iso(1), agentId: 'lead-agent', taskName: 'Policy draft: Meridian Foods', model: 'claude-haiku-4-5' },
  { id: '3', type: 'watch_start', timestamp: iso(4), agentId: 'lead-agent' },
  { id: '4', type: 'governance_block', timestamp: iso(9), agentId: 'lead-agent', ruleType: 'spend_cap', reason: 'budget_exceeded' },
  { id: '5', type: 'task_complete', timestamp: iso(15), agentId: 'lead-agent', taskName: 'Look up carrier filing' },
];
const WEEK: AgentWeek = {
  used: 53_400, input: 412_000, saved: 225_800, rules: { blocks: 2, wouldBlocks: 58 },
  score: { agentId: 'lead-agent', calls: 412, completeRate: 100, costDiligence: null, speedScore: 57, score: 8 },
};
const ruleBase = { fleetId: 'acme-claims-prod', changedBy: 'preview', changedAt: iso(2_880), version: 1 };
const RULES: GovernanceRule[] = [
  { ...ruleBase, id: 'r1', ruleType: 'loop_breaker', mode: 'enforce', response: 'block', appliesTo: 'all', params: { threshold: 100, scope: 'run', ignoreTools: [] } },
  { ...ruleBase, id: 'r2', ruleType: 'model_allowlist', mode: 'watch', response: 'block', appliesTo: 'all', params: { allowedModels: ['claude-haiku-4-5-20251001'] } },
  { ...ruleBase, id: 'r3', ruleType: 'spend_cap', mode: 'watch', response: 'block', appliesTo: ['lead-agent'], params: { dailyCap: 20, scope: 'day', unit: 'dollars' } },
  { ...ruleBase, id: 'r6', ruleType: 'call_rate', mode: 'off', response: 'block', appliesTo: ['lead-agent'], params: { maxCalls: 60 } },
];
// Recent runs to match the sample: run 8 is the last one, 5 to 7 came before it.
const run = (shift: number, startMin: number, lenMin: number, x: Partial<RunSummary> = {}): RunSummary => ({
  runId: `lead-agent~${shift}`, agentId: 'lead-agent', shift, startedAt: iso(startMin), endedAt: iso(startMin - lenMin), lengthSeconds: lenMin * 60,
  calls: 12, failedCalls: 0, blockedCalls: 0, wouldActCalls: 0, spendMicros: 310_000, unpricedAttempts: 0, coverage: { calls: 12, checked: 12 }, flags: [], ...x,
});
const RUNS: RunSummary[] = [
  run(8, 40, 10, { wouldActCalls: 6 }),
  run(7, 95, 31, { failedCalls: 4, flags: [{ signal: 'error_streak', calls: 4 }] }),
  run(6, 1500, 27),
  run(5, 1520, 2),
];
const LIFETIME = { tokensUsed: 53_400, tasksCompleted: 60, minutesWorked: 212 };
const STATES: Record<string, AgentInfo> = {
  // Not running, no task type: the mockup's first view.
  waiting: { agentId: 'lead-agent', status: 'idle', govV1: true, watchNumber: 8, currentShift: null, lastShift: { watchNumber: 8, tasksCompleted: 6, tokensUsed: 4_100, minutesWorked: 10 }, lifetime: LIFETIME },
  working: { agentId: 'lead-agent', status: 'working', govV1: true, taskType: 'claims triage', watchNumber: 9, currentShift: { watchNumber: 9, tasksCompleted: 12, minutesWorked: 9.4, tokensUsed: 12_400 }, lifetime: LIFETIME },
  paused: { agentId: 'lead-agent', status: 'working', govV1: true, hold: { state: 'paused', by: 'dashboard', reason: null, at: new Date(Date.now() - 12 * 60_000).toISOString() }, taskType: 'claims triage', watchNumber: 8, currentShift: null, lastShift: { watchNumber: 8, tasksCompleted: 6, tokensUsed: 4_100, minutesWorked: 10 }, lifetime: LIFETIME },
  older: { agentId: 'lead-agent', status: 'resting', taskType: 'claims triage', watchNumber: 8, tasksCompleted: 62, minutesWorked: 9.4, restPercent: '40', alarmAt: new Date(Date.now() + 3 * 60_000).toISOString() },
  idle: { agentId: 'lead-agent', status: 'idle', govV1: true, watchNumber: 0, tasksCompleted: 0, currentShift: null },
};
const report = (findings: FleetDiagnosis['reports'][number]['findings']): FleetDiagnosis => ({
  checkedAt: iso(120), source: 'background', truncated: false, readyAgents: 1, busiest: null, minCalls: 50, waiting: [], skipped: [],
  reports: [{ schema: 'diagnosis.v1', agentId: 'lead-agent', window: { from: iso(10_080), to: iso(0), days: 7, calls: 412, watches: 8 }, findings,
    clear: [{ detector: 'review_spend_outliers', note: null }, { detector: 'review_tool_errors', note: null }, { detector: 'review_tool_silence', note: null }],
    notMeasured: [] }],
});
const HEALTHY = report([]);
const PROBLEM = report([{
  recommendationId: 'rec1', findingId: 'f1', findingVersion: 1, detector: 'review_tool_loops', detectorVersion: 1, status: 'open', measures: {},
  estWastedTokens: null, estWastedCostMicros: null, evidenceCallIds: [], coverage: 'full', limitations: null,
  suggestedAction: { kind: 'rule', rule: 'loop_breaker', mode: 'watch', appliesTo: ['lead-agent'], params: { threshold: 20 } },
}]);

export function AgentPreview() {
  const [which, setWhich] = useState('waiting');
  return (
    <AppShell>
      <div style={{ padding: '10px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
        Preview with sample data
        <SegmentedControl label="Sample state" value={which} onChange={setWhich} size={24} options={[{ value: 'waiting', label: 'Not running' }, { value: 'working', label: 'Working' }, { value: 'paused', label: 'Paused' }, { value: 'older', label: 'Older fleet, paused a moment' }, { value: 'idle', label: 'New, no data' }]} />
      </div>
      <AgentDetail
        key={which}
        fleetId="acme-claims-prod"
        agentId="lead-agent"
        from="home"
        preview={{ agent: STATES[which], entries: which === 'idle' ? [] : ENTRIES, week: which === 'idle' ? {} : WEEK, rules: RULES, runs: which === 'idle' ? [] : RUNS, diagnosis: which === 'idle' ? null : which === 'working' ? PROBLEM : HEALTHY }}
      />
    </AppShell>
  );
}
