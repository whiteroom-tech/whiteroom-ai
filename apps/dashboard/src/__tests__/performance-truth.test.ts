// @vitest-environment happy-dom
// Performance says what it shows (bug-fix spec PR C): figures are matched to
// the window they were read for (its days and zone), "Live" refreshes and
// "Retrying" retries, and a rejected session goes to session recovery.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const nav = vi.hoisted(() => ({ params: new URLSearchParams(), router: { replace: vi.fn(), push: vi.fn() } }));
const api = vi.hoisted(() => ({ index: vi.fn(), hourly: vi.fn(), audit: vi.fn(), evidence: vi.fn(), reset: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav.router, useSearchParams: () => nav.params, usePathname: () => '/performance' }));
vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => ({ status: 'authenticated', fleetId: 'test-fleet', authKey: undefined, resetSession: api.reset }) }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  performanceIndex: api.index, performanceFleetHourly: api.hourly, auditSummary: api.audit, performanceEvidence: api.evidence,
  performanceCostForecast: async () => ({}), governanceList: async () => ({ rules: [] }),
}));
vi.mock('@/app/(citadel)/performance/_components/IndexView', () => ({
  IndexView: ({ data, rangeLabel, onSelectEvidence }: { data: { summary: { totalCalls: number } }; rangeLabel: string; onSelectEvidence: (id: string, agent: string) => void }) =>
    h('div', null,
      h('div', { 'data-testid': 'shown' }, `${rangeLabel}: ${data.summary.totalCalls} calls`),
      h('button', { onClick: () => onSelectEvidence('f1', 'agent-a') }, 'evidence')),
}));
vi.mock('@/app/(citadel)/performance/_components/AgentEvidence', () => ({ EvidenceView: () => h('div', null, 'EVIDENCE') }));
const { PerformancePage } = await import('@/app/(citadel)/performance/_components/PerformancePage');
const { WhiteRoomApiError } = await import('@/lib/whiteroom/client');
const { clearSnapshots } = await import('@/lib/performance-snapshot');
const { setViewerZone } = await import('@/lib/zone-time');

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
async function mount() {
  el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
  await act(async () => { root.render(h(PerformancePage)); }); await flush();
}
const shown = () => el.querySelector('[data-testid="shown"]')?.textContent ?? null;
const dimmed = () => (el.querySelector('.wr-page-body') as HTMLElement | null)?.style.opacity === '0.55';
const radio = (label: string) => [...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === label)!;
const advance = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); await flush(); };
const held = () => { let release!: (v: unknown) => void; let fail!: (e: unknown) => void; const p = new Promise((res, rej) => { release = res; fail = rej; }); return { p, release, fail }; };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-11-03T15:00:00Z'));
  setViewerZone('UTC', { quiet: true });
  clearSnapshots(); nav.params = new URLSearchParams(); vi.clearAllMocks();
  api.index.mockReset().mockResolvedValue({ summary: { totalCalls: 700 } });
  api.hourly.mockReset().mockResolvedValue({ hourly: [] });
  api.audit.mockReset().mockResolvedValue(null);
});
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; vi.useRealTimers(); setViewerZone(null, { quiet: true }); });

// --- 03: figures are shown only as the window they were read for ---

it('an uncached range that fails never shows the old figures under its label', async () => {
  await mount();
  expect(shown()).toBe('last 7 days: 700 calls');
  const today = held();
  api.index.mockReset().mockRejectedValue(new Error('offline')); // the retries fail too
  api.index.mockReturnValueOnce(today.p);
  await act(async () => radio('Today').click()); await flush();
  // While Today loads, the dimmed 7-day figures keep their own dates.
  expect(dimmed()).toBe(true);
  expect(shown()).toMatch(/^Oct 28 – Nov 3: 700 calls$/);
  await act(async () => today.fail(new Error('offline'))); await flush();
  expect(shown()).toBeNull();
  expect(el.textContent).toContain('Couldn’t load performance data.');
});

it('a cached range shows its own snapshot, labelled as itself', async () => {
  api.index.mockResolvedValueOnce({ summary: { totalCalls: 700 } }).mockResolvedValueOnce({ summary: { totalCalls: 40 } });
  await mount();
  await act(async () => radio('Today').click()); await flush();
  expect(shown()).toBe('today: 40 calls');
  await act(async () => radio('7 days').click()); await flush();
  expect(shown()).toBe('last 7 days: 700 calls');
  expect(api.index).toHaveBeenCalledTimes(3);
});

it('after midnight, yesterday\'s "today" is not shown as today when the midnight read fails', async () => {
  nav.params = new URLSearchParams('range=today');
  api.index.mockResolvedValueOnce({ summary: { totalCalls: 40 } });
  await mount();
  expect(shown()).toBe('today: 40 calls');
  api.index.mockRejectedValue(new Error('offline'));
  // To just after local midnight: the polls fail ("Retrying", still Nov 3's
  // figures, rightly), then the midnight read fails too.
  await advance(9 * 3600_000 + 10_000);
  expect(shown()).toBeNull();
  expect(el.textContent).toContain('Couldn’t load performance data.');
});

