// Performance › Recommendations status badge: an open recommendation is
// neutral (it's still to look at, not good news); resolved ones are green.
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge } from '@/app/(citadel)/performance/_components/primitives';

describe('recommendation status badge', () => {
  it('shows open in neutral colours, never the "good" green', () => {
    const open = renderToStaticMarkup(h(Badge, { status: 'open' }));
    expect(open).toContain('var(--tx2)');
    expect(open).toContain('var(--raised)');
    expect(open).not.toContain('var(--ok)');
    expect(open).toContain('>open<');
    expect(renderToStaticMarkup(h(Badge, { status: 'resolved' }))).toContain('var(--ok)');
  });
});
