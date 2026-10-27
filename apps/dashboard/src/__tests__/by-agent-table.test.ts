// Performance › By agent, rendered to HTML (react-dom/server): the table for
// wide screens and the per-agent cards that replace it on phones.
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ByAgentTable } from '@/components/performance/SavingsPanels';
import type { AgentScore } from '@/lib/whiteroom/types';

const rows = [
  { agent: 'lead-agent', used: 87_400, saved: 2_790_000 },
  { agent: 'writer-agent', used: 19_000, saved: 0 },
  { agent: '', used: 1_200, saved: 0 },
];
const scores = { 'lead-agent': { agentId: 'lead-agent', calls: 100, completeRate: 100, costDiligence: null, speedScore: 100, score: 10 } as AgentScore };
const ruleActions = { 'lead-agent': { blocks: 0, wouldBlocks: 59 } };
const cards = (html: string) => html.slice(html.indexOf('class="wr-byagent-cards"'));

describe('By agent', () => {
  it('renders the table and one phone card per agent', () => {
    const html = renderToStaticMarkup(h(ByAgentTable, { rows, scope: 'last 7 days', ruleActions, scores }));
    expect(html).toContain('class="wr-byagent-table"');
    expect(cards(html).match(/<li>/g)).toHaveLength(3);
    expect(cards(html)).toContain('lead-agent');
    expect(cards(html)).toContain('Unattributed');
  });

  it('a card shows tokens and saved, and rule actions and the wheel only when there are some', () => {
    const c = cards(renderToStaticMarkup(h(ByAgentTable, { rows, scope: 'last 7 days', ruleActions, scores })));
    const lead = c.slice(0, c.indexOf('writer-agent'));
    const writer = c.slice(c.indexOf('writer-agent'));
    expect(lead).toContain('87.4K');
    expect(lead).toContain('59 would have acted');
    expect(lead).toContain('aria-label="Performance score 10 of 10');
    expect(writer).not.toContain('Rule activity');
    expect(writer).not.toContain('Performance score');
  });

  it('no rows: a plain line, no table or cards', () => {
    const html = renderToStaticMarkup(h(ByAgentTable, { rows: [], scope: 'last 7 days' }));
    expect(html).toContain('No agent activity in this range.');
    expect(html).not.toContain('wr-byagent-cards');
  });
});
