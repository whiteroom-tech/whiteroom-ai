// The agent page put together, as in the mockup: Last 7 days above the grid,
// Now, Task type and Rules on this agent on the left, Recent runs and
// activity on the right, and none of the cut panels.
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
  it('shows the week first, then Now, Task type and the rules, then Recent runs', () => {
    const html = renderToStaticMarkup(h(AgentDetail, {
      fleetId: 'f', agentId: 'lead-agent', from: 'home',
      preview: {
        agent: { agentId: 'lead-agent', status: 'idle', govV1: true, currentShift: null, lastShift: { watchNumber: 2, tasksCompleted: 3, tokensUsed: 10, minutesWorked: 1 } },
        entries: [],
        week: { used: 1_000, saved: 3_000, rules: { blocks: 1, wouldBlocks: 0 } },
        rules: [RULE],
      },
    }));
    const at = (s: string) => html.indexOf(s);
    expect(at('Last 7 days')).toBeGreaterThan(-1);
    expect(at('Last 7 days')).toBeLessThan(at('>Now<'));
    expect(at('>Now<')).toBeLessThan(at('Task type'));
    expect(at('Task type')).toBeLessThan(at('Rules on this agent'));
    expect(at('Rules on this agent')).toBeLessThan(at('Recent runs'));
    expect(html).toContain('>blocked<');
    expect(html).toContain('Last run');
    expect(html).toContain('href="/controls?rule=r9"');
  });

  it('has one Pause button and a ⋯ menu, with "← Home" above the title', () => {
    const html = renderToStaticMarkup(h(AgentDetail, {
      fleetId: 'f', agentId: 'lead-agent', from: 'home',
      preview: { agent: { agentId: 'lead-agent', status: 'idle', govV1: true }, entries: [], rules: [] },
    }));
    expect(html.indexOf('← Home')).toBeLessThan(html.indexOf('<h1'));
    expect(html).toContain('>Pause<');
    expect(html).toContain('aria-label="More actions"');
    expect(html).not.toContain('>Resume<');
    expect(html).not.toContain('Start a break');
    expect(html).toContain('Waiting for work');
  });
});

describe('agent page, what it leaves out', () => {
  it('has no Goal, "What it carries forward" or Progress notes panel', () => {
    const html = renderToStaticMarkup(h(AgentDetail, {
      fleetId: 'f', agentId: 'lead-agent', from: 'home',
      preview: { agent: { agentId: 'lead-agent', status: 'working', watchNumber: 2, tasksCompleted: 3 }, entries: [], rules: [RULE] },
    }));
    expect(html).not.toMatch(/>Goal</);
    expect(html).not.toMatch(/carries forward/i);
    expect(html).not.toMatch(/notes/i);
  });
});

describe('agent page, health line', () => {
  it('shows the fleet health check for this agent when there is one', () => {
    const html = renderToStaticMarkup(h(AgentDetail, {
      fleetId: 'f', agentId: 'lead-agent', from: 'home',
      preview: {
        agent: { agentId: 'lead-agent', status: 'idle' }, entries: [], rules: [],
        diagnosis: { checkedAt: new Date().toISOString(), source: 'manual', waiting: [], skipped: [], truncated: false, readyAgents: 1, busiest: null, minCalls: 50,
          reports: [{ schema: 'diagnosis.v1', agentId: 'lead-agent', window: { from: '', to: '', days: 7, calls: 9, watches: 1 }, findings: [], clear: [{ detector: 'review_tool_errors', note: null }], notMeasured: [] }] },
      },
    }));
    expect(html).toContain('Health check');
    expect(html).toContain('1 check passed');
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
