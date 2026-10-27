// The agent page put together: Last 7 days above the grid, and Rules on this
// agent beside Recent runs.
import { describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GovernanceRule } from '@/lib/whiteroom/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => ({ status: 'authenticated', fleetId: 'f' }) }));
const { AgentDetail } = await import('@/components/agent/AgentDetail');
const { weekWindow } = await import('@/lib/home-agents');

const RULE: GovernanceRule = { id: 'r9', fleetId: 'f', changedBy: 'x', changedAt: '2026-10-01T00:00:00Z', version: 1, response: 'block', ruleType: 'call_rate', mode: 'enforce', appliesTo: 'all', params: { maxCalls: 60 } };

describe('agent page layout', () => {
  it('shows the week first, the rules on it, and none of the cut panels', () => {
    const html = renderToStaticMarkup(h(AgentDetail, {
      fleetId: 'f', agentId: 'lead-agent', from: 'home',
      preview: {
        agent: { agentId: 'lead-agent', status: 'idle', watchNumber: 2, tasksCompleted: 3 },
        handover: null, entries: [],
        week: { used: 1_000, saved: 3_000, rules: { blocks: 1, wouldBlocks: 0 } },
        rules: [RULE],
      },
    }));
    const at = (s: string) => html.indexOf(s);
    expect(at('Last 7 days')).toBeGreaterThan(-1);
    expect(at('Last 7 days')).toBeLessThan(at('Current run'));
    expect(html).toContain('1 blocked');
    expect(at('Rules on this agent')).toBeGreaterThan(-1);
    expect(at('Rules on this agent')).toBeLessThan(at('Recent runs'));
    expect(html).toContain('href="/controls?rule=r9"');
  });
});

describe('weekWindow', () => {
  it('starts at local midnight six days ago and counts whole hours back to it', () => {
    const now = new Date(2026, 9, 27, 15, 30).getTime();
    const { start, hours } = weekWindow(now);
    expect(start.getTime()).toBe(new Date(2026, 9, 21, 0, 0).getTime());
    const HOUR = 3_600_000;
    expect(hours).toBe(Math.floor(now / HOUR) + 1 - Math.floor(start.getTime() / HOUR));
    expect(hours).toBeGreaterThanOrEqual(6 * 24 + 15);
  });
});
