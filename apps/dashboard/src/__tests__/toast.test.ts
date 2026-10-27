// @vitest-environment happy-dom
// Toast closes itself after its time, but never while the pointer or focus
// is on it (so Undo stays in reach); the countdown restarts when it's left.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Toast } from '@whiteroom/ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(props: Partial<React.ComponentProps<typeof Toast>> = {}) {
  const onClose = vi.fn();
  const onUndo = vi.fn();
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(async () => { createRoot(el).render(h(Toast, { message: 'code-reviewer paused.', action: { label: 'Undo', onClick: onUndo }, onClose, ms: 1000, ...props })); });
  const box = el.querySelector<HTMLElement>('.wr-toast')!;
  const undo = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!;
  return { el, box, undo, onClose, onUndo };
}
const pass = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = ''; });
afterEach(() => { vi.useRealTimers(); });

describe('Toast', () => {
  it('closes itself after its time', async () => {
    const t = await mount();
    await pass(999);
    expect(t.onClose).not.toHaveBeenCalled();
    await pass(1);
    expect(t.onClose).toHaveBeenCalledTimes(1);
  });

  it('stays while the pointer is on it, and counts again from the start once it leaves', async () => {
    const t = await mount();
    await act(async () => { t.box.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
    await pass(5000);
    expect(t.onClose).not.toHaveBeenCalled();
    await act(async () => { t.box.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
    await pass(999);
    expect(t.onClose).not.toHaveBeenCalled();
    await pass(1);
    expect(t.onClose).toHaveBeenCalledTimes(1);
  });

  it('stays while it has focus', async () => {
    const t = await mount();
    await act(async () => { t.undo.focus(); });
    await pass(5000);
    expect(t.onClose).not.toHaveBeenCalled();
    await act(async () => { t.undo.blur(); });
    await pass(1000);
    expect(t.onClose).toHaveBeenCalledTimes(1);
  });

  it('runs its action and closes; Dismiss just closes', async () => {
    const t = await mount();
    await act(async () => { t.undo.click(); });
    expect(t.onUndo).toHaveBeenCalledTimes(1);
    expect(t.onClose).toHaveBeenCalledTimes(1);
    const d = await mount();
    await act(async () => { d.el.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click(); });
    expect(d.onClose).toHaveBeenCalledTimes(1);
    expect(d.onUndo).not.toHaveBeenCalled();
  });
});

describe('Toast countdown', () => {
  it("isn't restarted by a re-render with an equal message", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    const render = () => act(async () => { root.render(h(Toast, { message: h('span', null, 'Saved.'), onClose, ms: 1000 })); });
    await render();
    await act(async () => { vi.advanceTimersByTime(600); });
    await render();
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
