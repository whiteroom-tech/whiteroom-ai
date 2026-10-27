'use client';

import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { RunDetail } from '@/components/runs/RunDetail';
import type { CallRuleAction, RunEvent, RunEventsResult } from '@/lib/whiteroom/types';

const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const WOULD: CallRuleAction = { ruleId: 'gr_allow', ruleType: 'model_allowlist', ruleName: 'Model allowlist', mode: 'watch', response: 'block', outcome: 'would_block', reason: 'model_not_allowed' };
const call = (id: string, min: number, x: Partial<RunEvent> = {}): RunEvent => ({ id, kind: 'call', at: t(min), type: 'complete', model: 'claude-sonnet-4-5', ...x });
const EVENTS: RunEvent[] = [
  { id: 'e1', kind: 'event', at: t(24), type: 'watch_start', detail: { agentId: 'code-reviewer', watchNumber: 4 } },
  call('call:1', 24, { requestedTools: ['get_diff', 'run_tests'], ruleActions: [WOULD] }),
  call('call:2', 24, { requestedTools: ['post_comment', 'post_comment'], ruleActions: [WOULD] }),
  call('call:3', 22, { ruleActions: [WOULD] }),
  call('call:4', 20, { model: 'claude-haiku-4-5', requestedTools: ['read_file'] }),
  call('call:5', 14, { model: 'claude-haiku-4-5', type: 'upstream_error' }),
  call('call:6', 9, { model: 'claude-opus-4-1', type: 'governance_blocked', ruleActions: [{ ruleId: 'gr_cap', ruleType: 'spend_cap', ruleName: 'Spend cap', mode: 'enforce', response: 'block', outcome: 'blocked', reason: 'budget_exceeded' }] }),
  { id: 'e2', kind: 'event', at: t(9), type: 'governance_block', detail: { agentId: 'code-reviewer', ruleType: 'spend_cap', reason: 'budget_exceeded' } },
  call('call:7', 4, { requestedTools: ['post_comment'], ruleActions: [WOULD] }),
  { id: 'e3', kind: 'event', at: t(0.5), type: 'watch_end', detail: { agentId: 'code-reviewer', watchNumber: 4 } },
];
const DATA: RunEventsResult = {
  fleetId: 'demo-fleet',
  run: {
    runId: 'code-reviewer~4', agentId: 'code-reviewer', shift: 4, startedAt: t(24), endedAt: t(0),
    flags: [{ signal: 'repeating_call', tool: 'post_comment', calls: 6 }],
    calls: 7, spendMicros: 52_000, unpricedAttempts: 0, failedCalls: 1, blockedCalls: 1, wouldBlockCalls: 4,
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'],
    ruleActions: [
      { at: t(24), ruleId: 'gr_allow', ruleType: 'model_allowlist', response: 'block', mode: 'watch', occurrences: 3, reason: 'model_not_allowed', eventIds: ['call:1', 'call:2', 'call:3'] },
      { at: t(9), ruleId: 'gr_cap', ruleType: 'spend_cap', response: 'block', mode: 'enforce', occurrences: 1, reason: 'budget_exceeded', eventIds: ['call:6'] },
      { at: t(4), ruleId: 'gr_allow', ruleType: 'model_allowlist', response: 'block', mode: 'watch', occurrences: 1, reason: 'model_not_allowed', eventIds: ['call:7'] },
    ],
  },
  events: EVENTS, page: 0, pages: 1, total: EVENTS.length, eventFound: null,
};

/** ?engine=old: what an engine before PR 298 sends (no totals, models or call links); the list's totals stand in. */
const OLD: RunEventsResult = {
  ...DATA,
  run: { runId: DATA.run.runId, agentId: DATA.run.agentId, shift: DATA.run.shift, startedAt: DATA.run.startedAt, endedAt: DATA.run.endedAt, flags: [], ruleActions: DATA.run.ruleActions!.map(({ eventIds: _e, reason: _r, ...a }) => a) },
  events: EVENTS.map(({ ruleActions: _ra, ...e }) => e),
};

export function RunPreview() {
  const old = useSearchParams().get('engine') === 'old';
  return (
    <AppShell>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flex: 1 }}>
        <RunDetail fleetId="demo-fleet" runId="code-reviewer~4" preview={old ? OLD : DATA}
          previewTotals={old ? { calls: 7, failedCalls: 1, blockedCalls: 1, spendMicros: 52_000, unpricedAttempts: 0, wouldActCalls: 4 } : undefined} />
      </div>
    </AppShell>
  );
}
