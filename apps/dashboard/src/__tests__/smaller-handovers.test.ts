import { describe, it, expect } from 'vitest';
import { ITEM_COPY, itemLine, modeText } from '@/lib/smaller-handovers';
import type { CompressionPreview } from '@/lib/whiteroom/client';

const zero = { observed: 0, wouldChange: 0 };
const p = (o: Partial<CompressionPreview> = {}): CompressionPreview => ({
  compression_mode: 'dry_run', days: 14, cleared: [],
  items: { C1: { observed: 340, wouldChange: 12 }, C2: zero, C3: zero, Q1: zero, Q2: zero, Q3: zero, Q4: zero, G4: zero }, ...o,
});

describe('smaller handovers copy', () => {
  it('covers every change, in plain words', () => {
    expect(ITEM_COPY.map((i) => i.id)).toEqual(['C1', 'C2', 'C3', 'Q1', 'Q2', 'Q3', 'Q4', 'G4']);
    for (const i of ITEM_COPY) expect(`${i.title} ${i.text}`).not.toMatch(/\b(?:C\d|Q\d|G4|dry_run|hysteresis|atom)\b/);
  });

  it('says how often a change would have applied, or that it does', () => {
    expect(itemLine(p(), 'C1')).toBe('Would have applied 12 of 340 times in the last 14 days');
    expect(itemLine(p({ compression_mode: 'on', cleared: ['C1'] }), 'C1')).toBe('Applies now. Counts are kept only while a change is previewed.');
    expect(itemLine(p({ compression_mode: 'on', cleared: ['C2'] }), 'C1')).toBe('Would have applied 12 of 340 times in the last 14 days');
    expect(itemLine(p(), 'C2')).toBe('Not measured yet.');
    expect(itemLine(p({ compression_mode: 'off' }), 'C2')).toMatch(/Turn on Preview/);
  });

  it('On without anything cleared says it works like Preview', () => {
    expect(modeText(p({ compression_mode: 'on' }))).toMatch(/works like Preview/);
    expect(modeText(p({ compression_mode: 'on', cleared: ['C1', 'C2'] }))).toBe('Applies the changes that have passed testing: cache more of each request, send notes the same way every time. The rest are counted, as in Preview.');
  });
});
