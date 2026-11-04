// @vitest-environment happy-dom
// Performance: the hourly read is extra. Its failure leaves the chart out, not
// the overview; a rejected session on it still fails the read.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const nav = vi.hoisted(() => ({ params: new URLSearchParams(), router: { replace: vi.fn(), push: vi.fn() } }));
const api = vi.hoisted(() => ({ index: vi.fn(), hourly: vi.fn(), audit: vi.fn(), reset: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav.router, useSearchParams: () => nav.params, usePathname: () => '/performance' }));
vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => ({ status: 'authenticated', fleetId: 'test-fleet', authKey: undefined, resetSession: api.reset }) }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  performanceIndex: api.index, performanceFleetHourly: api.hourly, auditSummary: api.audit,
  performanceCostForecast: async () => ({}), governanceList: async () => ({ rules: [] }),
}));
vi.mock('@/app/(citadel)/performance/_components/IndexView', () => ({
  IndexView: ({ data, hourlyData }: { data: { summary: { totalCalls: number } }; hourlyData: unknown }) =>
    h('div', { 'data-testid': 'shown' }, `${data.summary.totalCalls} calls; chart ${hourlyData ? 'on' : 'off'}`),
}));
const { PerformancePage } = await import('@/app/(citadel)/performance/_components/PerformancePage');
const { WhiteRoomApiError } = await import('@/lib/whiteroom/client');
const { clearSnapshots } = await import('@/lib/performance-snapshot');

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); });
async function mount() {
  el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
  await act(async () => { root.render(h(PerformancePage)); }); await flush();
}
const shown = () => el.querySelector('[data-testid="shown"]')?.textContent ?? null;

beforeEach(() => {
  clearSnapshots(); nav.params = new URLSearchParams(); vi.clearAllMocks();
  api.index.mockReset().mockResolvedValue({ summary: { totalCalls: 700 } });
  api.hourly.mockReset().mockResolvedValue({ hourly: [] });
  api.audit.mockReset().mockResolvedValue(null);
});
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; });

it('an hourly network failure leaves the overview up, without the chart and without an error', async () => {
  api.hourly.mockRejectedValue(new Error('hourly unavailable'));
  await mount();
  expect(shown()).toBe('700 calls; chart off');
  expect(el.textContent).not.toContain('Failed to load performance data.');
});

it('an hourly error payload still leaves the overview up (unchanged)', async () => {
  api.hourly.mockResolvedValue({ error: 'hourly broke' });
  await mount();
  expect(shown()).toBe('700 calls; chart off');
});

it('a rejected session on the hourly read goes to session recovery, even though the index answered', async () => {
  api.hourly.mockRejectedValue(new WhiteRoomApiError('Unauthorized', 401));
  await mount();
  expect(shown()).toBeNull();
  expect(api.reset).toHaveBeenCalledWith('Your session expired. Please sign in again.');
});
