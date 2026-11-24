// @vitest-environment happy-dom
// The Estimate button in a real React tree under StrictMode, which mounts,
// cleans up and mounts again: the result must still show.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReplayEstimate } from '@/app/(citadel)/controls/_components/ReplayEstimate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

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
});
