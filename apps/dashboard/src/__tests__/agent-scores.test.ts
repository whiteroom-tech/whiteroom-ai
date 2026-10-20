// Performance's By-agent wheel (audit M12): tier colors, wedge breakdown,
// and the conic-gradient they render as.
import { describe, it, expect } from 'vitest';
import { scoreColor, scoreWedges, tierColor, wedgeSummary, wheelGradient } from '../lib/agent-scores';

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
    expect(wedges.map((w) => w.label)).toEqual(['Task success', 'Cost diligence', 'Speed']);
    expect(wedges[0]).toMatchObject({ value: 50, color: 'var(--warn)' });
    expect(wedges[1]).toMatchObject({ value: null, color: 'var(--tx3)' });
    expect(wedges[2]).toMatchObject({ value: 100, color: 'var(--ok)' });
  });
});

describe('wheelGradient', () => {
  it('splits the circle into equal wedges in order, with no gaps', () => {
    const gradient = wheelGradient([{ color: 'var(--bad)' }, { color: 'var(--warn)' }, { color: 'var(--ok)' }]);
    expect(gradient).toBe('conic-gradient(var(--bad) 0deg 120deg, var(--warn) 120deg 240deg, var(--ok) 240deg 360deg)');
  });
});

describe('wedgeSummary', () => {
  it('names each wedge and its value, or says when one has no data', () => {
    const summary = wedgeSummary([
      { label: 'Task success', value: 75 },
      { label: 'Cost diligence', value: null },
    ]);
    expect(summary).toBe('Task success: 75/100 · Cost diligence: no data');
  });
});
