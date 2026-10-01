'use client';

import { useState } from 'react';
import { Button } from '@whiteroom/ui';
import { AppShell } from '@/components/AppShell';
import { PageHeader } from '@/components/citadel/PageChrome';
import { HomeView, type AgentsView } from '@/components/home/HomeContent';
import { LiveFeedPanel } from '@/components/home/LiveFeedPanel';
import { EmptyHome } from '@/components/home/EmptyHome';
import type { AgentInfo, AuditEntry, FleetReport } from '@/lib/whiteroom/types';

// Sample fleet shaped like the redesign's screen 1a (P1 data only).
const t = (hhmm: string) => `${new Date().toISOString().slice(0, 10)}T${hhmm}:00Z`;
const REPORT: FleetReport = {
  fleetId: 'acme-claims-prod', agentCount: 5,
  status: { working: ['lead-agent', 'writer-agent'], resting: ['scout-agent'], idle: ['archive-agent'], handover_out: [] },
  totals: { workMinutes: 22, tokens: 1_645_000, tasks: 119, handovers: 18 },
  energySavings: { compressionRatio: 93.9, estimatedTokensSaved: 1_650_000, estimatedCostSaved: '$2.1700', estimatedEnergySaved: '0.49 kWh', formula: '' },
  compliance: { allAgentsWithinLimits: true, restingAgentsCount: 1, laborScore: '100%' },
  holds: { 'archive-agent': { state: 'stopped', by: 'dashboard', reason: null, at: t('13:52') } },
  govV1: true,
};
const AGENTS: (AgentInfo & { stale?: boolean })[] = [
  { agentId: 'lead-agent', status: 'working', watchNumber: 8, tasksCompleted: 62, minutesWorked: 9.4, minutesRemaining: 3 },
  { agentId: 'writer-agent', status: 'working', watchNumber: 5, tasksCompleted: 31, minutesWorked: 6.2, minutesRemaining: 4 },
  { agentId: 'scout-agent', status: 'resting', watchNumber: 3, tasksCompleted: 17 },
  { agentId: 'archive-agent', status: 'idle', watchNumber: 2, tasksCompleted: 9, hold: { state: 'stopped', by: 'dashboard', reason: null, at: t('13:52') } },
  { agentId: 'billing-agent-with-a-long-name', status: 'working', watchNumber: 1, tasksCompleted: 2, minutesWorked: 0.8, stale: true },
];
const ENTRIES: AuditEntry[] = [
  { id: '1', type: 'self_handover', timestamp: t('14:15'), agentId: 'lead-agent' },
  { id: '2', type: 'governance_block', timestamp: t('14:14'), agentId: 'scout-agent', ruleType: 'spend_cap', reason: 'budget_exceeded' },
  { id: '3', type: 'rest_start', timestamp: t('14:02'), agentId: 'scout-agent' },
  { id: '4', type: 'task_complete', timestamp: t('13:40'), agentId: 'writer-agent', taskName: 'Summary: Q3 claims' },
];
const LIVE: AuditEntry[] = [
  { id: 'l1', type: 'task_complete', timestamp: t('14:16'), agentId: 'lead-agent', details: [{ name: 'web_fetch', args: '{"url":"https://content.naic.org/model-laws"}' }] },
  { id: 'l2', type: 'task_complete', timestamp: t('14:16'), agentId: 'writer-agent', taskName: 'reply: Here is the Q3 claims summary. 3 claims are still open pending a policy lookup.' },
  { id: 'l3', type: 'task_complete', timestamp: t('14:15'), agentId: 'scout-agent', details: [{ name: 'search_files', args: '{"query":"hartwell endorsement","path":"/data/claims"}' }] },
  { id: 'l4', type: 'task_complete', timestamp: t('14:15'), agentId: 'lead-agent', details: [{ name: 'read_file', args: '{"path":"/data/policies/meridian.md"}' }] },
  { id: 'l5', type: 'task_complete', timestamp: t('14:14'), agentId: 'scout-agent', details: [{ name: 'policy_lookup', args: '{"id":"PL-20931"}' }, { name: 'persist_note', args: '{}' }] },
];

/** `empty` (/dev/home?empty=1) shows the no-agents state, screen 8. */
export function HomePreview({ empty = false }: { empty?: boolean }) {
  const [view, setView] = useState<AgentsView>('cards');
  if (empty) {
    return (
      <AppShell>
        <PageHeader title="Home" fleetId="acme-claims-prod" badge={<span style={{ fontSize: 12, color: 'var(--tx2)' }}>Waiting for the first call · preview</span>} />
        <EmptyHome />
      </AppShell>
    );
  }
  return (
    <AppShell>
      <PageHeader title="Home" fleetId="acme-claims-prod" badge={<span style={{ fontSize: 12, color: 'var(--tx2)' }}>Preview with sample data</span>}>
        <Button>Refresh</Button>
      </PageHeader>
      <HomeView
        report={REPORT}
        agents={AGENTS}
        entries={ENTRIES}
        today={{ calls: 173, costUsd: 2.37 }}
        failing={false}
        view={view}
        onViewChange={setView}
        liveFeed={<LiveFeedPanel fleetId="preview" refreshSignal={0} preview={LIVE} />}
      />
    </AppShell>
  );
}
