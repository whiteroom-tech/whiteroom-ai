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
  build: vi.fn((_s: unknown) => new Uint8Array([1])),
  actors: vi.fn(async () => [] as unknown[]),
}));
vi.mock('@/lib/whiteroom/client', async (orig) => ({ ...(await orig<typeof import('@/lib/whiteroom/client')>()), healthHistory: api.history }));
vi.mock('@/lib/xlsx', async (orig) => ({ ...(await orig<typeof import('@/lib/xlsx')>()), downloadWorkbook: api.download, buildWorkbook: api.build }));
vi.mock('@/lib/control-actors', async (orig) => ({ ...(await orig<typeof import('@/lib/control-actors')>()), fetchControlActors: api.actors }));

const { HealthHistory } = await import('@/components/agent/HealthHistory');
const { downloadHealthReport, TRUNCATED_NOTE } = await import('@/components/performance/HealthReport');
const { ControlDeniedError } = await import('@/lib/whiteroom/client');
const { localDay } = await import('@/lib/runs');
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
beforeEach(() => { api.history.mockReset(); api.download.mockReset(); api.build.mockClear(); api.actors.mockClear(); document.body.innerHTML = ''; });

describe('Agent detail › Health history', () => {
  it('lists the newest ten, says how many more, and names who acted', async () => {
    api.history.mockResolvedValue({ events: [ev(0, { event: 'snoozed', actor: 'user:u9' }), ...Array.from({ length: 11 }, (_, i) => ev(i + 1))], cursor: null });
    const m = await mount(h(HealthHistory, { fleetId: 'f', agentId: 'a' }));
    expect(api.history).toHaveBeenCalledWith('f', expect.objectContaining({ agentId: 'a' }), undefined);
    expect(m.el.querySelectorAll('li')).toHaveLength(10);
    expect(m.text()).toContain('Repeating the same call: Snoozed by a teammate');
    expect(m.text()).toContain('2 more in the health report: Download report on Performance.');
    m.root.unmount();
  });

  it('with more pages than one, says there is more without a count', async () => {
    api.history.mockResolvedValue({ events: Array.from({ length: 12 }, (_, i) => ev(i)), cursor: 'next' });
    const m = await mount(h(HealthHistory, { fleetId: 'f', agentId: 'a' }));
    expect(m.text()).toContain('More in the health report');
    expect(m.text()).not.toMatch(/\d+ more in/);
    m.root.unmount();
  });

  it('names the person who acted, looked up from the oldest event with one; no lookup when nobody acted', async () => {
    api.actors.mockResolvedValueOnce([{ action: 'x', agentId: null, ruleId: null, userId: 'u1', by: 'R Haque', at: '2026-11-10T11:00:00Z' }]);
    api.history.mockResolvedValue({ events: [ev(0, { event: 'dismissed', actor: 'user:u1' }), ev(5, { event: 'snoozed', actor: 'user:u1' }), ev(9)], cursor: null });
    let m = await mount(h(HealthHistory, { fleetId: 'f', agentId: 'a' }));
    await flush();
    expect(api.actors).toHaveBeenCalledWith('f', ev(5).at);
    expect(m.text()).toContain('Dismissed by R Haque');
    m.root.unmount();
    api.actors.mockClear();
    api.history.mockResolvedValue({ events: [ev(0), ev(1, { event: 'resolved' })], cursor: null });
    m = await mount(h(HealthHistory, { fleetId: 'f', agentId: 'a' }));
    expect(api.actors).not.toHaveBeenCalled();
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

  it('downloads a workbook named for the viewer’s day, with a note when older entries were left out', async () => {
    api.history.mockResolvedValue({ events: [ev(0, { actor: 'user:u1' })], cursor: 'more' });
    expect(await downloadHealthReport('f', null)).toBeNull();
    expect(api.history).toHaveBeenCalledTimes(10);
    expect(api.actors).toHaveBeenCalledWith('f', expect.any(String));
    expect(api.download).toHaveBeenCalledWith(expect.any(Uint8Array), `whiteroom-health-${localDay(Date.now())}.xlsx`);
    const sheets = api.build.mock.calls[0][0] as Array<{ name: string; rows: unknown[][] }>;
    expect(sheets[1].rows).toHaveLength(11);
    expect(sheets[1].rows.at(-1)).toEqual(['', '', '', TRUNCATED_NOTE, '']);
  });

  it('a complete history has no note', async () => {
    api.history.mockResolvedValue({ events: [ev(0)], cursor: null });
    expect(await downloadHealthReport('f', null)).toBeNull();
    const sheets = api.build.mock.calls[0][0] as Array<{ rows: unknown[][] }>;
    expect(sheets[1].rows.flat()).not.toContain(TRUNCATED_NOTE);
  });

  it('a teammate who isn’t the owner is told so, not asked to try again', async () => {
    api.history.mockRejectedValue(new ControlDeniedError('Only the fleet’s owner can do this.'));
    expect(await downloadHealthReport('f', null)).toBe('Only the fleet’s owner can do this.');
    expect(api.download).not.toHaveBeenCalled();
  });

  it('a failed name lookup still downloads, naming the person as a teammate', async () => {
    api.history.mockResolvedValue({ events: [ev(0, { event: 'snoozed', actor: 'user:u1' })], cursor: null });
    // The real lookup, with its request failing.
    const real = await vi.importActual<typeof import('@/lib/control-actors')>('@/lib/control-actors');
    api.actors.mockImplementationOnce((fleetId: string, since?: string) => real.fetchControlActors(fleetId, since));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    expect(await downloadHealthReport('f', null)).toBeNull();
    const sheets = api.build.mock.calls[0][0] as Array<{ rows: unknown[][] }>;
    expect(sheets[1].rows[0][4]).toBe('a teammate');
    vi.unstubAllGlobals();
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

  it('any other failure is rethrown by the download, and the link says to try again and is usable again', async () => {
    api.history.mockRejectedValue(new Error('engine down'));
    await expect(downloadHealthReport('f', null)).rejects.toThrow('engine down');
    const onReport = vi.fn(() => downloadHealthReport('f', null));
    const m = await mount(h(AgentHealth, { flagged, diagnosis, line: null, onCheck: () => {}, onReview: () => {}, onReport }));
    const link = () => [...m.el.querySelectorAll('button')].find((b) => /report|Preparing/.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => { link().click(); });
    await flush();
    expect(m.el.querySelector('[role="alert"]')?.textContent).toBe('The report couldn’t be made. Try again.');
    expect(link().textContent).toBe('Download report');
    expect(link().disabled).toBe(false);
    m.root.unmount();
  });

  it('no link when the page gives no way to make one', async () => {
    const m = await mount(h(AgentHealth, { flagged, diagnosis, line: null, onCheck: () => {}, onReview: () => {} }));
    expect(m.text()).not.toContain('Download report');
    m.root.unmount();
  });
});
