import type { CompressionItem, CompressionPreview } from '@/lib/whiteroom/client';

/** What each change does, from the reader's side (spec §14.3: what, not how). */
export const ITEM_COPY: Array<{ id: CompressionItem; title: string; text: string }> = [
  { id: 'C1', title: 'Cache more of each request', text: 'More of each request reads from your provider’s prompt cache, on every Claude route.' },
  { id: 'C2', title: 'Send notes the same way every time', text: 'A resent handover reads from the cache instead of being paid for again.' },
  { id: 'C3', title: 'Leave out old tool output in long shifts', text: 'The oldest tool output is replaced with a short note. Recent turns are never touched.' },
  { id: 'Q1', title: 'Keep values past the cut-off', text: 'Exact values in very long messages are kept, even where the message is cut.' },
  { id: 'Q2', title: 'Check notes against the shift', text: 'Adds values the notes dropped and flags values the shift never said. Nothing is replaced.' },
  { id: 'Q3', title: 'Keep the rules agents were given', text: 'Rules from you and your system prompt carry over. Rules found only in tool output are marked untrusted.' },
  { id: 'Q4', title: 'Carry values from earlier notes', text: 'Unless this shift gave a newer value for the same thing.' },
  { id: 'G4', title: 'Keep the goal in force', text: 'The goal you or the agent set, never an old one.' },
];

/**
 * One line per change: how often it would have applied while previewed.
 * A change that's live isn't counted, so it says so instead of showing a
 * number from before it went live.
 */
export function itemLine(p: CompressionPreview, id: CompressionItem): string {
  if (p.compression_mode === 'on' && p.cleared.includes(id)) return 'Applies now. Counts are kept only while a change is previewed.';
  const c = p.items[id] ?? { observed: 0, wouldChange: 0 };
  if (p.compression_mode === 'off' && !c.observed) return 'Not measured. Turn on Preview to see how often this would apply.';
  if (!c.observed) return 'Not measured yet.';
  const n = (x: number) => x.toLocaleString('en-US');
  return `Would have applied ${n(c.wouldChange)} of ${n(c.observed)} times in the last ${p.days} days`;
}

/** The mode's one-line description. */
export function modeText(p: Pick<CompressionPreview, 'compression_mode' | 'cleared'>): string {
  if (p.compression_mode === 'off') return 'Nothing changes and nothing is counted.';
  if (p.compression_mode === 'dry_run') return 'Nothing changes. WhiteRoom counts how often each change below would have applied.';
  if (!p.cleared.length) return 'None of the changes has passed testing yet, so On works like Preview for now.';
  const titles = ITEM_COPY.filter((i) => p.cleared.includes(i.id)).map((i) => i.title.toLowerCase());
  return `Applies the changes that have passed testing: ${titles.join(', ')}. The rest are counted, as in Preview.`;
}
