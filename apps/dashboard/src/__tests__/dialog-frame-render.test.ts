// @vitest-environment happy-dom
// DialogFrame, under ConfirmDialog: it opens and closes with `open`, Esc
// cancels unless busy, and a typed confirmation starts empty each time the
// dialog opens again.
import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open'); };
}

describe('DialogFrame', () => {
  it('opens and closes with open, clears the typed phrase on reopen, and ignores Esc while busy', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    const onCancel = vi.fn();
    const render = (open: boolean, busy = false) => act(async () => {
      root.render(h(ConfirmDialog, { open, busy, title: 'Let this rule stop agents?', body: 'Body', confirmLabel: 'Stop the agent', confirmPhrase: 'stop all agents', onConfirm: () => {}, onCancel }));
    });
    const dialog = () => el.querySelector('dialog')!;
    const input = () => el.querySelector('input') as HTMLInputElement;
    const confirm = () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Stop the agent') as HTMLButtonElement;

    await render(true);
    expect(dialog().open).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), 'stop all agents');
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(confirm().disabled).toBe(false);

    await render(false);
    expect(dialog().open).toBe(false);
    await render(true);
    expect(input().value).toBe('');
    expect(confirm().disabled).toBe(true);

    await render(true, true);
    await act(async () => { dialog().dispatchEvent(new Event('cancel', { cancelable: true })); });
    expect(onCancel).not.toHaveBeenCalled();
    await render(true, false);
    await act(async () => { dialog().dispatchEvent(new Event('cancel', { cancelable: true })); });
    expect(onCancel).toHaveBeenCalledTimes(1);
    root.unmount();
  });
});
