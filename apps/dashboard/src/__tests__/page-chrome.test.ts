import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveStatus, SectionHeader } from '@/components/citadel/PageChrome';
import { fmtTime } from '@/lib/format';

const AT = Date.parse('2026-10-27T15:08:00Z');

describe('LiveStatus', () => {
  it('says Live with the time of the last update', () => {
    expect(renderToStaticMarkup(h(LiveStatus, { at: AT }))).toContain(`Live · updated ${fmtTime(AT)}`);
  });

  it('says Live alone before the first update', () => {
    const out = renderToStaticMarkup(h(LiveStatus, { at: null }));
    expect(out).toContain('Live');
    expect(out).not.toContain('updated');
  });

  it('says Retrying, with the last good time, while reads fail', () => {
    expect(renderToStaticMarkup(h(LiveStatus, { at: AT, failing: true }))).toContain(`Retrying · last updated ${fmtTime(AT)}`);
  });

  it('says it is waiting for the first call on a new fleet', () => {
    expect(renderToStaticMarkup(h(LiveStatus, { at: null, empty: true }))).toContain('Waiting for the first call');
  });
});

describe('SectionHeader', () => {
  it('shows the title, the sub-line and the note, and leaves out what is not given', () => {
    const full = renderToStaticMarkup(h(SectionHeader, { id: 's-cost', title: 'Cost', sub: 'What your agents spent.', meta: 'last 7 days' }));
    expect(full).toContain('<h2 id="s-cost" class="wr-section-head__title">Cost</h2>');
    expect(full).toContain('What your agents spent.');
    expect(full).toContain('last 7 days');
    const bare = renderToStaticMarkup(h(SectionHeader, { title: 'Cost' }));
    expect(bare).not.toContain('wr-section-head__sub');
    expect(bare).not.toContain('wr-section-head__meta');
  });
});
