export type TagTone = 'ho' | 'warn' | 'brand' | 'muted';

/** Event and rule tags: mono 10.5, 1px border and text in the tone, no fill. */
export function Tag({ tone = 'muted', children }: { tone?: TagTone; children: React.ReactNode }) {
  return <span className={`wr-tag wr-tag--${tone}`}>{children}</span>;
}
