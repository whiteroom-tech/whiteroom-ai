import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Banner, Button, DataTable, Hint, Panel, SegmentedControl, SelectChip, StatusPill, Tag, Toggle,
} from '@whiteroom/ui';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => {};

describe('Button', () => {
  it('defaults to a secondary 32px type="button"', () => {
    const out = html(h(Button, null, 'Refresh'));
    expect(out).toContain('type="button"');
    expect(out).toContain('wr-btn--secondary');
    expect(out).toContain('wr-btn--h32');
  });

  it('is disabled and shows the busy label while busy', () => {
    const out = html(h(Button, { variant: 'primary', busy: true, busyLabel: 'Saving…' }, 'Save'));
    expect(out).toContain('disabled=""');
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('Saving…');
    expect(out).not.toContain('>Save<');
  });
});

describe('SegmentedControl', () => {
  const out = html(h(SegmentedControl<'24h' | '3d' | '7d'>, {
    label: 'Time range',
    value: '3d',
    onChange: noop,
    options: [{ value: '24h', label: '24h' }, { value: '3d', label: '3d' }, { value: '7d', label: '7d', dot: 'warn' }],
  }));

  it('is a named radiogroup with one checked radio', () => {
    expect(out).toContain('role="radiogroup"');
    expect(out).toContain('aria-label="Time range"');
    expect(out.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(out.match(/role="radio"/g)).toHaveLength(3);
  });

  it('puts only the selected segment in the tab order (roving tabindex)', () => {
    expect(out.match(/tabindex="0"/g)).toHaveLength(1);
    expect(out.match(/tabindex="-1"/g)).toHaveLength(2);
  });

  it('draws the status dot', () => {
    expect(out).toContain('wr-dot--warn');
  });

  it('stays reachable by keyboard when the value is disabled or unknown', () => {
    const disabledValue = html(h(SegmentedControl<'off' | 'watch' | 'enforce'>, {
      label: 'Mode', value: 'enforce', onChange: noop,
      options: [{ value: 'off', label: 'Off' }, { value: 'watch', label: 'Watch only' }, { value: 'enforce', label: 'Enforce', disabled: true }],
    }));
    expect(disabledValue.match(/tabindex="0"/g)).toHaveLength(1);
    expect(disabledValue).toMatch(/tabindex="0"[^>]*>Off/);
  });
});

describe('StatusPill', () => {
  it.each([
    ['working', 'Working'], ['resting', 'Resting'], ['idle', 'Idle'], ['paused', 'Paused'], ['stopped', 'Stopped'],
    ['stopping', 'Stopping…'], ['pausing', 'Pausing…'], ['resuming', 'Resuming…'],
  ] as const)('%s shows its word, an icon and a title', (state, word) => {
    const out = html(h(StatusPill, { state }));
    expect(out).toContain(word);
    expect(out).toContain('<svg');
    expect(out).toMatch(/title="[^"]+"/);
  });

  it('only Paused gets the warn fill', () => {
    expect(html(h(StatusPill, { state: 'paused' }))).toContain('wr-pill--warn');
    expect(html(h(StatusPill, { state: 'stopped' }))).not.toContain('wr-pill--warn');
  });
});

describe('Banner', () => {
  it('is an alert only for errors', () => {
    expect(html(h(Banner, { variant: 'error', children: 'Couldn’t stop lead-agent.' }))).toContain('role="alert"');
    expect(html(h(Banner, { variant: 'warn', children: 'x' }))).not.toContain('role="alert"');
  });
});

describe('Toggle', () => {
  it('is a named switch that reports its state', () => {
    const out = html(h(Toggle, { checked: true, onChange: noop, label: 'Email alerts' }));
    expect(out).toContain('role="switch"');
    expect(out).toContain('aria-checked="true"');
    expect(out).toContain('aria-label="Email alerts"');
  });
});

describe('Hint', () => {
  it('is focusable and names itself with the text, closed by default', () => {
    const out = html(h(Hint, { text: 'Money not spent.' }));
    expect(out).toContain('tabindex="0"');
    expect(out).toContain('aria-label="What is this? Money not spent."');
    expect(out).not.toContain('role="tooltip"');
  });
});

describe('DataTable', () => {
  type Row = { id: string; agent: string; spend: string };
  const rows: Row[] = [{ id: '14', agent: 'lead-agent', spend: '$1.92' }, { id: '9', agent: 'scout-agent', spend: '$0.12' }];
  const columns = [
    { key: 'agent', header: 'Agent', width: '1fr', render: (r: Row) => r.agent },
    { key: 'spend', header: 'Spend', width: '64px', align: 'right' as const, numeric: true, render: (r: Row) => r.spend },
  ];

  it('makes rows focusable targets only when they open something', () => {
    const linked = html(h(DataTable<Row>, { caption: 'Runs', columns, rows, rowKey: (r) => r.id, onOpen: noop, selectedKey: '14' }));
    expect(linked.match(/role="row" tabindex="0"/g)).toHaveLength(2);
    expect(linked).toContain('is-selected');
    const plain = html(h(DataTable<Row>, { caption: 'Runs', columns, rows, rowKey: (r) => r.id }));
    expect(plain).not.toContain('tabindex');
  });

  it('uses grid semantics (where aria-selected is valid) only when rows open', () => {
    const linked = html(h(DataTable<Row>, { caption: 'Runs', columns, rows, rowKey: (r) => r.id, onOpen: noop, selectedKey: '14' }));
    expect(linked).toContain('role="grid"');
    expect(linked).toContain('role="gridcell"');
    expect(linked).toContain('aria-selected="true"');
    const plain = html(h(DataTable<Row>, { caption: 'Runs', columns, rows, rowKey: (r) => r.id, selectedKey: '14' }));
    expect(plain).toContain('role="table"');
    expect(plain).not.toContain('aria-selected');
  });

  it('right-aligns and tabulates numeric columns', () => {
    const out = html(h(DataTable<Row>, { caption: 'Runs', columns, rows, rowKey: (r) => r.id }));
    expect(out).toContain('class="is-right is-num"');
    expect(out).toContain('aria-label="Runs"');
  });

  it('shows the empty state inside a row', () => {
    const out = html(h(DataTable<Row>, { caption: 'Runs', columns, rows: [], rowKey: (r) => r.id, empty: 'No runs yet.' }));
    expect(out).toMatch(/role="row"[^>]*><span role="cell" aria-colspan="2">No runs yet\.<\/span>/);
  });
});

describe('Panel, Tag, SelectChip', () => {
  it('shows a count even without a title', () => {
    expect(html(h(Panel, { count: '4' }, 'x'))).toContain('wr-panel__count');
  });

  it('renders the panel header slots', () => {
    const out = html(h(Panel, { title: 'Runs', count: '6 today', actions: h('span', null, 'x') }, 'body'));
    expect(out).toContain('wr-panel__title');
    expect(out).toContain('6 today');
    expect(out).toContain('wr-panel__actions');
  });

  it('renders a tag in its tone', () => {
    expect(html(h(Tag, { tone: 'ho', children: 'Handover' }))).toContain('wr-tag--ho');
  });

  it('uses a real, named select', () => {
    const out = html(h(SelectChip<string>, { label: 'Agent', value: 'all', onChange: noop, options: [{ value: 'all', label: 'All agents' }] }));
    expect(out).toContain('<select aria-label="Agent"');
  });
});
