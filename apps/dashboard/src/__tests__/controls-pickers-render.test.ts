// @vitest-environment happy-dom
// The Controls editor's pickers (spec Rev 1, D1): GroupPicker's chips, menu
// and "Other…" (trimmed, capped at 64 characters, no duplicates), and
// ScopeField's All agents / Specific agents.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { GroupPicker, InlineSelect, MarkerChip, ScopeField, TOOL_GROUPS, ToolPicker, toolGroups, type PickGroup } from '@/app/(citadel)/controls/_components/pickers';
import { looksLikeDeleteOrChange } from '@/lib/controls-view';

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
    expect(el.querySelector('select[aria-label="Add an agent"]')).toBeNull();
    await choose(el.querySelector('select[aria-label="Which agents this rule applies to"]')!, 'some');
    expect(onChange).toHaveBeenLastCalledWith([]);
    await act(async () => { root.render(h(ScopeField, { scope: ['a1'], agents: ['a1', 'a2'], onChange })); });
    expect([...el.querySelectorAll('select[aria-label="Add an agent"] option')].map((o) => o.textContent)).toEqual(['+ Add agent', 'a2', 'Other (type an agent name)…']);
    await choose(el.querySelector('select[aria-label="Add an agent"]')!, 'a2');
    expect(onChange).toHaveBeenLastCalledWith(['a1', 'a2']);
    await act(async () => { (el.querySelector('button[aria-label="Remove a1"]') as HTMLButtonElement).click(); });
    expect(onChange).toHaveBeenLastCalledWith([]);
    await choose(el.querySelector('select[aria-label="Which agents this rule applies to"]')!, 'all');
    expect(onChange).toHaveBeenLastCalledWith('all');
    root.unmount();
  });
});

describe('ScopeField, typing a name', () => {
  it('takes a name not in the list beside known agents, but not one already chosen', async () => {
    const onChange = vi.fn();
    const { el, root } = await mount(h(ScopeField, { scope: ['a1'], agents: ['a1', 'a2'], onChange }));
    expect(el.textContent).not.toContain('No agents have made a call yet');
    const other = async (text: string) => {
      await choose(el.querySelector('select[aria-label="Add an agent"]')!, '__other__');
      await type(el.querySelector('input[aria-label="Other (type an agent name)…"]') as HTMLInputElement, text);
      await act(async () => { ([...el.querySelectorAll('button')].find((b) => b.textContent === 'Add') as HTMLButtonElement).click(); });
    };
    await other('night-batch');
    expect(onChange).toHaveBeenLastCalledWith(['a1', 'night-batch']);
    onChange.mockClear();
    await other('a1');
    expect(onChange).not.toHaveBeenCalled();
    root.unmount();
  });
});

describe('ScopeField with no agents yet', () => {
  it('says so, and takes a typed agent name', async () => {
    const onChange = vi.fn();
    const { el, root } = await mount(h(ScopeField, { scope: [], agents: [], onChange }));
    expect(el.textContent).toContain('No agents have made a call yet. Pick Other to type an agent’s name.');
    await choose(el.querySelector('select[aria-label="Add an agent"]')!, '__other__');
    await type(el.querySelector('input[aria-label="Other (type an agent name)…"]') as HTMLInputElement, ' keyword-test ');
    await act(async () => { ([...el.querySelectorAll('button')].find((b) => b.textContent === 'Add') as HTMLButtonElement).click(); });
    expect(onChange).toHaveBeenLastCalledWith(['keyword-test']);
    root.unmount();
  });
});

describe('Editor controls look like buttons and selects, and stay real controls', () => {
  it('shows "+ Add tool" as a button over a labelled, usable native menu', async () => {
    const onChange = vi.fn();
    const { el, root } = await mount(h(GroupPicker, { values: [], onChange, groups: GROUPS, addLabel: '+ Add tool', ariaLabel: 'Add a tool', otherLabel: 'Other…', placeholder: 'tool' }));
    const button = el.querySelector('.gov-addpick')!;
    expect(button.classList.contains('wr-btn')).toBe(true);
    expect(button.querySelector('[aria-hidden="true"]')?.textContent).toBe('+ Add tool');
    const select = button.querySelector('select')!;
    expect(select.getAttribute('aria-label')).toBe('Add a tool');
    expect(select.disabled).toBe(false);
    expect(select.tabIndex).not.toBe(-1);
    await choose(select, 'm-a');
    expect(onChange).toHaveBeenLastCalledWith(['m-a']);
    root.unmount();
  });

  it('dresses a native select in the shared select style, with its label', async () => {
    const onChange = vi.fn();
    const { el, root } = await mount(h(InlineSelect<'run' | 'day'>, { label: 'Limit period', value: 'run', options: ['run', 'day'], onChange }));
    const wrap = el.querySelector('.wr-select.gov-select')!;
    const select = wrap.querySelector('select')!;
    expect(select.getAttribute('aria-label')).toBe('Limit period');
    expect(wrap.querySelector('svg')).not.toBeNull();
    await choose(select, 'day');
    expect(onChange).toHaveBeenLastCalledWith('day');
    root.unmount();
  });
});

