'use client';

import { useState } from 'react';
import { SegmentedControl } from '@whiteroom/ui';
import { AppShell } from '@/components/AppShell';
import { AgentDetail } from '@/components/agent/AgentDetail';
import type { AgentInfo, AuditEntry, HandoverDoc } from '@/lib/whiteroom/types';

const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const ENTRIES: AuditEntry[] = [
  { id: '1', type: 'task_complete', timestamp: iso(1), agentId: 'lead-agent', taskName: 'Policy draft: Meridian Foods', model: 'claude-haiku-4-5' },
  { id: '2', type: 'self_handover', timestamp: iso(4), agentId: 'lead-agent' },
  { id: '3', type: 'watch_start', timestamp: iso(4), agentId: 'lead-agent' },
  { id: '4', type: 'governance_block', timestamp: iso(9), agentId: 'lead-agent', ruleType: 'spend_cap', reason: 'budget_exceeded' },
  { id: '5', type: 'task_complete', timestamp: iso(15), agentId: 'lead-agent', taskName: 'Look up carrier filing' },
];
const HANDOVER: HandoverDoc = {
  state: 'Triaging the 2:00 pm claims batch; 11 of 14 sorted.',
  pending: [{ task: '3 claims waiting on a policy lookup' }],
  warnings: ['Two claims share a policy number; check before merging.'],
  session_stats: { tasks_completed: 17, total_tokens: 41_000 },
};
const STATES: Record<string, AgentInfo> = {
  working: { agentId: 'lead-agent', status: 'working', taskType: 'claims triage', watchNumber: 8, tasksCompleted: 62, minutesWorked: 9.4, minutesRemaining: 3.2, percentComplete: '41%', tokensUsed: 12_400 },
  resting: { agentId: 'lead-agent', status: 'resting', taskType: 'claims triage', watchNumber: 8, tasksCompleted: 62, minutesWorked: 9.4, restPercent: '40', alarmAt: new Date(Date.now() + 3 * 60_000).toISOString() },
  idle: { agentId: 'lead-agent', status: 'idle', watchNumber: 2, tasksCompleted: 0 },
  paused: { agentId: 'lead-agent', status: 'working', govV1: true, hold: { state: 'paused', by: 'dashboard', reason: null, at: new Date(Date.now() - 12 * 60_000).toISOString() }, taskType: 'claims triage', watchNumber: 8, tasksCompleted: 62, minutesWorked: 9.4 },
};

export function AgentPreview() {
  const [which, setWhich] = useState('working');
  return (
    <AppShell>
      <div style={{ padding: '10px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--tx2)' }}>
        Preview with sample data
        <SegmentedControl label="Sample state" value={which} onChange={setWhich} size={24} options={[{ value: 'working', label: 'Working' }, { value: 'resting', label: 'On a break' }, { value: 'idle', label: 'Idle, no notes' }, { value: 'paused', label: 'Paused (Gov v1)' }]} />
      </div>
      <AgentDetail
        key={which}
        fleetId="acme-claims-prod"
        agentId="lead-agent"
        from="home"
        preview={{ agent: STATES[which], handover: which === 'idle' ? null : HANDOVER, entries: which === 'idle' ? [] : ENTRIES }}
      />
    </AppShell>
  );
}
