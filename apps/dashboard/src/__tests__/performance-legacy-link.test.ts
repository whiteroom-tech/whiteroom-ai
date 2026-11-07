// @vitest-environment happy-dom
// Old per-agent Performance links (?view=agent / ?view=evidence with ?agent=)
// go to the agent's own page, and nothing on the way rewrites the URL back to
// /performance or starts the overview's reads.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.push }),
  useSearchParams: () => nav.params,
  usePathname: () => '/performance',
}));
vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => ({ status: 'authenticated', fleetId: 'f1', authKey: 'k', resetSession: vi.fn() }) }));
const api = vi.hoisted(() => ({ index: vi.fn() }));
// Every read the overview starts stays pending: these tests are about where the page goes, not what it shows.
const pending = () => new Promise(() => {});
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  performanceIndex: api.index, performanceFleetHourly: pending, auditSummary: pending, performanceCostForecast: pending, governanceList: pending,
}));

const { PerformancePage } = await import('@/app/(citadel)/performance/_components/PerformancePage');

beforeEach(() => { nav.replace.mockReset(); nav.push.mockReset(); api.index.mockReset(); api.index.mockReturnValue(new Promise(() => {})); });

async function open(query: string) {
  nav.params = new URLSearchParams(query);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(PerformancePage)); });
  return { el, root };
}

describe('old per-agent Performance links', () => {
  it.each([['view=agent&agent=lead-agent'], ['view=evidence&agent=lead-agent&hours=72']])('%s goes to the agent page, and only there', async (query) => {
    const { el, root } = await open(query);
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenLastCalledWith('/agents/lead-agent');
    expect(el.textContent).toContain('Opening lead-agent');
    expect(api.index).not.toHaveBeenCalled();
    root.unmount();
  });

  it('a plain visit stays on Performance and loads the overview', async () => {
    const { root } = await open('');
    expect(nav.replace.mock.calls.every(([to]) => !String(to).startsWith('/agents/'))).toBe(true);
    expect(api.index).toHaveBeenCalled();
    root.unmount();
  });
});
