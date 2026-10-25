// @vitest-environment happy-dom
// The Controls editor's pickers (spec Rev 1, D1): GroupPicker's chips, menu
// and "Other…" (trimmed, capped at 64 characters, no duplicates), and
// ScopeField's All agents / Specific agents.
import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { GroupPicker, ScopeField, type PickGroup } from '@/app/(citadel)/controls/_components/pickers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GROUPS: PickGroup[] = [{ label: 'Fast', options: [{ id: 'm-a', label: 'Model A' }, { id: 'm-b', label: 'Model B' }] }];

async function mount(node: React.ReactElement) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(node); });
  return { el, root };
}
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('GroupPicker', () => {
  const picker = (values: string[], onChange: (v: string[]) => void) =>
    h(GroupPicker, { values, onChange, groups: GROUPS, addLabel: '+ add model', otherLabel: 'Other model…', placeholder: 'model id' });

  it('shows picks as chips by label, offers only what isn’t picked, and removes a chip', async () => {
    const onChange = vi.fn();
    const { el, root } = await mount(picker(['m-a'], onChange));
    expect(el.textContent).toContain('Model A');
    const options = [...el.querySelectorAll('select[aria-label="+ add model"] option')].map((o) => o.textContent);
    expect(options).toEqual(['+ add model', 'Model B', 'Other model…']);
    await choose(el.querySelector('select[aria-label="+ add model"]')!, 'm-b');
    expect(onChange).toHaveBeenLastCalledWith(['m-a', 'm-b']);
    await act(async () => { (el.querySelector('button[aria-label="Remove Model A"]') as HTMLButtonElement).click(); });
    expect(onChange).toHaveBeenLastCalledWith([]);
    root.unmount();
  });

  it('"Other…" adds a trimmed value, capped at 64 characters, and never a duplicate or a blank', async () => {
    const onChange = vi.fn();
    const { el, root } = await mount(picker(['m-a'], onChange));
    const other = async (text: string) => {
      await choose(el.querySelector('select[aria-label="+ add model"]')!, '__other__');
      await type(el.querySelector('input[aria-label="Other model…"]') as HTMLInputElement, text);
      await act(async () => { ([...el.querySelectorAll('button')].find((b) => b.textContent === 'Add') as HTMLButtonElement).click(); });
    };
    await other('  my-deployment  ');
    expect(onChange).toHaveBeenLastCalledWith(['m-a', 'my-deployment']);
    await other('x'.repeat(100));
    expect(onChange).toHaveBeenLastCalledWith(['m-a', 'x'.repeat(64)]);
    onChange.mockClear();
    await other('m-a');
    await other('   ');
    expect(onChange).not.toHaveBeenCalled();
    expect(el.querySelector('input[aria-label="Other model…"]')).toBeNull();
    root.unmount();
  });
});

describe('ScopeField', () => {
  it('switches between All agents and chosen agents, adds and removes one', async () => {
    const onChange = vi.fn();
    const { el, root } = await mount(h(ScopeField, { scope: 'all', agents: ['a1', 'a2'], onChange }));
    expect(el.querySelector('select[aria-label="+ add agent"]')).toBeNull();
    await choose(el.querySelector('select[aria-label="Which agents this rule applies to"]')!, 'some');
    expect(onChange).toHaveBeenLastCalledWith([]);
    await act(async () => { root.render(h(ScopeField, { scope: ['a1'], agents: ['a1', 'a2'], onChange })); });
    expect([...el.querySelectorAll('select[aria-label="+ add agent"] option')].map((o) => o.textContent)).toEqual(['+ add agent', 'a2', 'Other (type an agent name)…']);
    await choose(el.querySelector('select[aria-label="+ add agent"]')!, 'a2');
    expect(onChange).toHaveBeenLastCalledWith(['a1', 'a2']);
    await act(async () => { (el.querySelector('button[aria-label="Remove a1"]') as HTMLButtonElement).click(); });
    expect(onChange).toHaveBeenLastCalledWith([]);
    await choose(el.querySelector('select[aria-label="Which agents this rule applies to"]')!, 'all');
    expect(onChange).toHaveBeenLastCalledWith('all');
    root.unmount();
  });
});

describe('ScopeField with no agents yet', () => {
  it('says so, and takes a typed agent name', async () => {
    const onChange = vi.fn();
    const { el, root } = await mount(h(ScopeField, { scope: [], agents: [], onChange }));
    expect(el.textContent).toContain('No agents have made a call yet. Pick Other to type an agent’s name.');
    await choose(el.querySelector('select[aria-label="+ add agent"]')!, '__other__');
    await type(el.querySelector('input[aria-label="Other (type an agent name)…"]') as HTMLInputElement, ' keyword-test ');
    await act(async () => { ([...el.querySelectorAll('button')].find((b) => b.textContent === 'Add') as HTMLButtonElement).click(); });
    expect(onChange).toHaveBeenLastCalledWith(['keyword-test']);
    root.unmount();
  });
});
