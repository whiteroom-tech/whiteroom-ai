import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopyChip, CopyValueButton } from '@/components/citadel/CopyChip';

describe('copy controls', () => {
  it('name what they copy for screen readers', () => {
    expect(renderToStaticMarkup(h(CopyChip, { text: 'export X=1', label: 'Copy the Anthropic setup line' }))).toContain('aria-label="Copy the Anthropic setup line"');
    expect(renderToStaticMarkup(h(CopyChip, { text: 'export X=1\nmore' }))).toContain('aria-label="Copy export X=1"');
    const btn = renderToStaticMarkup(h(CopyValueButton, { text: 'secret', what: 'your API key' }));
    expect(btn).toContain('Copy<span class="sr-only"> your API key</span>');
    expect(btn).not.toContain('aria-label');
  });

  it('can be held back until the value is revealed', () => {
    expect(renderToStaticMarkup(h(CopyValueButton, { text: 'secret', what: 'your API key', disabled: true }))).toContain('disabled');
  });
});
