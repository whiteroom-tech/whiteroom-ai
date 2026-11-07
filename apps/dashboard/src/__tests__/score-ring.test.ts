// @whiteroom/ui ScoreRing: one ring, clamped to 0–10, green from 9 up.
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScoreRing } from '@whiteroom/ui';

const ring = (score: number) => renderToStaticMarkup(h(ScoreRing, { score, size: 40 }));

describe('ScoreRing', () => {
  it('labels whole scores plainly and others to one place', () => {
    expect(ring(8)).toContain('aria-label="Score 8 out of 10"');
    expect(ring(7.85)).toContain('aria-label="Score 7.9 out of 10"');
  });

  it('clamps out-of-range scores and never draws NaN', () => {
    expect(ring(14)).toContain('aria-label="Score 10 out of 10"');
    expect(ring(-3)).toContain('aria-label="Score 0 out of 10"');
    expect(ring(Number.NaN)).toContain('aria-label="Score 0 out of 10"');
    expect(ring(Number.NaN)).not.toContain('NaN');
  });

  it('is brand below 9 and green from 9', () => {
    expect(ring(8.9)).toContain('stroke="var(--brand)"');
    expect(ring(9)).toContain('stroke="var(--ok)"');
  });
});

describe('ScoreRing beside its own words', () => {
  it('is hidden from screen readers when decorative', () => {
    const html = renderToStaticMarkup(h(ScoreRing, { score: 8, decorative: true }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('aria-label');
  });
});

describe('ScoreRing rounding', () => {
  it('colours by the number it shows: 8.96 reads 9 and is green, 8.94 reads 8.9 and is not', () => {
    const up = renderToStaticMarkup(h(ScoreRing, { score: 8.96 }));
    expect(up).toContain('aria-label="Score 9 out of 10"');
    expect(up).toContain('stroke="var(--ok)"');
    const down = renderToStaticMarkup(h(ScoreRing, { score: 8.94 }));
    expect(down).toContain('aria-label="Score 8.9 out of 10"');
    expect(down).toContain('stroke="var(--brand)"');
  });
});
