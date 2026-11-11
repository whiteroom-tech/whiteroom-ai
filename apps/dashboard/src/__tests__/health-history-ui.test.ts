// @vitest-environment happy-dom
// Health history on screen (Agent Health item 9): Agent detail's list, the
// Agent health report link, and the report download.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { HealthHistoryEvent } from '@/lib/whiteroom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  history: vi.fn(),
  download: vi.fn(),
  actors: vi.fn(async () => [] as unknown[]),
}));
vi.mock('@/lib/whiteroom/client', async (orig) => ({ ...(await orig<typeof import('@/lib/whiteroom/client')>()), healthHistory: api.history }));
vi.mock('@/lib/xlsx', async (orig) => ({ ...(await orig<typeof import('@/lib/xlsx')>()), downloadWorkbook: api.download }));
vi.mock('@/lib/control-actors', async (orig) => ({ ...(await orig<typeof import('@/lib/control-actors')>()), fetchControlActors: api.actors }));

const { HealthHistory } = await import('@/components/agent/HealthHistory');
const { downloadHealthReport } = await import('@/components/performance/HealthReport');
const { AgentHealth } = await import('@/components/performance/AgentHealth');

const ev = (i: number, p: Partial<HealthHistoryEvent> = {}): HealthHistoryEvent => ({ agentId: 'a', detector: 'review_tool_loops', event: 'opened', actor: null, at: new Date(Date.UTC(2026, 10, 10, 12) - i * 60_000).toISOString(), ...p });
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
async function mount(node: ReturnType<typeof h>) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(node); });
  await flush();
  return { el, root, text: () => el.textContent ?? '' };
}
beforeEach(() => { api.history.mockReset(); api.download.mockReset(); api.actors.mockClear(); document.body.innerHTML = ''; });

describe('Agent detail › Health history', () => {
  it('lists the newest ten, says how many more, and names who acted', async () => {
    api.history.mockResolvedValue({ events: [ev(0, { event: 'snoozed', actor: 'user:u9' }), ...Array.from({ length: 11 }, (_, i) => ev(i + 1))], cursor: null });
    const m = await mount(h(HealthHistory, { fleetId: 'f', agentId: 'a' }));
    expect(api.history).toHaveBeenCalledWith('f', expect.objectContaining({ agentId: 'a' }), undefined);
    expect(m.el.querySelectorAll('li')).toHaveLength(10);
    expect(m.text()).toContain('Repeating the same call: Snoozed by a teammate');
    expect(m.text()).toContain('2 more in the report on Performance.');
    m.root.unmount();
  });

  it('is hidden when there is nothing, on an engine without it, and when the read fails', async () => {
    // Made when read, so the failing one isn't an unhandled rejection meanwhile.
    for (const got of [() => Promise.resolve({ events: [], cursor: null }), () => Promise.resolve(null), () => Promise.reject(new Error('down'))]) {
      api.history.mockImplementationOnce(got);
      const m = await mount(h(HealthHistory, { fleetId: 'f', agentId: 'a' }));
      expect(m.text()).toBe('');
      m.root.unmount();
    }
  });
});

describe('Agent health › Download report', () => {
  const diagnosis = { reports: [], waiting: [], skipped: [], truncated: false, checkedAt: null, source: null, readyAgents: 0, busiest: null, minCalls: 50 } as never;
  const flagged = { runs: [], truncated: false, failed: false, loading: false, days: [] } as never;

  it('downloads a workbook named for today, with a note when older entries were left out', async () => {
    api.history.mockResolvedValue({ events: [ev(0, { actor: 'user:u1' })], cursor: 'more' });
    expect(await downloadHealthReport('f', null)).toBeNull();
    expect(api.history).toHaveBeenCalledTimes(10);
    expect(api.actors).toHaveBeenCalledWith('f', expect.any(String));
    expect(api.download).toHaveBeenCalledWith(expect.any(Uint8Array), expect.stringMatching(/^whiteroom-health-\d{4}-\d{2}-\d{2}\.xlsx$/));
  });

  it('says so, and downloads nothing, on an engine without history', async () => {
    api.history.mockResolvedValue(null);
    expect(await downloadHealthReport('f', null)).toBe('Health history isn’t available on this engine yet.');
    expect(api.download).not.toHaveBeenCalled();
  });

  it('the link shows Preparing… while it works, then an error if it failed', async () => {
    let finish: (v: string | null) => void = () => {};
    const onReport = vi.fn(() => new Promise<string | null>((r) => { finish = r; }));
    const m = await mount(h(AgentHealth, { flagged, diagnosis, line: null, onCheck: () => {}, onReview: () => {}, onReport }));
    const link = () => [...m.el.querySelectorAll('button')].find((b) => /report|Preparing/.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => { link().click(); });
    expect(link().textContent).toBe('Preparing…');
    expect(link().disabled).toBe(true);
    await act(async () => { finish('Health history isn’t available on this engine yet.'); });
    await flush();
    expect(link().textContent).toBe('Download report');
    expect(m.el.querySelector('[role="alert"]')?.textContent).toBe('Health history isn’t available on this engine yet.');
    m.root.unmount();
  });

  it('no link when the page gives no way to make one', async () => {
    const m = await mount(h(AgentHealth, { flagged, diagnosis, line: null, onCheck: () => {}, onReview: () => {} }));
    expect(m.text()).not.toContain('Download report');
    m.root.unmount();
  });
});
