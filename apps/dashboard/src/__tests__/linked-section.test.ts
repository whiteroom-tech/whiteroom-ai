// @vitest-environment happy-dom
// A link to a Settings section lands on it even as the sections above grow,
// and stops following once the person takes over or after 4 seconds.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { useLinkedSection } from '@/hooks/useLinkedSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let onResize = () => {};
vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { onResize = cb; } observe() {} disconnect() { onResize = () => {}; } });
afterEach(() => { window.location.hash = ''; vi.useRealTimers(); });

/** Mounts a page with an #alerts section (or none) and returns its scroll spy. */
async function mount(hash: string, withSection = true) {
  window.location.hash = hash;
  onResize = () => {};
  const scroll = vi.fn();
  function Page() {
    const ref = useRef<HTMLDivElement>(null);
    useLinkedSection(ref);
    return h('div', { ref }, withSection ? h('div', { id: 'alerts', ref: (el: HTMLDivElement | null) => { if (el) el.scrollIntoView = scroll; } }) : null);
  }
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(Page)); });
  return { scroll, root };
}

describe('useLinkedSection', () => {
  it('scrolls to #section now and on each resize; typing (Tab) doesn’t stop it', async () => {
    const { scroll, root } = await mount('#alerts');
    expect(scroll).toHaveBeenCalledTimes(1);
    onResize();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    onResize();
    expect(scroll).toHaveBeenCalledTimes(3);
    root.unmount();
  });

  it.each([
    ['a press (scrollbar drag)', () => window.dispatchEvent(new Event('pointerdown'))],
    ['the wheel', () => window.dispatchEvent(new Event('wheel'))],
    ['a touch scroll', () => window.dispatchEvent(new Event('touchmove'))],
    ['ArrowDown', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))],
    ['Space', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))],
  ])('stops following after %s', async (_name, act_) => {
    const { scroll, root } = await mount('#alerts');
    act_();
    onResize();
    expect(scroll).toHaveBeenCalledTimes(1);
    root.unmount();
  });

  it('stops by itself after 4 seconds', async () => {
    vi.useFakeTimers();
    const { scroll, root } = await mount('#alerts');
    vi.advanceTimersByTime(4000);
    onResize();
    expect(scroll).toHaveBeenCalledTimes(1);
    root.unmount();
  });

  it('does nothing without a hash, or for a section that isn’t there', async () => {
    const a = await mount('');
    onResize();
    expect(a.scroll).not.toHaveBeenCalled();
    a.root.unmount();
    const b = await mount('#alerts', false);
    expect(b.scroll).not.toHaveBeenCalled();
    b.root.unmount();
  });
});
