// Agent page › Last 7 days and Rules on this agent (redesign Phase 6a).
import { describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GovernanceRule } from '@/lib/whiteroom/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }), useSearchParams: () => new URLSearchParams() }));
const { AgentWeekCard } = await import('@/components/agent/AgentWeekCard');
const { RulesOnAgent } = await import('@/components/agent/RulesOnAgent');
const { weekTokens } = await import('@/lib/agent-detail');
const { outOfTen, scoreParts, scoreSummary, scoreWorking } = await import('@/lib/agent-scores');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('Last 7 days on the agent page', () => {
  it('shows tokens without and with WhiteRoom, rule activity and the score with its parts', () => {
    const t = text(renderToStaticMarkup(h(AgentWeekCard, { fleetId: 'f', agentId: 'a', preview: {
      used: 53_400, saved: 225_800, rules: { blocks: 2, wouldBlocks: 58 },
      score: { agentId: 'a', calls: 10, completeRate: 100, costDiligence: null, speedScore: 57, score: 8 },
    } })));
    expect(t).toContain('Tokens without WhiteRoom, est. 279K');
    expect(t).toContain('With WhiteRoom 53.4K 226K less (81%)');
    expect(t).toContain('Rule activity 2 blocked · 58 would have blocked');
    expect(t).toContain('Score 8 out of 10');
    expect(t).toContain('How is the score worked out? Clean calls 10 · Speed 5.7 · Cost not scored yet');
    expect(t).toContain('Clean calls 10 of 10');
    expect(t).toContain('Speed 5.7 of 10');
    expect(t).toContain('Cost not scored');
    expect(t).toContain('Needs a task type and a finished call.');
    expect(t).toContain('(10 + 5.7) ÷ 2 = 7.85 → 8');
  });

  it('shows — when a read failed, never 0, and no score breakdown without a score', () => {
    const t = text(renderToStaticMarkup(h(AgentWeekCard, { fleetId: 'f', agentId: 'a', preview: {} })));
    expect(t).toContain('Tokens without WhiteRoom, est. —');
    expect(t).toContain('Rule activity —');
    expect(t).not.toContain('How is the score');
  });

  it('works out the token figures, or none when usage is unknown', () => {
    expect(weekTokens(undefined)).toBeNull();
    expect(weekTokens({ saved: 5 })).toBeNull();
    expect(weekTokens({ used: 0 })).toEqual({ without: 0, used: 0, saved: 0, pct: 0 });
    expect(weekTokens({ used: 25, saved: 75 })).toEqual({ without: 100, used: 25, saved: 75, pct: 75 });
  });

  it('offers "Set a task type" on the Cost row when the agent has none', () => {
    const html = renderToStaticMarkup(h(AgentWeekCard, { fleetId: 'f', agentId: 'a', hasTaskType: false, onSetTaskType: () => {}, preview: {
      score: { agentId: 'a', calls: 10, completeRate: 100, costDiligence: null, speedScore: 57, score: 8 },
    } }));
    expect(text(html)).toContain('Set a task type to include it.');
    const withType = renderToStaticMarkup(h(AgentWeekCard, { fleetId: 'f', agentId: 'a', hasTaskType: true, onSetTaskType: () => {}, preview: {
      score: { agentId: 'a', calls: 10, completeRate: 100, costDiligence: null, speedScore: 57, score: 8 },
    } }));
    expect(text(withType)).not.toContain('Set a task type');
  });

  it('names the parts as the wheel does, scored ones first, on a 0-10 scale', () => {
    const parts = scoreParts({ completeRate: 1, costDiligence: 2, speedScore: 3 });
    expect(parts.map((p) => [p.label, p.value])).toEqual([['Clean calls', 1], ['Speed', 3], ['Cost', 2]]);
    expect([outOfTen(100), outOfTen(57), outOfTen(0), outOfTen(84.6)]).toEqual(['10', '5.7', '0', '8.46']);
    expect(scoreSummary([{ label: 'Clean calls', value: 100 }, { label: 'Cost', value: null }])).toBe('Clean calls 10 · Cost not scored yet');
  });

  it('works the score out as the rounded average of the scored parts', () => {
    expect(scoreWorking([{ value: 100 }, { value: 57 }, { value: null }])).toEqual({ sum: '(10 + 5.7) ÷ 2 = 7.85 → 8', score: 8 });
    expect(scoreWorking([{ value: 40 }])).toEqual({ sum: '4 → 4', score: 4 });
    expect(scoreWorking([{ value: null }])).toBeNull();
    // Unrounded parts, so the sum ends on the score the ring shows (8.46 → 8, not 8.5 → 9).
    expect(scoreWorking([{ value: 84.6 }, { value: 84.6 }])).toEqual({ sum: '(8.46 + 8.46) ÷ 2 = 8.46 → 8', score: 8 });
    // Enough places that the rounding shows, and it ends on the engine's score when there is one.
    expect(scoreWorking([{ value: 74.96 }, { value: 74.96 }])?.sum).toBe('(7.496 + 7.496) ÷ 2 = 7.496 → 7');
    expect(scoreWorking([{ value: 100 }, { value: 57 }], 8)).toEqual({ sum: '(10 + 5.7) ÷ 2 = 7.85 → 8', score: 8 });
  });
});

describe('Rules on this agent', () => {
  const base = { fleetId: 'f', changedBy: 'x', changedAt: '2026-10-01T00:00:00Z', version: 1, response: 'block' as const };
  const rules: GovernanceRule[] = [
    { ...base, id: 'r1', ruleType: 'loop_breaker', mode: 'enforce', appliesTo: 'all', params: { threshold: 100, scope: 'run', ignoreTools: [] } },
    { ...base, id: 'r2', ruleType: 'call_rate', mode: 'watch', appliesTo: ['a'], params: { maxCalls: 60 } },
    { ...base, id: 'r3', ruleType: 'call_rate', mode: 'watch', appliesTo: ['other'], params: { maxCalls: 5 } },
    { ...base, id: 'r4', ruleType: 'tool_list', mode: 'off', appliesTo: 'all', params: { blockedTools: [] } },
  ];

  it('lists the rules that are on for it, linked to Controls, and counts the Off ones', () => {
    const html = renderToStaticMarkup(h(RulesOnAgent, { fleetId: 'f', agentId: 'a', preview: rules }));
    expect(html).toContain('href="/controls?rule=r1"');
    expect(html).toContain('href="/controls?rule=r2"');
    expect(html).not.toContain('rule=r3');
    expect(html).toContain('href="/controls?agent=a"');
    const t = text(html);
    expect(t).toContain('Blocks');
    expect(t).toContain('it would block the call');
    expect(t).toContain('1 more rule is Off.');
  });

  it('says so when none are on', () => {
    const t = text(renderToStaticMarkup(h(RulesOnAgent, { fleetId: 'f', agentId: 'a', preview: [rules[3]] })));
    expect(t).toContain('No rules are on for this agent. 1 rule is Off.');
  });
});
