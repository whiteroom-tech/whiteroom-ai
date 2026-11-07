// @vitest-environment happy-dom
// Run page against a mocked engine: the totals fallback on engines before PR
// 298 (looked up once per run state, not on every poll), Export this run across
// pages, and See in timeline for a call on another page.
import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { RunEventsResult } from '@/lib/whiteroom/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

const now = new Date().toISOString();
const api = vi.hoisted(() => ({ events: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({ ...(await orig<typeof import('@/lib/whiteroom/client')>()), getRunEvents: api.events, listRuns: api.list }));
const xlsx = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('@/lib/xlsx', async (orig) => ({ ...(await orig<typeof import('@/lib/xlsx')>()), downloadWorkbook: xlsx.download }));

const { RunDetail } = await import('@/components/runs/RunDetail');
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

describe('run page totals fallback', () => {
  it('fills the summary from the runs list once, and keeps it across polls', async () => {
    // A fresh run object on every load, as a poll returns.
    api.events.mockImplementation(async (): Promise<RunEventsResult> => ({
      fleetId: 'f1', run: { runId: 'a~4', agentId: 'a', shift: 4, startedAt: now, endedAt: now }, events: [], page: 0, pages: 1, total: 0, eventFound: null,
    }));
    api.list.mockResolvedValue({ runs: [{ runId: 'a~4', agentId: 'a', shift: 4, startedAt: now, endedAt: now, lengthSeconds: 24, calls: 6, failedCalls: 0, blockedCalls: 0, spendMicros: 50_000, unpricedAttempts: 0, coverage: { calls: 6, checked: 6 }, wouldActCalls: 6 }], total: 1, cursor: null });
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(RunDetail, { fleetId: 'f1', runId: 'a~4' })); });
    await flush();
    // The list's figure counts every Watch action, so it's worded as acting, not blocking.
    expect(el.querySelector('.wr-run-summary')?.textContent).toContain('6 model calls · $0.05 · 0 failed · 6 would have acted (Watch)');
    // Another load (Events only) brings a new run object: no second lookup.
    const events = [...el.querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Events only') as HTMLElement;
    await act(async () => { events.click(); });
    await flush();
    expect(api.events.mock.calls.length).toBeGreaterThan(1);
    expect(api.list).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    el.remove();
  });

  it('looks the totals up again when the run has grown', async () => {
    api.list.mockClear();
    let ended = now;
    api.events.mockImplementation(async (): Promise<RunEventsResult> => ({
      fleetId: 'f1', run: { runId: 'a~4', agentId: 'a', shift: 4, startedAt: now, endedAt: ended }, events: [], page: 0, pages: 1, total: 0, eventFound: null,
    }));
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(RunDetail, { fleetId: 'f1', runId: 'a~4' })); });
    await flush();
    expect(api.list).toHaveBeenCalledTimes(1);
    ended = new Date(Date.now() + 60_000).toISOString();
    const events = [...el.querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Events only') as HTMLElement;
    await act(async () => { events.click(); });
    await flush();
    expect(api.list).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
    el.remove();
  });
});

describe('run page totals fallback, when the lookup fails', () => {
  it('tries the lookup again a little later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      api.list.mockReset();
      api.events.mockImplementation(async (): Promise<RunEventsResult> => ({
        fleetId: 'f1', run: { runId: 'a~4', agentId: 'a', shift: 4, startedAt: now, endedAt: now }, events: [], page: 0, pages: 1, total: 0, eventFound: null,
      }));
      api.list.mockRejectedValueOnce(new Error('503'));
      api.list.mockResolvedValue({ runs: [{ runId: 'a~4', agentId: 'a', shift: 4, startedAt: now, endedAt: now, lengthSeconds: 24, calls: 6, failedCalls: 0, blockedCalls: 0, spendMicros: 50_000, unpricedAttempts: 0, coverage: { calls: 6, checked: 6 } }], total: 1, cursor: null });
      const el = document.createElement('div');
      document.body.appendChild(el);
      const root = createRoot(el);
      await act(async () => { root.render(h(RunDetail, { fleetId: 'f1', runId: 'a~4' })); });
      await flush();
      expect(api.list).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(30_000); });
      await flush();
      expect(api.list).toHaveBeenCalledTimes(2);
      expect(el.querySelector('.wr-run-summary')?.textContent).toContain('6 model calls');
      await act(async () => root.unmount());
      el.remove();
    } finally { vi.useRealTimers(); }
  });
});

describe('run page when rule actions can’t be read', () => {
  it('says so instead of showing no rule activity', async () => {
    api.events.mockImplementation(async (): Promise<RunEventsResult> => ({
      fleetId: 'f1', run: { runId: 'a~4', agentId: 'a', shift: 4, startedAt: now, endedAt: now, calls: 1, ruleActions: [], ruleActionsUnavailable: true }, events: [], page: 0, pages: 1, total: 0, eventFound: null,
    }));
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(RunDetail, { fleetId: 'f1', runId: 'a~4' })); });
    await flush();
    expect(el.textContent).toContain('Rule activity for this run couldn’t be read just now.');
    await act(async () => root.unmount());
    el.remove();
  });
});

