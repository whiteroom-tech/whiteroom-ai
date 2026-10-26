// @vitest-environment happy-dom
// Agent detail's Remove: a typed-name confirm, then deregister_agent and back
// to Home; a failure stays on the page with a retry.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import './support/dialog';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push, replace: vi.fn() }), usePathname: () => '/agents/scout' }));
const api = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  checkWatch: async () => ({ status: 'idle', watchNumber: 1, govV1: true }),
  auditLog: async () => ({ entries: [] }),
  getHandover: async () => ({}),
  removeAgent: api.remove,
}));
vi.mock('@/lib/control-actors', async (orig) => ({ ...(await orig<typeof import('@/lib/control-actors')>()), fetchControlActors: async () => [] }));
vi.mock('@/components/agent/RecentRuns', () => ({ RecentRuns: () => null }));
vi.mock('@/components/agent/GoalPanel', () => ({ GoalPanel: () => null }));
vi.mock('@/components/agent/HandoverQualityPanel', () => ({ HandoverQualityPanel: () => null }));
vi.mock('@/components/citadel/PageChrome', async () => {
  const { createElement } = await import('react');
  return { PageHeader: ({ children }: { children?: React.ReactNode }) => createElement('header', null, children) };
});

import { AgentDetail } from '@/components/agent/AgentDetail';

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };

async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(AgentDetail, { fleetId: 'f1', authKey: 'k', agentId: 'scout', from: 'home' })); });
  await flush();
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
  const click = async (b: Element | undefined) => { expect(b, 'button').toBeTruthy(); await act(async () => { (b as HTMLElement).click(); }); await flush(); };
  const dialog = () => [...el.querySelectorAll('dialog[open]')].at(-1) as HTMLDialogElement | undefined;
  const typeName = async (value: string) => {
    const input = dialog()!.querySelector('input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
  };
  return { el, root, button, click, dialog, typeName };
}

beforeEach(() => { nav.push.mockClear(); api.remove.mockReset(); document.body.innerHTML = ''; });

describe('Agent detail: Remove', () => {
  it('asks for the agent’s name, says what stays, then removes it and goes Home', async () => {
    api.remove.mockResolvedValue({ success: true });
    const m = await mount();
    await m.click(m.button('Remove…'));
    expect(m.dialog()!.textContent).toContain('Remove scout?');
    expect(m.dialog()!.textContent).toContain('Its audit trail, rule history and rule actions stay.');
    const confirm = () => [...m.dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Remove agent') as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    await m.typeName('scout');
    expect(confirm().disabled).toBe(false);
    await m.click(confirm());
    expect(api.remove).toHaveBeenCalledWith('f1', 'scout', 'k');
    expect(nav.push).toHaveBeenCalledWith('/home');
    m.root.unmount();
  });

  it('a failed remove stays on the page, says nothing changed, and can be retried', async () => {
    api.remove.mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce({ success: true });
    const m = await mount();
    await m.click(m.button('Remove…'));
    await m.typeName('scout');
    await m.click([...m.dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Remove agent'));
    expect(m.el.textContent).toContain('Couldn’t remove scout. Network error Nothing changed.');
    expect(nav.push).not.toHaveBeenCalled();
    await m.click(m.button('Try again'));
    expect(api.remove).toHaveBeenCalledTimes(2);
    expect(nav.push).toHaveBeenCalledWith('/home');
    m.root.unmount();
  });
});
