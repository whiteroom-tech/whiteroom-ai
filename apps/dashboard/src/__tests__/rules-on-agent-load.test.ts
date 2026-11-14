// @vitest-environment happy-dom
// Agent page › Rules on this agent, read from the engine: a failed or
// malformed read says it's retrying, and a later failed read keeps the rules.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }), useSearchParams: () => new URLSearchParams() }));
const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({ ...(await orig<typeof import('@/lib/whiteroom/client')>()), governanceList: api.list }));
const { RulesOnAgent } = await import('@/components/agent/RulesOnAgent');
const { knownRulesOnly } = await import('@/lib/governance');

const RULE = { id: 'r1', fleetId: 'f', changedBy: 'x', changedAt: '2026-10-01T00:00:00Z', version: 1, response: 'block', ruleType: 'call_rate', mode: 'watch', appliesTo: ['a'], params: { maxCalls: 60 } };
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(RulesOnAgent, { fleetId: 'f', authKey: 'k', agentId: 'a' })); });
  await flush();
  return { el, root };
}

afterEach(() => { api.list.mockReset(); vi.useRealTimers(); });

describe('Rules on this agent, loading', () => {
  it('says it is retrying when the read fails or comes back without rules', async () => {
    for (const reply of [Promise.reject(new Error('down')), Promise.resolve({ error: 'nope' })]) {
      api.list.mockReturnValueOnce(reply);
      const m = await mount();
      expect(api.list).toHaveBeenLastCalledWith('f', 'k');
      expect(m.el.textContent).toContain('Couldn’t load the rules. Retrying…');
      m.root.unmount();
    }
  });

  it('keeps the rules it has when a later read fails', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    api.list.mockResolvedValueOnce({ fleetId: 'f', rules: [RULE], history: [], agents: ['a'] });
    const m = await mount();
    expect(m.el.textContent).toContain('Over 60 calls a minute');
    api.list.mockRejectedValueOnce(new Error('down'));
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await flush();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(m.el.textContent).toContain('Over 60 calls a minute');
    expect(m.el.textContent).not.toContain('Retrying');
    m.root.unmount();
  });

  it('lists a rule of a type it doesn’t know as a plain row, without a link or a count of another type', async () => {
    const future = { ...RULE, id: 'rx', ruleType: 'made_up_type', mode: 'enforce', appliesTo: 'all', params: { somethingNew: ['x'] } };
    // As the real governanceList reads the engine's reply.
    api.list.mockResolvedValueOnce(knownRulesOnly({ fleetId: 'f', rules: [RULE, future] as never, history: [], agents: ['a'] }));
    const m = await mount();
    const items = [...m.el.querySelectorAll('li')];
    expect(items.map((li) => li.textContent)).toEqual(['Call rateWatchOver 60 calls a minute', 'A rule this version can’t showEnforce']);
    expect(items[1].querySelector('a')).toBeNull();
    expect(m.el.querySelector('.wr-panel__count')?.textContent).toBe('2');
    m.root.unmount();
  });
});
