// @vitest-environment happy-dom
// The Runs table's Show filter in a DOM, with the engine mocked: Rule activity
// asks the engine for runs with rule activity, keeps it in the URL, hides day
// totals, and falls back to All on an engine that doesn't count rule actions.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, type FC } from 'react';
import { createRoot } from 'react-dom/client';
import type { RunSummary } from '@/lib/whiteroom/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: nav.replace, push: nav.push }), useSearchParams: () => nav.params }));
vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => ({ status: 'authenticated', fleetId: 'f1', authKey: 'k', resetSession: vi.fn() }) }));

const api = vi.hoisted(() => ({ list: vi.fn(), counted: true, hours: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  listRuns: api.list,
  runDays: async () => ({ days: [] }),
  runHours: api.hours,
  fleetReport: async () => ({ error: 'no' }),
}));

const run = (shift: number, x: Partial<RunSummary> = {}): RunSummary => ({
  runId: `lead-agent~${shift}`, agentId: 'lead-agent', shift, startedAt: new Date(Date.now() - shift * 60_000).toISOString(), endedAt: new Date().toISOString(),
  lengthSeconds: 60, calls: 3, failedCalls: 0, blockedCalls: 0, spendMicros: 0, unpricedAttempts: 0, coverage: { calls: 3, checked: 3 }, flags: [], ...x,
});

vi.mock('@/lib/xlsx', async (orig) => ({ ...(await orig<typeof import('@/lib/xlsx')>()), downloadWorkbook: vi.fn() }));

const { RunsTable } = await import('@/components/runs/RunsTable');
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

async function mount(preview?: RunSummary[], retentionDays?: number) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  // RunsTable's props default to {}, which createElement's overloads can't infer.
  const Table = RunsTable as FC<{ preview?: RunSummary[]; retentionDays?: number }>;
  await act(async () => { root.render(h(Table, { preview, retentionDays })); });
  await flush();
  const radio = (label: string) => [...el.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
  const click = async (b: Element | undefined) => { await act(async () => { (b as HTMLElement).click(); }); await flush(); };
  return { el, root, radio, click, text: () => el.textContent ?? '' };
}

beforeEach(() => {
  api.hours.mockReset();
  api.hours.mockResolvedValue({ hours: [{ hour: 9, runs: 2 }, { hour: 14, runs: 1 }] });
  nav.params = new URLSearchParams();
  nav.replace.mockClear();
  api.list.mockReset();
  api.list.mockImplementation(async (_f: string, opts: { ruleActivity?: boolean }) => {
    const runs = [run(1, { wouldActCalls: 2 }), run(2, { wouldActCalls: 0 })];
    if (!api.counted) return { runs: runs.map(({ wouldActCalls: _, ...r }) => r), total: 2, cursor: null };
    return opts.ruleActivity ? { runs: [runs[0]], total: 1, cursor: null } : { runs, total: 2, cursor: null };
  });
  api.counted = true;
});

describe('Runs › Show › Rule activity', () => {
  it('asks the engine for runs with rule activity and keeps the choice in the URL', async () => {
    const m = await mount();
    expect(m.text()).toContain('A Record only rule would have acted 2 times');
    await m.click(m.radio('Rule activity'));
    expect(api.list).toHaveBeenLastCalledWith('f1', expect.objectContaining({ ruleActivity: true, flagged: false }), 'k');
    expect(nav.replace).toHaveBeenLastCalledWith(expect.stringContaining('show=rules'), { scroll: false });
    m.root.unmount();
  });

  it('opens on a shared ?show=rules link', async () => {
    nav.params = new URLSearchParams('show=rules');
    const m = await mount();
    expect(api.list).toHaveBeenCalledWith('f1', expect.objectContaining({ ruleActivity: true }), 'k');
    expect(m.radio('Rule activity')?.getAttribute('aria-checked')).toBe('true');
    m.root.unmount();
  });

  it('falls back to All, and offers no Rule activity, on an engine that doesn’t count rule actions', async () => {
    api.counted = false;
    nav.params = new URLSearchParams('show=rules');
    const m = await mount();
    expect(m.radio('Rule activity')).toBeUndefined();
    expect(api.list).toHaveBeenLastCalledWith('f1', expect.objectContaining({ ruleActivity: false }), 'k');
    m.root.unmount();
  });
});

