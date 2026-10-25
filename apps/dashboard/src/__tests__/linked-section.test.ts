// @vitest-environment happy-dom
// A link to a Settings section lands on it even as the sections above grow,
// and stops following once the person scrolls.
import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { useLinkedSection } from '@/hooks/useLinkedSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useLinkedSection', () => {
  it('scrolls to #section now and on each resize, until the person scrolls', async () => {
    let onResize = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { onResize = cb; } observe() {} disconnect() { onResize = () => {}; } });
    window.location.hash = '#alerts';
    const scroll = vi.fn();
    function Page() {
      const ref = useRef<HTMLDivElement>(null);
      useLinkedSection(ref);
      return h('div', { ref }, h('div', { id: 'alerts', ref: (el: HTMLDivElement | null) => { if (el) el.scrollIntoView = scroll; } }));
    }
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(Page)); });
    expect(scroll).toHaveBeenCalledTimes(1);
    onResize();
    expect(scroll).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('wheel'));
    onResize();
    expect(scroll).toHaveBeenCalledTimes(2);
    root.unmount();
    vi.unstubAllGlobals();
    window.location.hash = '';
  });
});
