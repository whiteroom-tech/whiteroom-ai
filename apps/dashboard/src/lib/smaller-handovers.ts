import type { CompressionItem, CompressionPreview } from '@/lib/whiteroom/client';

/** What each change does, from the reader's side (spec §14.3: what, not how). */
export const ITEM_COPY: Array<{ id: CompressionItem; title: string; text: string }> = [
  { id: 'C1', title: 'Cache more of each request', text: 'More of each request reads from your provider’s prompt cache, on every Claude route.' },
  { id: 'C2', title: 'Send notes the same way every time', text: 'Repeated text is read from the cache instead of being paid for again.' },
];

/** The changes to list: those this engine reports. */
export const shownItems = (p: CompressionPreview) => ITEM_COPY.filter((i) => p.items[i.id]);

/**
 * One line per change: how often it would have applied while previewed.
 * A live change isn't counted, so it says so instead of showing a number
 * from before it went live.
 */
export function itemLine(p: CompressionPreview, id: CompressionItem): string {
  if (p.compression_mode === 'on' && p.cleared.includes(id)) return 'Applies now. Counts are kept only while a change is previewed.';
  const c = p.items[id];
  if (!c?.observed) return p.compression_mode === 'off' ? 'Not measured. Turn on Preview to see how often this would apply.' : 'Not measured yet.';
  const n = (x: number) => x.toLocaleString('en-US');
  return `Would have applied ${n(c.wouldChange)} of ${n(c.observed)} times in the last ${p.days} days`;
}

/** The mode's one-line description. */
export function modeText(p: CompressionPreview): string {
  if (p.compression_mode === 'off') return 'Nothing changes and nothing is counted.';
  if (p.compression_mode === 'dry_run') return 'Nothing changes. WhiteRoom counts how often each change below would have applied.';
  const shown = shownItems(p);
  const live = shown.filter((i) => p.cleared.includes(i.id));
  if (!live.length) return 'None of the changes has passed testing yet, so On works like Preview for now.';
  const rest = live.length < shown.length ? ' The rest are counted, as in Preview.' : '';
  return `Applies the changes that have passed testing: ${live.map((i) => i.title.toLowerCase()).join(', ')}.${rest}`;
}
