// @vitest-environment happy-dom
// The sidebar shows theme, text size and sign out in the open (no ⋯ menu),
// and every Text size control on the page follows a change made in another.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => h('a', { href, ...rest }, children) }));

const { SidebarPreferences } = await import('@/components/SidebarPreferences');
const { TextSizeControl } = await import('@/components/TextSizeControl');

async function mount(node: React.ReactElement) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(async () => { createRoot(el).render(node); });
  return el;
}
const radio = (el: Element, name: string) => el.querySelector<HTMLButtonElement>(`[role="radiogroup"][aria-label="${name}"]`);
const checked = (group: Element | null) => group?.querySelector('[aria-checked="true"]')?.textContent;

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-wr-text');
  localStorage.clear();
});

describe('sidebar preferences', () => {
  it('shows theme, text size (A / A+ / A++) and sign out without opening anything', async () => {
    const el = await mount(h(SidebarPreferences, { organization: null, invitations: 0 }));
    expect([...radio(el, 'Theme')!.querySelectorAll('[role="radio"]')].map((b) => b.textContent)).toEqual(['Dark', 'Light', 'System']);
    const sizes = [...radio(el, 'Text size')!.querySelectorAll('[role="radio"]')];
    expect(sizes.map((b) => b.textContent)).toEqual(['A', 'A+', 'A++']);
    expect(sizes.map((b) => b.getAttribute('aria-label'))).toEqual(['Default text size', 'Large text size', 'Larger text size']);
    expect(el.querySelector('a[href="/auth/sign-out"], a[href*="sign-out"]')?.textContent).toBe('Sign out');
    expect(el.textContent).not.toContain('Organization');
  });

  it('links the organization, with pending invitations', async () => {
    const el = await mount(h(SidebarPreferences, { organization: 'Acme', invitations: 2 }));
    expect(el.textContent).toContain('Acme');
    expect(el.textContent).toContain('2 invites');
  });

  it('applies a text size at once, and the Settings control follows it', async () => {
    const side = await mount(h(TextSizeControl, { compact: true }));
    const settings = await mount(h(TextSizeControl));
    expect(checked(radio(settings, 'Text size'))).toBe('Default');
    const larger = [...radio(side, 'Text size')!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'A++')!;
    await act(async () => { larger.click(); });
    expect(document.documentElement.getAttribute('data-wr-text')).toBe('xl');
    expect(localStorage.getItem('wr_text')).toBe('xl');
    expect(checked(radio(settings, 'Text size'))).toBe('Larger');
    expect(checked(radio(side, 'Text size'))).toBe('A++');
  });
});