describe('Runs › Show › Rule activity, in the preview (no engine)', () => {
  it('keeps runs where a rule blocked or would have acted, and hides the day totals', async () => {
    const m = await mount([run(1, { wouldActCalls: 2 }), run(2, { blockedCalls: 1, wouldActCalls: 0 }), run(3, { wouldActCalls: 0 })]);
    expect(m.text()).toMatch(/3 runs/);
    await m.click(m.radio('Rule activity'));
    const rows = [...m.el.querySelectorAll('[role="row"]')].filter((r) => /#\d/.test(r.textContent ?? ''));
    expect(rows.map((r) => r.textContent?.match(/#(\d+)/)?.[1])).toEqual(['1', '2']);
    // Day totals count every run, so they're left out under a filter.
    expect(m.text()).not.toMatch(/·\s*3 runs/);
    expect(api.list).not.toHaveBeenCalled();
    m.root.unmount();
  });
});

describe('Runs › a day by hour', () => {
  const day = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA');
  const at = (h: number) => { const d = new Date(`${day}T00:00:00`); d.setHours(h, 15); return d.toISOString(); };

  it('shows the picked day by hour, and an hour lists only that hour’s runs', async () => {
    nav.params = new URLSearchParams(`day=${day}`);
    api.list.mockImplementation(async (_f: string, o: { hour?: number | null }) => ({ runs: o.hour === 9 ? [run(1, { startedAt: at(9) })] : [run(1, { startedAt: at(9) }), run(2, { startedAt: at(14) })], total: 2, cursor: null }));
    const m = await mount();
    expect(api.hours).toHaveBeenCalledWith('f1', { day, agentId: undefined }, 'k');
    expect(m.text()).toContain('by hour');
    const nine = m.el.querySelector('button[aria-label="9 am: 2 runs"]') as HTMLButtonElement;
    expect(m.el.querySelector('button[aria-label="3 am: 0 runs"]')!.hasAttribute('disabled')).toBe(true);
    await m.click(nine);
    expect(api.list).toHaveBeenLastCalledWith('f1', expect.objectContaining({ hour: 9 }), 'k');
    expect(nav.replace).toHaveBeenLastCalledWith(expect.stringContaining('hour=9'), { scroll: false });
    await m.click([...m.el.querySelectorAll('button')].find((b) => b.textContent === 'All hours'));
    expect(api.list).toHaveBeenLastCalledWith('f1', expect.objectContaining({ hour: null }), 'k');
    m.root.unmount();
  });

  it('exports just the picked hour, as the table shows', async () => {
    nav.params = new URLSearchParams(`day=${day}&hour=9`);
    api.list.mockImplementation(async () => ({ runs: [run(1, { startedAt: at(9) })], total: 1, cursor: null }));
    const m = await mount();
    await m.click([...m.el.querySelectorAll('button')].find((b) => b.textContent === 'Export .xlsx'));
    expect(api.list).toHaveBeenLastCalledWith('f1', expect.objectContaining({ pageSize: 50, hour: 9, fromDay: day, toDay: day }), 'k');
    m.root.unmount();
  });

  it('drops the hourly view on an engine without the hour filter, rather than mislabel the whole day', async () => {
    nav.params = new URLSearchParams(`day=${day}&hour=9`);
    api.list.mockImplementation(async () => ({ runs: [run(1, { startedAt: at(9) }), run(2, { startedAt: at(14) })], total: 2, cursor: null }));
    const m = await mount();
    expect(m.text()).not.toContain('by hour');
    expect(api.list).toHaveBeenLastCalledWith('f1', expect.objectContaining({ hour: null }), 'k');
    m.root.unmount();
  });

  it('asks again on another day after an ignored hour, and refreshes the hours with the list', async () => {
    nav.params = new URLSearchParams(`day=${day}&hour=9`);
    let honour = false;
    api.list.mockImplementation(async (_f: string, o: { hour?: number | null }) => ({ runs: honour && o.hour === 9 ? [run(1, { startedAt: at(9) })] : [run(1, { startedAt: at(9) }), run(2, { startedAt: at(14) })], total: 2, cursor: null }));
    const m = await mount();
    expect(m.text()).not.toContain('by hour');
    honour = true;
    const calls = api.hours.mock.calls.length;
    await m.click(m.el.querySelector('button[aria-label="Previous day"]') ?? undefined);
    expect(m.text()).toContain('by hour');
    // The hours load again for the new day (they have their own poll, keyed on day and agent).
    expect(api.hours.mock.calls.length).toBeGreaterThan(calls);
    m.root.unmount();
  });

  it('applies a link’s hour only to the day it named', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toLocaleDateString('en-CA');
    nav.params = new URLSearchParams(`day=${old}&hour=9`);
    const m = await mount(undefined, 30);
    expect(api.list).toHaveBeenCalledWith('f1', expect.objectContaining({ hour: null }), 'k');
    expect(api.list).not.toHaveBeenCalledWith('f1', expect.objectContaining({ hour: 9 }), 'k');
    m.root.unmount();
  });

  it('shows no hourly view on an engine without run_hours', async () => {
    api.hours.mockResolvedValue({ unsupported: true });
    nav.params = new URLSearchParams(`day=${day}`);
    const m = await mount();
    expect(m.text()).not.toContain('by hour');
    m.root.unmount();
  });
});
