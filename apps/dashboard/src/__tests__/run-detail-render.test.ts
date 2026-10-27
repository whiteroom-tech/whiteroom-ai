// @vitest-environment happy-dom
// A run's page in a DOM (sample data, nothing fetched): each rule activity row
// links to its rule on Controls, and Copy link copies this run's address.
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
  run: { runId: 'lead-agent~14', agentId: 'lead-agent', shift: 14, startedAt: now, endedAt: now, flags: [], ruleActions: [{ at: now, ruleId: 'gr_cap', ruleType: 'spend_cap', response: 'block', mode: 'watch', occurrences: 2 }] },
  events: [], page: 0, pages: 1, total: 0, eventFound: null,
};

async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(RunDetail, { fleetId: 'f1', runId: 'lead-agent~14', preview: DATA })); });
  return { el, root };
}

describe('run page', () => {
  it('links each rule activity row to its rule on Controls', async () => {
    const { el, root } = await mount();
    const link = [...el.querySelectorAll('a')].find((a) => a.textContent?.startsWith('See the rule'))!;
    expect(link.getAttribute('href')).toBe('/controls?rule=gr_cap');
    expect(el.textContent).toContain('would block the call · Record only · ×2');
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
});
