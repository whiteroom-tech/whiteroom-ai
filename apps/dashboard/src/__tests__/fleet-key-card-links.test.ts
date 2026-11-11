// Fleet key: "Provider keys below" links to its card, and the card carries that id (UX U3, F-1).
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: async () => null, signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock('@/lib/owner-credentials', () => ({ rotateApiKey: vi.fn(), replaceProxyUrls: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
const { Onboarding } = await import('@/app/fleet-key/onboarding');
const { SettingsCard } = await import('@/components/settings/SettingsCard');

const parse = (html: string) => { const el = new Window().document.createElement('div'); el.innerHTML = html; return el; };

describe('Fleet key card links', () => {
  it('links "Provider keys below" to the Provider keys card, which has that id', () => {
    const el = parse(renderToStaticMarkup(h(Onboarding, {
      name: 'Test', email: 'test@example.invalid', apiKey: 'sk-wr-placeholder', fleetId: 'f', fleetToken: null, isNew: false, previewKeys: [],
    })));
    const link = [...el.querySelectorAll('a')].find((a) => a.textContent === 'Provider keys below');
    expect(link?.getAttribute('href')).toBe('#provider-keys');
    expect(el.querySelector('section#provider-keys')).not.toBeNull();
  });

  it('puts the id on the section only when asked, so an existing wrapper id is never doubled', () => {
    const on = parse(renderToStaticMarkup(h(SettingsCard, { id: 'provider-keys', anchor: true, title: 'Provider keys' })));
    expect(on.querySelector('section')?.id).toBe('provider-keys');
    expect(on.querySelector('h2')?.id).toBe('provider-keys-title');
    const off = parse(renderToStaticMarkup(h(SettingsCard, { id: 'alerts', title: 'Alerts' })));
    expect(off.querySelector('section')?.hasAttribute('id')).toBe(false);
  });
});
