// @vitest-environment happy-dom
// Settings › Alerts: a failed read says so (with Try again) instead of hiding
// the card, and a late reply for one channel can't undo a newer change to the other.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ alerts: vi.fn(), slack: vi.fn(), teams: vi.fn() }));
const auth = vi.hoisted(() => ({ value: { status: 'authenticated', fleetId: 'fleet-a' as string | null } }));
vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => auth.value }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  alertsGet: api.alerts, alertsSetSlack: api.slack, alertsSetTeams: api.teams,
}));
const { AlertsSection } = await import('@/components/settings/AlertsSection');

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
async function mount() {
  el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
  await act(async () => root.render(h(AlertsSection))); await flush();
}
const buttons = (text: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent === text);

beforeEach(() => {
  vi.clearAllMocks();
  auth.value = { status: 'authenticated', fleetId: 'fleet-a' };
  api.alerts.mockReset().mockResolvedValue({ slack: { ending: 'aaaa' }, teams: { ending: 'bbbb' } });
});
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; });

it('a failed read keeps the card and offers Try again', async () => {
  api.alerts.mockRejectedValueOnce(new Error('HTTP 503'));
  await mount();
  expect(el.textContent).toContain('Alerts');
  expect(el.textContent).toContain('Couldn’t load alert settings.');
  await act(async () => buttons('Try again')[0].click()); await flush();
  expect(api.alerts).toHaveBeenCalledTimes(2);
  expect(el.textContent).toContain('Webhook ending …aaaa');
  expect(el.textContent).not.toContain('Couldn’t load');
});

it('an engine without alerts still hides the card', async () => {
  api.alerts.mockResolvedValueOnce(null);
  await mount();
  expect(el.innerHTML).toBe('');
});

it('no fleet: no card, nothing read', async () => {
  auth.value = { status: 'authenticated', fleetId: null };
  await mount();
  expect(el.innerHTML).toBe('');
  expect(api.alerts).not.toHaveBeenCalled();
});

it('a late Slack reply carrying the old Teams status does not bring Teams back', async () => {
  let finishSlack!: (value: unknown) => void;
  api.slack.mockReturnValue(new Promise((resolve) => { finishSlack = resolve; }));
  api.teams.mockResolvedValue({ slack: null, teams: null });
  await mount();
  await act(async () => buttons('Remove')[0].click()); // Slack: its reply is held
  await act(async () => buttons('Remove')[0].click()); // Teams: answers at once
  await flush();
  // Teams' reply changes only Teams: Slack is still waiting on its own reply.
  expect(el.textContent).not.toContain('…bbbb');
  expect(el.textContent).toContain('Removing…');
  // Slack's held reply was taken before Teams was removed, so it still lists Teams.
  await act(async () => finishSlack({ slack: null, teams: { ending: 'bbbb' } })); await flush();
  expect(el.textContent).not.toContain('Webhook ending');
  expect(el.textContent).toContain('Microsoft Teams alerts are off.');
  expect(el.textContent).toContain('Slack alerts are off.');
});

it('the other order: a late Teams reply does not bring Slack back', async () => {
  let finishTeams!: (value: unknown) => void;
  api.teams.mockReturnValue(new Promise((resolve) => { finishTeams = resolve; }));
  api.slack.mockResolvedValue({ slack: null, teams: null });
  await mount();
  await act(async () => buttons('Remove')[1].click()); // Teams: held
  await act(async () => buttons('Remove')[0].click()); // Slack: answers at once
  await flush();
  await act(async () => finishTeams({ slack: { ending: 'aaaa' }, teams: null })); await flush();
  expect(el.textContent).not.toContain('…aaaa');
  expect(el.textContent).toContain('Slack alerts are off.');
});
