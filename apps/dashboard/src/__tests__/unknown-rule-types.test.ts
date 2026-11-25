// @vitest-environment happy-dom
// A newer engine can list a rule type this build doesn't know. governanceList
// sets it aside (unknownRules) and drops its history, and Performance › Rules
// names it plainly instead of as another type or as removed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { governanceList } from '@/lib/whiteroom/client';
import { topCaught } from '@/lib/performance-overview';
import { RulesSummary } from '@/app/(citadel)/performance/_components/RulesSummary';
import type { GovernanceRule } from '@/lib/whiteroom/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = { fleetId: 'f', version: 1, changedBy: 'test', changedAt: '2026-10-20T00:00:00Z', response: 'block' as const };
const KNOWN: GovernanceRule = { ...base, id: 'gr_m', ruleType: 'model_allowlist', mode: 'watch', appliesTo: 'all', params: { allowedModels: ['model-a'] } };
const FUTURE = { ...base, id: 'gr_x', ruleType: 'made_up_type', mode: 'enforce', appliesTo: ['agent-a'], params: { somethingNew: ['x'] } };
const acts = (blocked: number, wouldAct: number) => ({ blocked, wouldAct, paused: 0, stopped: 0, toldYou: 0 });

describe('governanceList with a rule type this build doesn’t know', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('keeps known rules as they are and sets the other aside, with its history left out', async () => {
    const history = [
      { id: 'h1', ruleId: 'gr_m', ruleType: 'model_allowlist', description: 'Added new Model allowlist rule', by: 'u', time: '2026-10-20T00:00:00Z' },
      { id: 'h2', ruleId: 'gr_x', ruleType: 'made_up_type', description: 'Removed rule', by: 'u', time: '2026-10-20T00:00:00Z', before: { mode: 'enforce', appliesTo: 'all', params: {} }, after: null },
    ];
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ fleetId: 'f', rules: [KNOWN, FUTURE], history, agents: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const res = await governanceList('f', 'sk-key');
    expect(res.rules).toEqual([KNOWN]);
    expect(res.unknownRules).toEqual([{ id: 'gr_x', mode: 'enforce', appliesTo: ['agent-a'] }]);
    expect(res.history.map((e) => e.id)).toEqual(['h1']);
  });

  it('knows Repeated blocks and Old tool results, and still sets a type it doesn’t know aside', async () => {
    const streak = { ...base, id: 'gr_b', ruleType: 'block_streak', mode: 'watch', response: 'pause', appliesTo: 'all', params: { threshold: 3 } };
    const trim = { ...base, id: 'gr_t', ruleType: 'trim_results', mode: 'enforce', response: 'notify', appliesTo: 'all', params: { keepRecent: 5, minTokens: 50000 } };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ fleetId: 'f', rules: [streak, FUTURE, trim], history: [], agents: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const res = await governanceList('f', 'sk-key');
    expect(res.rules).toEqual([streak, trim]);
    expect(res.unknownRules).toEqual([{ id: 'gr_x', mode: 'enforce', appliesTo: ['agent-a'] }]);
  });

  it('passes a list of known rules through untouched', async () => {
    const body = { fleetId: 'f', rules: [KNOWN], history: [], agents: [] };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const res = await governanceList('f', 'sk-key');
    expect(res).toEqual(body);
  });
});

describe('Performance › Rules with a rule type this build doesn’t know', () => {
  const byRuleId = { gr_x: acts(3, 80), gr_m: acts(0, 60), gr_gone: acts(0, 1) };
  const unknown = [{ id: 'gr_x', mode: 'enforce' as const, appliesTo: 'all' as const }];

  it('names it plainly, with its mode and no link, and keeps a removed rule as removed', () => {
    expect(topCaught(null, byRuleId, [KNOWN], unknown).map((r) => [r.label, r.blocked, r.wouldBlock, r.mode, r.ruleId])).toEqual([
      ['A rule this version can’t show', 3, 80, 'enforce', null],
      ['Model allowlist', 0, 60, 'watch', 'gr_m'],
      ['A rule since removed', 0, 1, null, null],
    ]);
  });

  it('renders the row in the summary, unlinked: there is no rule this build can open', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    const counts = { blocks: 3, wouldBlocks: 141, byAgent: {}, byRule: { spend_cap: { blocks: 0, wouldBlocks: 0 }, loop_breaker: { blocks: 0, wouldBlocks: 0 }, model_allowlist: { blocks: 0, wouldBlocks: 60 }, tool_list: { blocks: 0, wouldBlocks: 0 }, call_rate: { blocks: 0, wouldBlocks: 0 }, keyword: { blocks: 0, wouldBlocks: 0 }, send_limit: { blocks: 0, wouldBlocks: 0 }, outside_then_send: { blocks: 0, wouldBlocks: 0 }, block_streak: { blocks: 0, wouldBlocks: 0 }, trim_results: { blocks: 0, wouldBlocks: 0 }, data_deletion: { blocks: 0, wouldBlocks: 0 } } };
    await act(async () => { root.render(h(RulesSummary, { counts, byRuleId, rules: [KNOWN], unknownRules: unknown, unavailable: false })); });
    // The top rules are on show, not folded.
    expect(el.querySelector('button[aria-expanded]')).toBeNull();
    const rows = [...el.querySelectorAll('.wr-ctrl__row')];
    expect(rows[0].textContent).toContain('A rule this version can’t show');
    expect(rows[0].tagName).toBe('DIV');
    expect(rows[1].tagName).toBe('A');
    root.unmount();
  });
});