describe('run page exports and links', () => {
  const page = (n: number, x: Partial<RunEventsResult> = {}): RunEventsResult => ({
    fleetId: 'f1',
    run: { runId: 'a~4', agentId: 'a', shift: 4, startedAt: now, endedAt: now, calls: 2, spendMicros: 0, failedCalls: 0, blockedCalls: 0, wouldBlockCalls: 1, models: ['m'],
      ruleActions: [{ at: now, ruleId: 'r', ruleType: 'model_allowlist', response: 'block', mode: 'watch', occurrences: 1, eventIds: ['call:2'] }] },
    events: [{ id: `call:${n + 1}`, kind: 'call', at: now, type: 'complete', model: 'm' }], page: n, pages: 2, total: 2, eventFound: null, ...x,
  });

  it('exports every page of the run and says so', async () => {
    api.events.mockImplementation(async (_f: string, _r: string, q: { cursor?: string | null }) => page(Number(q.cursor ?? 0)));
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(RunDetail, { fleetId: 'f1', runId: 'a~4' })); });
    await flush();
    await act(async () => { ([...el.querySelectorAll('button')].find((b) => b.textContent === 'Export this run') as HTMLElement).click(); });
    await flush();
    expect(xlsx.download).toHaveBeenCalledTimes(1);
    expect(xlsx.download.mock.calls[0][1]).toBe('whiteroom-run-a-4.xlsx');
    expect(el.textContent).toContain('Downloaded run 4.');
    await act(async () => root.unmount());
    el.remove();
  });

  it('says so, in the toast and the file name, when a run is too long for one export', async () => {
    xlsx.download.mockClear();
    api.events.mockImplementation(async (_f: string, _r: string, q: { cursor?: string | null }) => page(Number(q.cursor ?? 0), { pages: 150 }));
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(RunDetail, { fleetId: 'f1', runId: 'a~4' })); });
    await flush();
    await act(async () => { ([...el.querySelectorAll('button')].find((b) => b.textContent === 'Export this run') as HTMLElement).click(); });
    await act(async () => { for (let i = 0; i < 400; i++) await Promise.resolve(); });
    expect(xlsx.download.mock.calls[0][1]).toBe('whiteroom-run-a-4-first-100.xlsx');
    expect(el.textContent).toContain('Downloaded the first 100 calls and events of run 4');
    await act(async () => root.unmount());
    el.remove();
  });

  it('says when See in timeline can’t find the call', async () => {
    api.events.mockImplementation(async (_f: string, _r: string, q: { cursor?: string | null; eventId?: string | null }) => (q.eventId ? page(0, { eventFound: false }) : page(Number(q.cursor ?? 0))));
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(RunDetail, { fleetId: 'f1', runId: 'a~4' })); });
    await flush();
    await act(async () => { ([...el.querySelectorAll('button')].find((b) => b.textContent === 'See in timeline') as HTMLElement).click(); });
    await flush();
    expect(el.textContent).toContain('Couldn’t find that call in this run.');
    await act(async () => root.unmount());
    el.remove();
  });

  it('drops a jump whose page fails to load, and says so', async () => {
    api.events.mockImplementation(async (_f: string, _r: string, q: { cursor?: string | null; eventId?: string | null }) => {
      if (q.eventId) throw new Error('503');
      return page(Number(q.cursor ?? 0));
    });
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(RunDetail, { fleetId: 'f1', runId: 'a~4' })); });
    await flush();
    await act(async () => { ([...el.querySelectorAll('button')].find((b) => b.textContent === 'See in timeline') as HTMLElement).click(); });
    await flush();
    expect(el.textContent).toContain('Couldn’t open that call. Try again.');
    // The next load is an ordinary one, not the dropped jump.
    const calls = api.events.mock.calls.length;
    await act(async () => { ([...el.querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Events only') as HTMLElement).click(); });
    await flush();
    expect(api.events.mock.calls.slice(calls).every((c) => !c[2].eventId)).toBe(true);
    await act(async () => root.unmount());
    el.remove();
  });

  it('opens the page holding a call on another page, from See in timeline', async () => {
    api.events.mockImplementation(async (_f: string, _r: string, q: { cursor?: string | null; eventId?: string | null }) => (q.eventId === 'call:2' ? page(1, { eventFound: true }) : page(Number(q.cursor ?? 0))));
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(RunDetail, { fleetId: 'f1', runId: 'a~4' })); });
    await flush();
    expect(el.querySelector('#run-event-call\\:2')).toBeNull();
    await act(async () => { ([...el.querySelectorAll('button')].find((b) => b.textContent === 'See in timeline') as HTMLElement).click(); });
    await flush();
    expect(api.events).toHaveBeenCalledWith('f1', 'a~4', expect.objectContaining({ eventId: 'call:2' }), undefined);
    expect(el.querySelector('#run-event-call\\:2')?.classList.contains('is-highlighted')).toBe(true);
    // A later page's first call names its model: the call before it isn't on screen.
    expect(el.querySelector('#run-event-call\\:2 .wr-timeline__text')?.textContent).toBe('Model call · m');
    await act(async () => root.unmount());
    el.remove();
  });
});