describe('ToolPicker: the fleet’s own tools (tools_seen)', () => {
  const options = (el: HTMLElement) => [...el.querySelectorAll('select[aria-label="Add a tool"] option')].map((o) => o.textContent);
  const groups = (el: HTMLElement) => [...el.querySelectorAll('select[aria-label="Add a tool"] optgroup')].map((g) => g.getAttribute('label'));
  const today = async () => {
    const { el, root } = await mount(h(GroupPicker, { values: [], onChange: () => {}, groups: TOOL_GROUPS, addLabel: '+ Add tool', ariaLabel: 'Add a tool', otherLabel: 'Other (type tool name)…', placeholder: 'tool name' }));
    const html = el.innerHTML;
    root.unmount();
    return html;
  };

  it('takes a longer name where its list does, under its own label; everywhere else the limit is unchanged', async () => {
    const add = async (el: HTMLElement, label: string, text: string) => {
      await choose(el.querySelector('select[aria-label="Add a tool"]')!, '__other__');
      await type(el.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement, text);
      await act(async () => { ([...el.querySelectorAll('button')].find((b) => b.textContent === 'Add') as HTMLButtonElement).click(); });
    };
    const long = vi.fn();
    const a = await mount(h(ToolPicker, { values: [], onChange: long, fleetTools: [], onShow: () => {}, maxLength: 128, otherLabel: 'Other (type tool name, or the start of one and *)…' }));
    await add(a.el, 'Other (type tool name, or the start of one and *)…', `mcp__billing__${'x'.repeat(100)}`);
    expect(long).toHaveBeenLastCalledWith([`mcp__billing__${'x'.repeat(100)}`]);
    await add(a.el, 'Other (type tool name, or the start of one and *)…', 'y'.repeat(200));
    expect(long).toHaveBeenLastCalledWith(['y'.repeat(128)]);
    a.root.unmount();
    const plain = vi.fn();
    const b = await mount(h(ToolPicker, { values: [], onChange: plain, fleetTools: [], onShow: () => {} }));
    await add(b.el, 'Other (type tool name)…', 'z'.repeat(200));
    expect(plain).toHaveBeenLastCalledWith(['z'.repeat(64)]);
    b.root.unmount();
  });

  it('with no fleet tools is exactly today’s picker, and asks for them once shown', async () => {
    expect(toolGroups([])).toBe(TOOL_GROUPS);
    const onShow = vi.fn();
    const { el, root } = await mount(h(ToolPicker, { values: [], onChange: () => {}, fleetTools: [], onShow }));
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(el.innerHTML).toBe(await today());
    root.unmount();
  });

  it('puts the fleet’s tools first, opens on "Choose a tool…", and keeps every group it had', async () => {
    const onChange = vi.fn();
    const { el, root } = await mount(h(ToolPicker, { values: ['send_email'], onChange, fleetTools: ['search_claims', 'update_claim', 'send_email'], onShow: () => {}, first: looksLikeDeleteOrChange }));
    const select = el.querySelector('select[aria-label="Add a tool"]') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(options(el)[0]).toBe('Choose a tool…');
    expect(groups(el)).toEqual(['Your fleet’s tools', ...TOOL_GROUPS.map((g) => g.label)]);
    // Delete-looking first; a tool already picked isn't offered.
    expect([...el.querySelectorAll('optgroup')][0].textContent).toBe('update_claimsearch_claims');
    expect(options(el)).toContain('read_file');
    await choose(select, 'update_claim');
    expect(onChange).toHaveBeenLastCalledWith(['send_email', 'update_claim']);
    root.unmount();
  });
});

describe('MarkerChip', () => {
  const CODE = 'wrmk3f9a1c07b2e4d8a6';
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads Marker and the short code, and Copy copies the whole code', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const onRemove = vi.fn();
    const { el, root } = await mount(h(MarkerChip, { code: CODE, onRemove }));
    expect(el.textContent).toContain('Marker');
    expect(el.textContent).toContain('wrmk3f9a…d8a6');
    expect(el.textContent).not.toContain(CODE);
    await act(async () => { (el.querySelector('button[aria-label="Copy marker wrmk3f9a…d8a6"]') as HTMLButtonElement).click(); });
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(el.textContent).toContain('Copied');
    await act(async () => { (el.querySelector('button[aria-label="Remove marker wrmk3f9a…d8a6"]') as HTMLButtonElement).click(); });
    expect(onRemove).toHaveBeenCalled();
    root.unmount();
  });

  it('when the browser refuses to copy, shows the whole code to select; the note goes after a few seconds, the code stays until a copy works', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async (): Promise<void> => { throw new Error('denied'); });
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { el, root } = await mount(h(MarkerChip, { code: CODE, onRemove: () => {} }));
    const copy = () => act(async () => { (el.querySelector('button[aria-label="Copy marker wrmk3f9a…d8a6"]') as HTMLButtonElement).click(); });
    await copy();
    expect(el.textContent).toContain(CODE);
    expect(el.textContent).toContain('Couldn’t copy. Select the code to copy it.');
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(el.textContent).not.toContain('Couldn’t copy');
    expect(el.textContent).toContain(CODE);
    // A retry that works puts the short code back.
    writeText.mockImplementation(async () => {});
    await copy();
    expect(el.textContent).not.toContain(CODE);
    expect(el.textContent).toContain('wrmk3f9a…d8a6');
    root.unmount();
    vi.useRealTimers();
  });
});
