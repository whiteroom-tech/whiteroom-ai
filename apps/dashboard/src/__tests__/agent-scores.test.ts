// Performance's By-agent wheel (audit M12): tier colors, wedge breakdown,
// and the ring segments they render as.
import { describe, it, expect } from 'vitest';
import { scoreColor, scoreWedges, tierColor, wedgeStroke, wedgeSummary, wheelArcs } from '../lib/agent-scores';

describe('tierColor', () => {
  it('reads null as unknown, not bad', () => {
    expect(tierColor(null, 100)).toBe('var(--tx3)');
  });

  it('is red at or below 30% of max, amber below 70%, green at or above', () => {
    expect(tierColor(0, 100)).toBe('var(--bad)');
    expect(tierColor(30, 100)).toBe('var(--bad)');
    expect(tierColor(31, 100)).toBe('var(--warn)');
    expect(tierColor(69, 100)).toBe('var(--warn)');
    expect(tierColor(70, 100)).toBe('var(--ok)');
    expect(tierColor(100, 100)).toBe('var(--ok)');
  });

  it('scales to whatever max is given, for the 0-10 overall score', () => {
    expect(scoreColor(3)).toBe('var(--bad)');
    expect(scoreColor(5)).toBe('var(--warn)');
    expect(scoreColor(9)).toBe('var(--ok)');
    expect(scoreColor(null)).toBe('var(--tx3)');
  });
});

describe('scoreWedges', () => {
  it('names the three categories in a fixed order, each colored by its own value', () => {
    const wedges = scoreWedges({ completeRate: 50, costDiligence: null, speedScore: 100 });
    expect(wedges.map((w) => w.label)).toEqual(['Clean calls', 'Cost', 'Speed']);
    expect(wedges.map((w) => w.short)).toEqual(['Clean', 'Cost', 'Speed']);
    expect(wedges[0]).toMatchObject({ value: 50, color: 'var(--warn)' });
    expect(wedges[1]).toMatchObject({ value: null, color: 'var(--tx3)' });
    expect(wedges[2]).toMatchObject({ value: 100, color: 'var(--ok)' });
  });
});

describe('wheelArcs', () => {
  // 32px ring, 4px stroke: radius 14 around (16, 16).
  it('splits the ring into equal arcs, clockwise from 12 o\u2019clock, that meet with no gap', () => {
    expect(wheelArcs(3, 32, 4, 0)).toEqual([
      'M 16 2 A 14 14 0 0 1 28.12 23',
      'M 28.12 23 A 14 14 0 0 1 3.88 23',
      'M 3.88 23 A 14 14 0 0 1 16 2',
    ]);
  });

  it('leaves half the gap at each end of every arc', () => {
    // 26° gap: arcs run 13°–107°, 133°–227°, 253°–347°.
    expect(wheelArcs(3, 32, 4, 26)).toEqual([
      'M 19.15 2.36 A 14 14 0 0 1 29.39 20.09',
      'M 26.24 25.55 A 14 14 0 0 1 5.76 25.55',
      'M 2.61 20.09 A 14 14 0 0 1 12.85 2.36',
    ]);
  });

  it('sets the large-arc flag only for arcs over 180°', () => {
    expect(wheelArcs(1, 32, 4, 90)[0]).toContain(' 0 1 1 ');
    expect(wheelArcs(4, 32, 4, 0)[0]).toContain(' 0 0 1 ');
  });
});

describe('wedgeStroke', () => {
  it('uses the tier color, or the faint track when there is no data', () => {
    expect(wedgeStroke({ value: 80, color: 'var(--ok)' })).toBe('var(--ok)');
    expect(wedgeStroke({ value: null, color: 'var(--tx3)' })).toBe('var(--track)');
  });
});

describe('wedgeSummary', () => {
  it('names each wedge and its value, or says when one has no data', () => {
    const summary = wedgeSummary([
      { label: 'Clean calls', value: 75 },
      { label: 'Cost', value: null },
    ]);
    expect(summary).toBe('Clean calls: 75/100 · Cost: no data');
  });
});
