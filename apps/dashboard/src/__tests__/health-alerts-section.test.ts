// @vitest-environment happy-dom
// Settings › Alerts › Health check alerts (Agent Health item 1): how often
// new health check problems are sent, saved with the browser's time zone.
// Shown only on engines that report the setting.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Status = { slack: { ending: string } | null; teams?: null; health?: { frequency: string; tz: string } };
const api = vi.hoisted(() => ({
  status: { slack: null } as Status,
  setHealth: vi.fn(),
}));
vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => ({ status: 'authenticated', fleetId: 'f1' }) }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  alertsGet: async () => api.status,
  alertsSetHealth: api.setHealth,
}));
const { AlertsSection } = await import('@/components/settings/AlertsSection');

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(AlertsSection)); });
  await flush();
  return { el, root, select: () => el.querySelector('select#health-alerts-f1') as HTMLSelectElement | null, text: () => el.textContent ?? '' };
}
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
};
beforeEach(() => { api.status = { slack: null }; api.setHealth.mockReset(); document.body.innerHTML = ''; });

describe('Settings › Alerts › Health check alerts', () => {
  it('is hidden on an engine without health check alerts', async () => {
    const m = await mount();
    expect(m.select()).toBeNull();
    m.root.unmount();
  });

  it('shows the fleet’s choice, labelled, with every option', async () => {
    api.status = { slack: null, health: { frequency: 'daily', tz: 'UTC' } };
    const m = await mount();
    const s = m.select()!;
    expect(s.value).toBe('daily');
    expect(m.el.querySelector('label[for="health-alerts-f1"]')?.textContent).toBe('Health check alerts');
    expect([...s.options].map((o) => o.value)).toEqual(['daily', 'weekly', 'live', 'off']);
    m.root.unmount();
  });

  it('saves a change at once, with the browser’s time zone', async () => {
    api.status = { slack: null, health: { frequency: 'daily', tz: 'UTC' } };
    api.setHealth.mockImplementation(async (_f: string, frequency: string, tz: string) => ({ slack: null, health: { frequency, tz } }));
    const m = await mount();
    await choose(m.select()!, 'weekly');
    expect(api.setHealth).toHaveBeenCalledWith('f1', 'weekly', Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(m.select()!.value).toBe('weekly');
    expect(m.text()).toContain('Saved.');
    m.root.unmount();
  });

  it('an engine that doesn’t take the setting doesn’t claim it saved', async () => {
    api.status = { slack: null, health: { frequency: 'daily', tz: 'UTC' } };
    api.setHealth.mockResolvedValue(null);
    const m = await mount();
    await choose(m.select()!, 'live');
    expect(m.select()!.value).toBe('daily');
    expect(m.text()).not.toContain('Saved.');
    expect(m.text()).toContain('doesn’t support health check alerts');
    m.root.unmount();
  });

  it('a refused change goes back to what was saved and says why', async () => {
    api.status = { slack: null, health: { frequency: 'daily', tz: 'UTC' } };
    api.setHealth.mockRejectedValue(new Error('Couldn’t save it. Try again.'));
    const m = await mount();
    await choose(m.select()!, 'off');
    expect(m.select()!.value).toBe('daily');
    expect(m.text()).toContain('Couldn’t save it. Try again.');
    m.root.unmount();
  });
});
