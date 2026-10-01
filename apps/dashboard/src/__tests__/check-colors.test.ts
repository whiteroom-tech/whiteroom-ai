import { describe, expect, it } from 'vitest';
import { canUpdate, compare, findColors } from '../../scripts/color-check-lib.mjs';

describe('findColors', () => {
  it('finds hex and color functions', () => {
    expect(findColors("style={{ color: '#38E1FF', background: 'rgba(0,0,0,.4)' }}")).toEqual(['#38E1FF', 'rgba(']);
    expect(findColors('fill="#fff"')).toEqual(['#fff']);
  });

  it('ignores HTML entities and in-page anchors', () => {
    expect(findColors('Next &#8594;')).toEqual([]);
    expect(findColors('<a href="#add">Add</a>')).toEqual([]);
    expect(findColors("<Link to='#face'>")).toEqual([]);
  });

  it('ignores CSS id selectors but not colors in declarations', () => {
    expect(findColors('#bad, #fee { color: var(--tx); }', { css: true })).toEqual([]);
    expect(findColors('.a { color: #fee; border: 1px solid #decade; }', { css: true })).toEqual(['#fee', '#decade']);
  });

  it('skips a line only when the opt-out marker has a reason', () => {
    expect(findColors('fill="#4285F4" // color-literal-ok: Google brand colors')).toEqual([]);
    expect(findColors('fill="#4285F4" // color-literal-ok')).toEqual(['#4285F4']);
    expect(findColors('fill="#4285F4" // color-literal-ok:   ')).toEqual(['#4285F4']);
  });
});

describe('the baseline ratchet', () => {
  it('bootstraps only when there is no baseline file', () => {
    expect(canUpdate(null, { 'a.tsx': 5 }).ok).toBe(true);
  });

  it('treats an empty baseline as "every file stays at zero"', () => {
    expect(canUpdate({}, { 'a.tsx': 1 })).toEqual({ ok: false, grew: [['a.tsx', 1]] });
    expect(canUpdate({}, {}).ok).toBe(true);
  });

  it('only lets counts go down', () => {
    expect(canUpdate({ 'a.tsx': 3 }, { 'a.tsx': 2 }).ok).toBe(true);
    expect(canUpdate({ 'a.tsx': 3 }, { 'a.tsx': 4, 'b.tsx': 0 }).grew).toEqual([['a.tsx', 4]]);
  });

  it('reports files over and under the baseline', () => {
    expect(compare({ 'a.tsx': 2, 'b.tsx': 1 }, { 'a.tsx': 3, 'c.tsx': 1 })).toEqual({ over: ['a.tsx', 'c.tsx'], lowered: ['b.tsx'] });
  });
});
