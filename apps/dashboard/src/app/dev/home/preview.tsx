'use client';

import { useState } from 'react';
import { Button } from '@whiteroom/ui';
import { AppShell } from '@/components/AppShell';
import { LiveStatus, PageHeader } from '@/components/citadel/PageChrome';
import { HomeView, type AgentsView } from '@/components/home/HomeContent';
import { LiveFeedPanel } from '@/components/home/LiveFeedPanel';
import { EmptyHome } from '@/components/home/EmptyHome';
import { latestChanges } from '@/lib/home-changes';
import { addDays, localDay } from '@/lib/runs';
import type { AgentHold, AgentInfo, AuditEntry, FleetReport } from '@/lib/whiteroom/types';

// Sample fleets for /dev/home. The default is a quiet day like the mockup's
// (seven agents waiting, nothing on hold); ?busy=1 is a working day with a
// paused agent, a stopped one and one removed while held; ?view=table opens
// the table; ?empty=1 is the no-agents state.
const t = (hhmm: string) => `${new Date().toISOString().slice(0, 10)}T${hhmm}:00Z`;
const ago = (days: number, hhmm = '15:00') => `${addDays(localDay(), -days)}T${hhmm}:00Z`;
const BASE = {
  totals: { workMinutes: 22, tokens: 1_645_000, tasks: 119, handovers: 18 },
  energySavings: { compressionRatio: 93.9, estimatedTokensSaved: 1_650_000, estimatedCostSaved: '$8.9800', totalCostSaved: '$12.3100', cacheCostSaved: '$3.3300', estimatedEnergySaved: '0.49 kWh', formula: '' },
  compliance: { allAgentsWithinLimits: true, restingAgentsCount: 0, laborScore: '100%' },
  govV1: true,
};
const last = (n: number, tasks: number) => ({ currentShift: null, lastShift: { watchNumber: n, tasksCompleted: tasks, tokensUsed: 0, minutesWorked: 0 } });
const QUIET_AGENTS: AgentInfo[] = [
  { agentId: 'code-reviewer', status: 'idle', ...last(4, 6) },
  { agentId: 'contract-summarizer', status: 'idle', ...last(8, 6) },
  { agentId: 'invoice-reconciler', status: 'idle', ...last(9, 7) },
  { agentId: 'lead-agent', status: 'idle', ...last(115, 1) },
  { agentId: 'market-researcher', status: 'idle', ...last(7, 7) },
  { agentId: 'ops-scheduler', status: 'idle', ...last(8, 6) },
  { agentId: 'support-triage', status: 'idle', ...last(8, 7) },
];
const QUIET: FleetReport = { ...BASE, fleetId: 'demo-fleet', agentCount: 7, holds: {}, status: { working: [], resting: [], idle: QUIET_AGENTS.map((a) => a.agentId), handover_out: [] } };

const BUSY: FleetReport = {
  ...BASE, fleetId: 'acme-claims-prod', agentCount: 5,
  status: { working: ['lead-agent', 'writer-agent'], resting: ['scout-agent'], idle: ['archive-agent'], handover_out: [] },
  holds: { 'archive-agent': { state: 'stopped', by: 'dashboard', reason: null, at: t('13:52') }, 'old-scraper': { state: 'paused', by: 'dashboard', reason: null, at: t('11:05') } },
};
const BUSY_AGENTS: (AgentInfo & { stale?: boolean })[] = [
  { agentId: 'lead-agent', status: 'working', currentShift: { watchNumber: 8, tasksCompleted: 62, minutesWorked: 9.4, tokensUsed: 0 } },
  { agentId: 'writer-agent', status: 'working', currentShift: { watchNumber: 5, tasksCompleted: 31, minutesWorked: 6.2, tokensUsed: 0 } },
  { agentId: 'scout-agent', status: 'resting', ...last(3, 17) },
  { agentId: 'archive-agent', status: 'idle', ...last(2, 9), hold: { state: 'stopped', by: 'dashboard', reason: null, at: t('13:52') } },
  { agentId: 'billing-agent-with-a-long-name', status: 'working', currentShift: { watchNumber: 1, tasksCompleted: 2, minutesWorked: 0.8, tokensUsed: 0 }, stale: true },
];

// Change events as the engine records them; latestChanges words them.
const CHANGES: AuditEntry[] = [
  { id: 'c1', type: 'governance_rule_changed', timestamp: t('14:30'), ruleId: 'gr_loop', ruleType: 'loop_breaker', message: 'Loop breaker: Added new Loop breaker rule', by: 'user:u1' },
  { id: 'c2', type: 'deregister', timestamp: ago(2), agentId: 'keyword-test' },
  { id: 'c3', type: 'governance_rule_changed', timestamp: ago(2, '14:00'), ruleId: 'gr_kw', ruleType: 'keyword', message: 'Keywords: Removed Keywords rule', by: 'user:u1' },
  { id: 'c4', type: 'governance_rule_changed', timestamp: ago(3), ruleId: 'gr_kw', ruleType: 'keyword', message: 'Keywords: Added new Keywords rule', by: 'user:u1' },
  { id: 'c5', type: 'agent_paused', timestamp: ago(4), agentId: 'ops-scheduler', by: 'user:u1' },
];
const ACTORS = [{ action: 'add_rule', agentId: null, ruleId: 'gr_loop', userId: 'u1', by: 'R Haque', at: t('14:30') }];

