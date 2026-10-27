// @vitest-environment happy-dom
// Agent health's fold-out rows in a DOM: a person's open/closed choice sticks when new data flips the default.
import { describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { UnusualRow as Row } from '@/components/performance/AgentHealth';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const row = { tone: 'warn' as const, text: '1 problem' };

function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  const render = (open: boolean) => act(() => root.render(h(Row, { row, open }, h('p', null, 'detail'))));
  const details = () => el.querySelector('details') as HTMLDetailsElement;
  // What the browser does on a click: flip `open`, then fire `toggle`.
  const click = () => act(() => { const d = details(); d.open = !d.open; d.dispatchEvent(new Event('toggle')); });
  return { render, details, click, root };
}

describe('fold-out row in the DOM', () => {
  it('follows its default until the person toggles it', () => {
    const m = mount();
    m.render(true);
    expect(m.details().open).toBe(true);
    m.render(false);
    expect(m.details().open).toBe(false);
    m.root.unmount();
  });

  it('a row the person closed stays closed when the default says open again', () => {
    const m = mount();
    m.render(true);
    m.click(); // closes it
    expect(m.details().open).toBe(false);
    m.render(false);
    m.render(true); // e.g. a refetch still has the problem
    expect(m.details().open).toBe(false);
    m.root.unmount();
  });

  it('a row the person opened stays open when the default stays closed', () => {
    const m = mount();
    m.render(false);
    m.click(); // opens it
    m.render(false);
    expect(m.details().open).toBe(true);
    m.root.unmount();
  });
});
