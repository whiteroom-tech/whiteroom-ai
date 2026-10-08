import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoadFailed, LoadingLine, RefreshFailed } from '@/components/citadel/States';

// README › Screens › 11: a failed refresh keeps the data and says how old it is.
describe('shared states', () => {
  it('says a refresh failed, is announced, and names when the shown data is from', () => {
    const at = new Date(2026, 9, 1, 14, 15).getTime();
    const html = renderToStaticMarkup(h(RefreshFailed, { since: at }));
    expect(html).toContain('role="status"');
    expect(html).toContain('Couldn’t refresh. Retrying… Showing the data from 2:15 pm.');
    expect(renderToStaticMarkup(h(RefreshFailed))).toContain('Showing the last data we had.');
  });

  it('says a panel didn’t load, as an alert, with Try again', () => {
    const html = renderToStaticMarkup(h(LoadFailed, { what: 'handover quality', onRetry: () => {} }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('Couldn’t load handover quality.');
    expect(html).toContain('Try again');
    expect(renderToStaticMarkup(h(LoadFailed, { what: 'x', onRetry: () => {}, busy: true }))).toContain('Loading…');
  });

  it('marks loading as busy', () => {
    expect(renderToStaticMarkup(h(LoadingLine))).toContain('aria-busy="true"');
  });
});