const LIVE: AuditEntry[] = [
  { id: 'l1', type: 'task_complete', timestamp: t('14:16'), agentId: 'lead-agent', tokensUsed: 14210, details: [{ name: 'web_fetch', args: '{"url":"https://content.naic.org/model-laws"}' }] },
  { id: 'l2', type: 'task_complete', timestamp: t('14:16'), agentId: 'writer-agent', taskName: 'reply: Here is the Q3 claims summary.' },
];

const tally = (blocks: number, wouldBlocks: number) => ({ blocks, wouldBlocks, paused: 0, stopped: 0, toldYou: 0 });
const score = (agentId: string, s: number, speedScore: number | null) => ({ agentId, calls: 40, completeRate: 100, costDiligence: null, speedScore, score: s });
const QUIET_WEEK = {
  calls: 1180, costUsd: 3.17, partial: false, rules: tally(0, 120),
  agents: {
    'code-reviewer': { used: 53_400, saved: 225_800, rules: tally(0, 60), score: score('code-reviewer', 8, 57) },
    'contract-summarizer': { used: 300_600, saved: 222_900, score: score('contract-summarizer', 10, 100) },
    'invoice-reconciler': { used: 363_500, saved: 147_200, score: score('invoice-reconciler', 10, 96) },
    'lead-agent': { used: 69_700, saved: 2_230_000, rules: tally(0, 59), score: score('lead-agent', 8, 61) },
    'market-researcher': { used: 303_000, saved: 227_200, score: score('market-researcher', 10, 100) },
    'ops-scheduler': { used: 310_200, saved: 28_300, score: score('ops-scheduler', 10, 92) },
    'support-triage': { used: 337_800, saved: 105_400, score: score('support-triage', 10, 99) },
  },
};
const BUSY_WEEK = {
  calls: 1180, costUsd: 14.2, partial: false, rules: tally(2, 47),
  agents: {
    'lead-agent': { used: 182_000, saved: 61_000, rules: tally(2, 5), score: score('lead-agent', 9, 88) },
    'writer-agent': { used: 94_000, saved: 30_500, score: score('writer-agent', 8, 70) },
    'scout-agent': { used: 41_000, saved: 9_800, rules: tally(0, 42), score: score('scout-agent', 7, null) },
    'archive-agent': { used: 6_100, saved: 0 },
  },
};

export function HomePreview({ empty = false, busy = false, view: initialView = 'cards' }: { empty?: boolean; busy?: boolean; view?: AgentsView }) {
  const [view, setView] = useState<AgentsView>(initialView);
  // Pause, Stop and Resume change the sample agents in place; nothing is sent.
  const [holds, setHolds] = useState<Record<string, AgentHold | null>>({});
  const base = busy ? BUSY_AGENTS : QUIET_AGENTS;
  const agents = base.map((a) => (a.agentId in holds ? { ...a, hold: holds[a.agentId] } : a));
  const report = busy ? BUSY : QUIET;
  const reportHolds = Object.fromEntries(Object.entries({ ...report.holds, ...holds }).filter((e): e is [string, AgentHold] => !!e[1]));
  if (empty) {
    return (
      <AppShell>
        <PageHeader title="Home" fleetId="acme-claims-prod" badge={<LiveStatus at={null} empty />} />
        <EmptyHome />
      </AppShell>
    );
  }
  return (
    <AppShell>
      <PageHeader title="Home" fleetId={busy ? 'acme-claims-prod' : 'demo-fleet'} badge={<LiveStatus at={Date.now()} />}>
        <Button>Refresh</Button>
      </PageHeader>
      <HomeView
        report={{ ...report, holds: reportHolds }}
        agents={agents}
        changes={latestChanges(CHANGES, ACTORS, 4)}
        flaggedToday={busy ? 2 : 0}
        lastActive={{ day: addDays(localDay(), -3), runs: 47 }}
        today={busy ? { calls: 173, costUsd: 2.37 } : { calls: 0, costUsd: 0 }}
        failing={false}
        view={view}
        onViewChange={setView}
        todayRules={busy ? tally(2, 47) : tally(0, 0)}
        week={busy ? BUSY_WEEK : QUIET_WEEK}
        liveFeed={<LiveFeedPanel fleetId="preview" refreshSignal={0} preview={LIVE} previewOpen={busy} />}
        fleet={{ fleetId: 'preview', preview: true }}
        onActed={(id, hold) => { if (id) setHolds((h) => ({ ...h, [id]: hold ?? null })); }}
      />
    </AppShell>
  );
}
