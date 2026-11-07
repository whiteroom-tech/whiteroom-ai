export type TagTone = 'ho' | 'warn' | 'brand' | 'muted' | 'block';

/** Event and rule tags: mono, 1px border and text in the tone; no fill except `block` (a rule that really stops calls). */
export function Tag({ tone = 'muted', children }: { tone?: TagTone; children: React.ReactNode }) {
  return <span className={`wr-tag wr-tag--${tone}`}>{children}</span>;
}
