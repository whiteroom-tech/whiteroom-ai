// @vitest-environment happy-dom
// The pages shown for an address that doesn't exist and for a page that failed.

import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import NotFound from '@/app/not-found';
import PageError from '@/app/error';
import { ROUTES } from '@/lib/routes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(node: React.ReactNode) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(node); });
  return { el, root };
}

describe('not-found and error pages', () => {
  it('Page not found links to Home, inside the themed shell', async () => {
    const m = await mount(h(NotFound));
    expect(m.el.querySelector('main.wr-shell h1')?.textContent).toBe('Page not found');
    expect(m.el.querySelector('a.wr-btn')?.getAttribute('href')).toBe(ROUTES.home);
    m.root.unmount();
  });

  it('Something went wrong logs the error and Retry calls Next’s retry', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const retry = vi.fn();
    const failure = new Error('boom');
    const reset = vi.fn();
    const m = await mount(h(PageError, { error: failure, reset, retry }));
    expect(m.el.querySelector('main.wr-shell h1')?.textContent).toBe('Something went wrong');
    expect(log).toHaveBeenCalledWith(failure);
    const button = [...m.el.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    await act(async () => { button.click(); });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    // A Next that passes no retry: the button falls back to reset.
    const old = await mount(h(PageError, { error: failure, reset }));
    await act(async () => { old.el.querySelector('button')!.click(); });
    expect(reset).toHaveBeenCalledTimes(1);
    old.root.unmount();
    log.mockRestore();
    m.root.unmount();
  });
});
