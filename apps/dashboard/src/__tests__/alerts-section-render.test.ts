// @vitest-environment happy-dom
// Settings › Alerts with Slack and Microsoft Teams (engine E5): a row per
// channel, each connected, tested and removed on its own; Teams only where
// the engine has it.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  status: { slack: null, teams: null } as { slack: { ending: string } | null; teams?: { ending: string } | null },
  setTeams: vi.fn(),
  setSlack: vi.fn(),
  test: vi.fn(async () => ({ success: true })),
}));
vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => ({ status: 'authenticated', fleetId: 'f1' }) }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  alertsGet: async () => api.status,
  alertsSetTeams: api.setTeams,
  alertsSetSlack: api.setSlack,
  alertsTest: api.test,
}));
const { AlertsSection } = await import('@/components/settings/AlertsSection');

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(AlertsSection)); });
  await flush();
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
  return { el, root, text: () => el.textContent ?? '', button };
}
beforeEach(() => { api.status = { slack: null, teams: null }; api.setTeams.mockReset(); api.setSlack.mockReset(); api.test.mockClear(); document.body.innerHTML = ''; });

describe('Settings › Alerts', () => {
  it('offers Slack and Microsoft Teams, each on its own', async () => {
    const m = await mount();
    expect(m.text()).toContain('A Slack or Teams message when a rule alerts you');
    expect(m.button('Connect Slack')).toBeTruthy();
    expect(m.button('Connect Teams')).toBeTruthy();
    m.root.unmount();
  });

  it('connects Teams, then tests it on its own channel', async () => {
    api.setTeams.mockImplementation(async () => ({ slack: null, teams: { ending: '2345' } }));
    const m = await mount();
    const input = m.el.querySelector('input[aria-label="Microsoft Teams webhook URL"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://prod-1.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=x');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input.form!.requestSubmit(); });
    await flush();
    expect(api.setTeams).toHaveBeenCalledWith('f1', 'https://prod-1.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=x');
    expect(m.text()).toContain('Webhook ending …2345');
    expect(m.button('Connect Slack')).toBeTruthy(); // Slack is untouched
    await act(async () => { m.button('Send a test')!.click(); });
    await flush();
    expect(api.test).toHaveBeenCalledWith('f1', 'teams');
    m.root.unmount();
  });

  it('connects, tests and removes Slack on its own channel', async () => {
    const SLACK = 'https://hooks.slack.com/services/T000/B000/abcdefghijklmnop';
    api.setSlack.mockImplementation(async (_f: string, url: string | null) => ({ slack: url ? { ending: 'mnop' } : null, teams: null }));
    const m = await mount();
    const input = m.el.querySelector('input[aria-label="Slack incoming webhook URL"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, SLACK);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input.form!.requestSubmit(); });
    await flush();
    expect(api.setSlack).toHaveBeenCalledWith('f1', SLACK);
    expect(api.setTeams).not.toHaveBeenCalled();
    expect(m.text()).toContain('Webhook ending …mnop');
    await act(async () => { m.button('Send a test')!.click(); });
    await flush();
    expect(api.test).toHaveBeenCalledWith('f1', 'slack');
    await act(async () => { m.button('Remove')!.click(); });
    await flush();
    expect(api.setSlack).toHaveBeenLastCalledWith('f1', null);
    expect(m.text()).toContain('Slack alerts are off.');
    m.root.unmount();
  });

  it('removes Teams and leaves Slack connected', async () => {
    api.status = { slack: { ending: 'mnop' }, teams: { ending: '2345' } };
    api.setTeams.mockImplementation(async () => ({ slack: { ending: 'mnop' }, teams: null }));
    const m = await mount();
    const teamsRow = () => [...m.el.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Remove');
    expect(teamsRow()).toHaveLength(2);
    await act(async () => { teamsRow()[1].click(); });
    await flush();
    expect(api.setTeams).toHaveBeenCalledWith('f1', null);
    expect(m.text()).toContain('Microsoft Teams alerts are off.');
    expect(m.text()).toContain('Webhook ending …mnop');
    expect(m.button('Connect Teams')).toBeTruthy();
    m.root.unmount();
  });

  it('says so when a channel refuses the test message', async () => {
    api.status = { slack: null, teams: { ending: '2345' } };
    api.test.mockResolvedValueOnce({ success: false });
    const m = await mount();
    await act(async () => { m.button('Send a test')!.click(); });
    await flush();
    expect(api.test).toHaveBeenCalledWith('f1', 'teams');
    expect(m.text()).toContain('Microsoft Teams didn’t accept the test message.');
    m.root.unmount();
  });

  it('shows only Slack on an engine without Teams alerts', async () => {
    api.status = { slack: { ending: 'mnop' } };
    const m = await mount();
    expect(m.text()).toContain('A Slack message when');
    expect(m.text()).not.toContain('Microsoft Teams');
    m.root.unmount();
  });
});
