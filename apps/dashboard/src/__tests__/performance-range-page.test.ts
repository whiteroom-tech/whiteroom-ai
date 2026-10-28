// @vitest-environment happy-dom
// Performance's range menu is Runs' (Today · 7 days · 30 days · Custom), and
// every range read gets the picked days as one window. An engine older than
// windows keeps Today and 7 days, with 30 days and Custom off and a note.
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
const api = vi.hoisted(() => ({ index: vi.fn(), hourly: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  performanceIndex: api.index, performanceFleetHourly: api.hourly, auditSummary: api.audit, performanceCostForecast: async () => ({}), governanceList: async () => ({ rules: [] }),
}));

const { WhiteRoomApiError } = await import('@/lib/whiteroom/client');
const { PerformancePage } = await import('@/app/(citadel)/performance/_components/PerformancePage');
const { addDays, dayStart, localDay } = await import('@/lib/runs');

beforeEach(() => {
  for (const f of [nav.replace, nav.push, api.index, api.hourly, api.audit]) f.mockReset();
  api.index.mockReturnValue(new Promise(() => {}));
  api.hourly.mockReturnValue(new Promise(() => {}));
  api.audit.mockReturnValue(new Promise(() => {}));
});

async function open(query: string, retentionDays?: number) {
  nav.params = new URLSearchParams(query);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(PerformancePage, { retentionDays })); });
  return { el, root };
}
const radio = (el: HTMLElement, label: string) => [...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === label)!;

describe('Performance range', () => {
  it('shows the Runs menu, and reads 30 days from local midnight 29 days ago to now', async () => {
    const { el, root } = await open('range=30d');
    expect([...el.querySelectorAll('[role="radio"]')].map((b) => b.textContent)).toEqual(['Today', '7 days', '30 days', 'Custom']);
    expect(radio(el, '30 days').getAttribute('aria-checked')).toBe('true');
    expect(el.textContent).not.toContain('to now');
    const from = dayStart(addDays(localDay(), -29));
    expect(api.index).toHaveBeenLastCalledWith('f1', undefined, 'k', { from, to: null });
    // Past the 14 days an older engine reads: no hours_back for it.
    expect(api.hourly).toHaveBeenLastCalledWith('f1', undefined, 'k', { from, to: null });
    expect(api.audit).toHaveBeenCalledWith('f1', from, 'k', undefined, undefined, null);
    root.unmount();
  });

  it('reads a custom range that ends in the past, and keeps it in the link', async () => {
    const f = addDays(localDay(), -20);
    const t = addDays(localDay(), -11);
    const { el, root } = await open(`range=custom&from=${f}&to=${t}`, 30);
    expect(api.index).toHaveBeenLastCalledWith('f1', undefined, 'k', { from: dayStart(f), to: dayStart(addDays(t, 1)) });
    expect((el.querySelector('#perf-from') as HTMLInputElement).value).toBe(f);
    expect((el.querySelector('#perf-to') as HTMLInputElement).value).toBe(t);
    // The plan keeps 30 days: the pickers start 29 days back.
    expect((el.querySelector('#perf-from') as HTMLInputElement).min).toBe(addDays(localDay(), -29));
    root.unmount();
  });

  it('Today reads from local midnight, with hours_back for older engines', async () => {
    const { el, root } = await open('');
    expect(radio(el, '7 days').getAttribute('aria-checked')).toBe('true');
    await act(async () => { radio(el, 'Today').click(); });
    const from = dayStart(localDay());
    expect(api.index).toHaveBeenLastCalledWith('f1', undefined, 'k', { from, to: null });
    const [, hours] = api.hourly.mock.lastCall!;
    expect(hours).toBeGreaterThanOrEqual(1);
    expect(hours).toBeLessThanOrEqual(25);
    expect(nav.replace).toHaveBeenLastCalledWith(expect.stringMatching(/\?range=today$/), { scroll: false });
    root.unmount();
  });

  it('on an engine without windows, turns 30 days and Custom off with a note, and shows 7 days', async () => {
    api.index.mockRejectedValueOnce(new WhiteRoomApiError('HTTP 400', 400, 'from must be an ISO timestamp within the last 14 days.'));
    api.hourly.mockResolvedValueOnce({ hourly: [] });
    api.audit.mockResolvedValue(null);
    const { el, root } = await open('range=30d');
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    expect(el.textContent).toContain('30 days and Custom aren’t available yet. Showing 7 days.');
    expect(radio(el, '30 days').disabled).toBe(true);
    expect(radio(el, 'Custom').disabled).toBe(true);
    expect(radio(el, '7 days').getAttribute('aria-checked')).toBe('true');
    expect(api.index).toHaveBeenLastCalledWith('f1', undefined, 'k', { from: dayStart(addDays(localDay(), -6)), to: null });
    root.unmount();
  });
});