it('a zone change with the same date strings reads again at once, and the old zone\'s figures don\'t pass as the new one\'s', async () => {
  await mount();
  const nyRead = held();
  api.index.mockReset().mockRejectedValue(new Error('offline'));
  api.index.mockReturnValueOnce(nyRead.p);
  const before = api.index.mock.calls.length; // after the reset, which clears the call log
  await act(async () => { setViewerZone('America/New_York'); }); await flush();
  expect(api.index.mock.calls.length).toBe(before + 1);
  expect(shown()).toMatch(/^Oct 28 – Nov 3: 700 calls$/); // dimmed, its own dates
  await act(async () => nyRead.fail(new Error('offline'))); await flush();
  expect(shown()).toBeNull();
});

// --- 04: "Live" refreshes; "Retrying" retries ---

it('Live: a background read every 5 minutes, without dimming the page', async () => {
  await mount();
  const n = api.index.mock.calls.length;
  const bg = held();
  api.index.mockReturnValueOnce(bg.p);
  await advance(5 * 60_000);
  expect(api.index.mock.calls.length).toBe(n + 1);
  expect(dimmed()).toBe(false);
  await act(async () => bg.release({ summary: { totalCalls: 710 } })); await flush();
  expect(shown()).toBe('last 7 days: 710 calls');
});

it('the minute tick reads only when due: no extra reads around a failure', async () => {
  await mount();
  const n = api.index.mock.calls.length;
  await advance(4 * 60_000); // four ticks, none due
  expect(api.index.mock.calls.length).toBe(n);
  api.index.mockRejectedValueOnce(new Error('offline'));
  await advance(60_000); // due at 5 min: fails
  expect(api.index.mock.calls.length).toBe(n + 1);
  await advance(30_000); // no immediate re-read on the failure
  expect(api.index.mock.calls.length).toBe(n + 1);
  await advance(30_000); // the next minute: retried, and succeeds
  expect(api.index.mock.calls.length).toBe(n + 2);
  await advance(60_000); // recovered: back to every 5 minutes, no extra read
  expect(api.index.mock.calls.length).toBe(n + 2);
});

it('Retrying: a failing read is retried every minute, and success clears it', async () => {
  await mount();
  api.index.mockRejectedValue(new Error('offline'));
  await advance(5 * 60_000);
  expect(el.textContent).toContain('Retrying');
  const n = api.index.mock.calls.length;
  await advance(60_000);
  expect(api.index.mock.calls.length).toBeGreaterThan(n);
  api.index.mockResolvedValue({ summary: { totalCalls: 720 } });
  await advance(60_000);
  expect(el.textContent).not.toContain('Retrying');
  expect(shown()).toBe('last 7 days: 720 calls');
});

it('a range change during a background read un-dims when the newest read lands', async () => {
  await mount();
  const bg = held();
  api.index.mockReturnValueOnce(bg.p);
  await advance(5 * 60_000); // background read in flight
  api.index.mockResolvedValueOnce({ summary: { totalCalls: 40 } });
  await act(async () => radio('Today').click()); await flush();
  expect(shown()).toBe('today: 40 calls');
  expect(dimmed()).toBe(false);
  await act(async () => bg.release({ summary: { totalCalls: 999 } })); await flush();
  expect(shown()).toBe('today: 40 calls'); // the superseded read is dropped
  expect(dimmed()).toBe(false);
});

it('a poll tick during a foreground read is skipped', async () => {
  await mount();
  const fg = held();
  api.index.mockReturnValueOnce(fg.p);
  await act(async () => radio('Today').click()); await flush();
  const n = api.index.mock.calls.length;
  await advance(5 * 60_000);
  expect(api.index.mock.calls.length).toBe(n);
  await act(async () => fg.release({ summary: { totalCalls: 40 } })); await flush();
  expect(dimmed()).toBe(false);
});

it('mount with no snapshot: the first read runs and the loading line clears', async () => {
  const first = held();
  api.index.mockReturnValueOnce(first.p);
  await mount();
  expect(el.textContent).toContain('Loading performance');
  await act(async () => first.release({ summary: { totalCalls: 700 } })); await flush();
  expect(el.textContent).not.toContain('Loading performance');
  expect(shown()).toBe('last 7 days: 700 calls');
});

it('a hidden tab does not poll; it reads once on return', async () => {
  await mount();
  const n = api.index.mock.calls.length;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  await advance(10 * 60_000);
  expect(api.index.mock.calls.length).toBe(n);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); }); await flush();
  expect(api.index.mock.calls.length).toBe(n + 1);
});

it('Try again on a failed first load reads again', async () => {
  api.index.mockRejectedValue(new Error('offline'));
  await mount();
  api.index.mockResolvedValue({ summary: { totalCalls: 700 } });
  const tryAgain = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Try again')!;
  await act(async () => tryAgain.click()); await flush();
  expect(shown()).toBe('last 7 days: 700 calls');
});

// --- 06: a rejected session goes to session recovery ---

it.each([401, 403])('a %i on the overview calls resetSession', async (status) => {
  api.index.mockRejectedValue(new WhiteRoomApiError('Unauthorized', status));
  await mount();
  expect(api.reset).toHaveBeenCalledWith('Your session expired. Please sign in again.');
});

it('a 503 does not sign out; it shows the error and retries', async () => {
  api.index.mockRejectedValue(new WhiteRoomApiError('Unavailable', 503));
  await mount();
  expect(api.reset).not.toHaveBeenCalled();
  expect(el.textContent).toContain('Couldn’t load performance data.');
});

it('a 401 while loading evidence calls resetSession', async () => {
  await mount();
  api.evidence.mockRejectedValue(new WhiteRoomApiError('Unauthorized', 401));
  await act(async () => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'evidence')!.click()); await flush();
  expect(api.reset).toHaveBeenCalled();
});
