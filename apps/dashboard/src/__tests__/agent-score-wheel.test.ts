// By agent › Performance wheel, rendered to HTML (react-dom/server).
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentScoreWheel } from '@/components/performance/AgentScoreWheel';
import type { AgentScore } from '@/lib/whiteroom/types';

const agent = (a: Partial<AgentScore>): AgentScore =>
  ({ agentId: 'lead-agent', calls: 100, completeRate: 100, costDiligence: null, speedScore: 100, score: 10, ...a }) as AgentScore;

describe('AgentScoreWheel', () => {
  it('shows the score, a legend row per part, and a bar sized to each value', () => {
    const html = renderToStaticMarkup(h(AgentScoreWheel, { agent: agent({ completeRate: 92, costDiligence: 55, speedScore: 81, score: 8 }) }));
    expect(html).toContain('aria-label="Performance score 8 of 10 — Task success: 92/100 · Cost diligence: 55/100 · Speed: 81/100"');
    expect(html.match(/<path /g)).toHaveLength(3);
    for (const w of ['Tasks', 'Cost', 'Speed']) expect(html).toContain(`>${w}<`);
    for (const pct of ['92%', '55%', '81%']) expect(html).toContain(`width:${pct}`);
  });

  it('a part with no data has an empty track and a dash, not a zero bar', () => {
    const html = renderToStaticMarkup(h(AgentScoreWheel, { agent: agent({}) }));
    expect(html.match(/width:\d+%/g)).toEqual(['width:100%', 'width:100%']);
    expect(html).toContain('>–<');
  });

  it('clamps a bar to 0–100', () => {
    const html = renderToStaticMarkup(h(AgentScoreWheel, { agent: agent({ completeRate: 140, speedScore: -5 }) }));
    expect(html).toContain('width:100%');
    expect(html).toContain('width:0%');
  });

  it('no score yet is a dash', () => {
    expect(renderToStaticMarkup(h(AgentScoreWheel, { agent: agent({ score: null }) }))).toContain('–');
  });
});
