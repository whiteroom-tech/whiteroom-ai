// @vitest-environment happy-dom
// Job outcomes (Agent Health item 3): Agent detail's Jobs line and the run
// summary's outcome, both said as the customer's system's word.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ outcomes: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({ ...(await orig<typeof import('@/lib/whiteroom/client')>()), jobOutcomes: api.outcomes }));
const { JobOutcomes, jobsLine } = await import('@/components/agent/JobOutcomes');
const { runSummary } = await import('@/lib/runs');

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(JobOutcomes, { fleetId: 'f', agentId: 'a' })); });
  await flush();
  return { el, root, text: () => el.textContent ?? '' };
}
beforeEach(() => { api.outcomes.mockReset(); document.body.innerHTML = ''; });

describe('Jobs line', () => {
  it('says how many succeeded, over what, and whose word it is', () => {
    expect(jobsLine({ success: 42, failure: 8 })).toEqual({ text: '42 of 50 succeeded (84%) · last 7 days · reported by your system', tone: 'ok' });
    expect(jobsLine({ success: 8, failure: 2 })?.tone).toBe('warn');
    expect(jobsLine({ success: 0, failure: 0 })).toBeNull();
    expect(jobsLine(null)).toBeNull();
  });

  it('shows this agent’s outcomes, and nothing when none were reported or the engine has none', async () => {
    api.outcomes.mockResolvedValue({ a: { success: 3, failure: 1 } });
    let m = await mount();
    expect(api.outcomes).toHaveBeenCalledWith('f', 'a', undefined);
    expect(m.text()).toBe('Jobs3 of 4 succeeded (75%) · last 7 days · reported by your system');
    m.root.unmount();
    for (const got of [() => Promise.resolve({}), () => Promise.resolve(null), () => Promise.reject(new Error('down'))]) {
      api.outcomes.mockImplementationOnce(got);
      m = await mount();
      expect(m.text()).toBe('');
      m.root.unmount();
    }
  });
});

describe('run summary', () => {
  const run = { runId: 'a~1', agentId: 'a', shift: 1, startedAt: '2026-11-10T10:00:00Z', endedAt: '2026-11-10T10:05:00Z' };
  it('names the reported outcome, and nothing when none was reported', () => {
    expect(runSummary({ ...run, outcome: 'failure' }).outcome).toBe('Failed');
    expect(runSummary({ ...run, outcome: 'success' }).outcome).toBe('Succeeded');
    expect(runSummary(run).outcome).toBeUndefined();
  });
});
