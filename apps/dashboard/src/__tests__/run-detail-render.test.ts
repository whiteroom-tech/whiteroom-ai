// @vitest-environment happy-dom
// A run's page in a DOM (sample data, nothing fetched): the summary line, Rule
// activity rows that jump to their call, the shaded timeline with its marks and
// legend, and Copy link copying this run's address.
import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { RunEventsResult } from '@/lib/whiteroom/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

const { RunDetail } = await import('@/components/runs/RunDetail');
const now = new Date().toISOString();
const DATA: RunEventsResult = {
  fleetId: 'f1',
  run: {
    runId: 'lead-agent~14', agentId: 'lead-agent', shift: 14, startedAt: now, endedAt: now, flags: [],
    calls: 2, spendMicros: 50_000, failedCalls: 0, blockedCalls: 0, wouldBlockCalls: 2, models: ['claude-sonnet-4-5'],
    ruleActions: [{ at: now, ruleId: 'gr_allow', ruleType: 'model_allowlist', response: 'block', mode: 'watch', occurrences: 2, reason: 'model_not_allowed', eventIds: ['call:2'] }],
  },
  events: [
    { id: 'e1', kind: 'event', at: now, type: 'watch_start', detail: { agentId: 'lead-agent' } },
    { id: 'call:1', kind: 'call', at: now, type: 'complete', model: 'claude-sonnet-4-5', ruleActions: [{ ruleId: 'gr_allow', ruleType: 'model_allowlist', mode: 'watch', response: 'block', outcome: 'would_block', reason: 'model_not_allowed' }] },
    { id: 'call:2', kind: 'call', at: now, type: 'complete', model: 'claude-sonnet-4-5', ruleActions: [{ ruleId: 'gr_allow', ruleType: 'model_allowlist', mode: 'watch', response: 'block', outcome: 'would_block', reason: 'model_not_allowed' }] },
  ],
  page: 0, pages: 1, total: 3, eventFound: null,
};

async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(RunDetail, { fleetId: 'f1', runId: 'lead-agent~14', preview: DATA })); });
  return { el, root };
}

describe('run page', () => {
  it('reads like the mockup: summary, rule activity, shaded calls, marks and legend', async () => {
    const { el, root } = await mount();
    const text = el.textContent ?? '';
    expect(el.querySelector('.wr-run-summary')?.textContent).toMatch(/· 2 model calls · \$0\.05 · 0 failed · 2 would have blocked · claude-sonnet-4-5$/);
    expect(text).toContain('Model allowlist would have blocked 2 calls: model not on the allowlist');
    expect(text).toContain('These rules are Record only, so the calls went through.');
    expect([...el.querySelectorAll('a')].find((a) => a.textContent?.startsWith('Open Model allowlist in Controls'))?.getAttribute('href')).toBe('/controls?rule=gr_allow');
    expect(el.querySelectorAll('.wr-timeline > li.is-shaded')).toHaveLength(2);
    expect(text).toContain('would have been blocked: model not on the allowlist');
    // The model is in the summary line, so the calls don't repeat it.
    expect([...el.querySelectorAll('.wr-timeline__text')].map((t) => t.textContent)).toEqual(['Run started', 'Model call', 'Model call']);
    expect([...el.querySelectorAll('.wr-timeline__glyph')].map((g) => g.textContent)).toEqual(['▶', '◇', '◇']);
    expect(el.querySelector('.wr-timeline__legend')?.textContent).toContain('blocked or failed');
    expect(text).toContain('This run is part of your audit trail.');
    root.unmount();
  });

  it('moves focus to the call a Rule activity row names', async () => {
    const { el, root } = await mount();
    const see = [...el.querySelectorAll('button')].find((b) => b.textContent === 'See in timeline')!;
    await act(async () => { see.click(); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.activeElement?.id).toBe('run-event-call:2');
    expect(el.querySelector('#run-event-call\\:2')?.classList.contains('is-highlighted')).toBe(true);
    root.unmount();
  });

  it('copies this run’s address, and says if it couldn’t', async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('no'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { el, root } = await mount();
    const button = () => [...el.querySelectorAll('button')].find((b) => /Copy link|Link copied|Couldn’t copy/.test(b.textContent ?? ''))!;
    await act(async () => { button().click(); });
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(button().textContent).toBe('Link copied');
    await act(async () => { button().click(); });
    expect(button().textContent).toBe('Couldn’t copy');
    root.unmount();
  });

  it('says it couldn’t copy in a browser with no clipboard at all', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const { el, root } = await mount();
    const button = () => [...el.querySelectorAll('button')].find((b) => /Copy link|Couldn’t copy/.test(b.textContent ?? ''))!;
    await act(async () => { button().click(); });
    expect(button().textContent).toBe('Couldn’t copy');
    root.unmount();
  });
});
