import { describe, it, expect } from 'vitest';
import { ITEM_COPY, itemLine, modeText, shownItems } from '@/lib/smaller-handovers';
import type { CompressionPreview } from '@/lib/whiteroom/client';

const p = (o: Partial<CompressionPreview> = {}): CompressionPreview => ({
  compression_mode: 'dry_run', days: 14, cleared: [],
  items: { C1: { observed: 340, wouldChange: 12 }, C2: { observed: 0, wouldChange: 0 } }, ...o,
});

describe('smaller handovers', () => {
  it('describes each change in plain words', () => {
    for (const i of ITEM_COPY) expect(`${i.title} ${i.text}`).not.toMatch(/\b(?:C\d|Q\d|G4|dry_run)\b/);
  });

  it('lists only the changes the engine reports', () => {
    expect(shownItems(p()).map((i) => i.id)).toEqual(['C1', 'C2']);
    expect(shownItems(p({ items: { C2: { observed: 1, wouldChange: 0 } } })).map((i) => i.id)).toEqual(['C2']);
    // A change this dashboard has no words for yet stays off the list.
    const later = { ...p().items, C3: { observed: 5, wouldChange: 1 } } as CompressionPreview['items'];
    expect(shownItems(p({ items: later })).map((i) => i.id)).toEqual(['C1', 'C2']);
  });

  it('says how often a change would have applied, or that it does', () => {
    expect(itemLine(p(), 'C1')).toBe('Would have applied 12 of 340 times in the last 14 days');
    expect(itemLine(p({ compression_mode: 'on', cleared: ['C1'] }), 'C1')).toBe('Applies now. Counts are kept only while a change is previewed.');
    expect(itemLine(p({ compression_mode: 'on', cleared: ['C2'] }), 'C1')).toBe('Would have applied 12 of 340 times in the last 14 days');
    expect(itemLine(p(), 'C2')).toBe('Not measured yet.');
    expect(itemLine(p({ compression_mode: 'off' }), 'C2')).toMatch(/Turn on Preview/);
  });

  it('On names what applies, and works like Preview until something does', () => {
    expect(modeText(p({ compression_mode: 'on' }))).toMatch(/works like Preview/);
    expect(modeText(p({ compression_mode: 'on', cleared: ['C1'] }))).toBe('Applies the changes that have passed testing: cache more of each request. The rest are counted, as in Preview.');
    expect(modeText(p({ compression_mode: 'on', cleared: ['C1', 'C2'] }))).toBe('Applies the changes that have passed testing: cache more of each request, send notes the same way every time.');
  });
});
