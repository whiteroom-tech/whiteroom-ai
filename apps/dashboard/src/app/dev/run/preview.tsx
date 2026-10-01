'use client';

import { AppShell } from '@/components/AppShell';
import { RunDetail } from '@/components/runs/RunDetail';
import type { RunEvent, RunEventsResult } from '@/lib/whiteroom/types';

const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const EVENTS: RunEvent[] = [
  { id: 'e1', kind: 'event', at: t(23), type: 'watch_start', detail: { agentId: 'lead-agent', watchNumber: 14 } },
  { id: 'c1', kind: 'call', at: t(22.5), type: 'complete', model: 'claude-haiku-4-5', tools: ['search_places', 'get_lead_list'] },
  { id: 'c2', kind: 'call', at: t(20), type: 'complete', model: 'claude-haiku-4-5', tools: ['read_file'] },
  { id: 'c3', kind: 'call', at: t(14), type: 'upstream_error', model: 'claude-haiku-4-5' },
  { id: 'c4', kind: 'call', at: t(9), type: 'governance_blocked', model: 'claude-sonnet-4-5' },
  { id: 'e2', kind: 'event', at: t(9), type: 'governance_block', detail: { agentId: 'lead-agent', ruleType: 'model_allowlist', reason: 'model_not_allowed' } },
  { id: 'c5', kind: 'call', at: t(4), type: 'complete', model: 'claude-haiku-4-5', tools: ['persist_lead', 'persist_lead', 'persist_lead', 'notify', 'log'] },
  { id: 'e3', kind: 'event', at: t(0.5), type: 'self_handover', detail: { agentId: 'lead-agent', watchNumber: 14 } },
];
const DATA: RunEventsResult = {
  fleetId: 'acme-claims-prod',
  run: { runId: 'lead-agent~14', agentId: 'lead-agent', shift: 14, startedAt: t(23), endedAt: t(0), flags: [{ signal: 'repeating_call', tool: 'fetch_page', calls: 6 }] },
  events: EVENTS, page: 0, pages: 1, total: EVENTS.length, eventFound: null,
};

export function RunPreview() {
  return (
    <AppShell>
      <RunDetail fleetId="acme-claims-prod" runId="lead-agent~14" preview={DATA} />
    </AppShell>
  );
}
