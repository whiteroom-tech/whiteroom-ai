// @vitest-environment happy-dom
// The Estimate button in a real React tree under StrictMode, which mounts,
// cleans up and mounts again: the result must still show.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReplayEstimate } from '@/app/(citadel)/controls/_components/ReplayEstimate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const props = (params: unknown, appliesTo: unknown = 'all') => ({ fleetId: 'f1', authKey: 'k', ruleType: 'model_allowlist', params, appliesTo, disabledReason: null });
async function mount(p: ReturnType<typeof props>) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(ReplayEstimate, p)); });
  return { el, root, render: (q: ReturnType<typeof props>) => act(async () => { root.render(h(ReplayEstimate, q)); }) };
}
const done = { replay: { id: 'rp_1', status: 'done', from: 'a', to: 'b', result: { supported: true, records: 9, evaluated: 9, matched: 3, partial: [{ kind: 'dropped', calls: 2 }] } } };

describe('ReplayEstimate under StrictMode', () => {
  it('shows the estimate once it is done', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ success: true, supported: true, replay_id: 'rp_1' }))
      .mockResolvedValue(reply({ replay: { id: 'rp_1', status: 'done', from: 'a', to: 'b', result: { supported: true, records: 9, evaluated: 9, matched: 3, partial: null } } }));
    vi.stubGlobal('fetch', fetchMock);
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(h(StrictMode, null, h(ReplayEstimate, { fleetId: 'f1', authKey: 'k', ruleType: 'model_allowlist', params: { allowedModels: ['m'] }, appliesTo: 'all', disabledReason: null })));
    });
    await act(async () => { el.querySelector('button')!.click(); });
    expect(el.textContent).toContain('Estimating…');
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(el.textContent).toContain('In the last 7 days, 3 of 9 calls used a model not on this list.');
    await act(async () => { root.unmount(); });
  });

  it('shows why an estimate failed, and the button works again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ error: 'Replay isn’t on for this fleet yet.' }, 404)));
    const m = await mount(props({ allowedModels: ['m'] }));
    await act(async () => { m.el.querySelector('button')!.click(); });
    expect(m.el.querySelector('.wr-replay__line--err')?.textContent).toBe('Estimates aren’t on for this fleet yet.');
    expect(m.el.querySelector('button')!.disabled).toBe(false);
    await act(async () => { m.root.unmount(); });
  });

  it('hides a result once the models or the agents change, and shows it again if they change back', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply({ success: true, supported: true, replay_id: 'rp_1' }))
      .mockImplementation(async () => reply(done)));
    const m = await mount(props({ allowedModels: ['m'] }));
    await act(async () => { m.el.querySelector('button')!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(m.el.textContent).toContain('3 of 9 calls');
    expect(m.el.textContent).toContain('Partial: 2 calls weren’t stored.');
    await m.render(props({ allowedModels: ['m', 'n'] }));
    expect(m.el.textContent).not.toContain('3 of 9 calls');
    await m.render(props({ allowedModels: ['m'] }, ['a1']));
    expect(m.el.textContent).not.toContain('3 of 9 calls');
    await m.render(props({ allowedModels: ['m'] }));
    expect(m.el.textContent).toContain('3 of 9 calls');
    await act(async () => { m.root.unmount(); });
  });
});
