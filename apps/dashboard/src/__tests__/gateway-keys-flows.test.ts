// @vitest-environment happy-dom
// Fleet key's Gateway signing keys card, driven: add, revoke through the
// dialog, a non-owner's refusal, a pasted private key, and a saved change
// whose list reload fails. All placeholders; no real keys.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import './support/dialog';

const api = vi.hoisted(() => ({ get: vi.fn(), add: vi.fn(), revoke: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  gatewayKeysGet: api.get, gatewayKeyAdd: api.add, gatewayKeyRevoke: api.revoke,
}));
const { ControlDeniedError } = await import('@/lib/whiteroom/client');
const { GatewayKeysCard } = await import('@/app/fleet-key/gateway-keys');

const KEY = { kid: '0000000000000a01', addedAt: '2026-11-20T10:00:00Z', lastUsedAt: null };
const PUBLIC = '-----BEGIN PUBLIC KEY-----\nplaceholder\n-----END PUBLIC KEY-----';

async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(async () => { createRoot(el).render(h(GatewayKeysCard, { apiKey: 'sk-wr-placeholder', fleetId: 'f', fleetToken: null })); });
  const paste = async (text: string) => {
    const box = el.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
  const click = async (label: string) => { await act(async () => { button(label)!.click(); }); };
  return { el, paste, button, click, text: () => el.textContent ?? '' };
}

beforeEach(() => {
  document.body.innerHTML = '';
  for (const f of Object.values(api)) f.mockReset();
});

describe('gateway signing keys card, driven', () => {
  it('adds a pasted public key and shows it in the list', async () => {
    api.get.mockResolvedValueOnce({ keys: [], max: 2 }).mockResolvedValueOnce({ keys: [KEY], max: 2 });
    api.add.mockResolvedValue(undefined);
    const c = await mount();
    expect(c.text()).toContain('No gateway keys yet.');
    await c.paste(`  ${PUBLIC}\n`);
    await c.click('Add key');
    expect(api.add).toHaveBeenCalledWith({ apiKey: 'sk-wr-placeholder', fleetId: 'f', fleetToken: null }, PUBLIC);
    expect(c.text()).toContain('0000000000000a01');
    expect((c.el.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });

  it('never sends a pasted private key', async () => {
    api.get.mockResolvedValue({ keys: [], max: 2 });
    const c = await mount();
    await c.paste(['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' '));
    expect(c.text()).toContain('That’s a private key. Don’t share it. Make a new pair.');
    expect(c.button('Add key')!.disabled).toBe(true);
    expect(api.add).not.toHaveBeenCalled();
  });

  it('revokes a key after the dialog asks', async () => {
    api.get.mockResolvedValueOnce({ keys: [KEY], max: 2 }).mockResolvedValueOnce({ keys: [], max: 2 });
    api.revoke.mockResolvedValue(undefined);
    const c = await mount();
    await c.click('Revoke');
    expect(document.body.textContent).toContain('Revoke key 00000000…?');
    expect(api.revoke).not.toHaveBeenCalled();
    // The dialog's own Revoke: the last one on the page.
    const buttons = [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Revoke');
    await act(async () => { buttons.at(-1)!.click(); });
    expect(api.revoke).toHaveBeenCalledWith(expect.anything(), '0000000000000a01');
    expect(c.text()).toContain('No gateway keys yet.');
  });

  it('shows the engine’s reason, and a non-owner’s refusal leaves the list read-only', async () => {
    api.get.mockResolvedValue({ keys: [KEY], max: 2 });
    api.add.mockRejectedValue(new ControlDeniedError('Only the fleet owner can do that.'));
    const c = await mount();
    await c.paste(PUBLIC);
    await c.click('Add key');
    expect(c.text()).toContain('Only the fleet owner can do that.');
    expect(c.el.querySelector('.wr-gw__revoke')).toBeNull();
    expect(c.el.querySelector('textarea')).toBeNull();
    expect(c.text()).toContain('0000000000000a01');
  });

  it('says the change was saved when only the list reload fails', async () => {
    api.get.mockResolvedValueOnce({ keys: [], max: 2 }).mockRejectedValueOnce(new Error('down'));
    api.add.mockResolvedValue(undefined);
    const c = await mount();
    await c.paste(PUBLIC);
    await c.click('Add key');
    expect(c.text()).toContain('Saved. Reload the page to see the list.');
    expect(c.text()).not.toContain('wasn’t added');
  });
});
