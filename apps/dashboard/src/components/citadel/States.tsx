// Shared states (README › Screens › 11), so every page says the same thing
// the same way.

import { Icon } from '@whiteroom/ui';

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
}

/**
 * A refresh failed but the last good data is still on screen. Never blanks
 * the page; says when that data is from when it knows.
 */
export function RefreshFailed({ since }: { since?: number | null }) {
  return (
    <p role="status" className="wr-refresh-failed">
      <span style={{ color: 'var(--warn)', display: 'flex' }}><Icon name="alertCircle" size={13} /></span>
      Couldn&rsquo;t refresh. Retrying&hellip; Showing {since ? `the data from ${clockTime(since)}` : 'the last data we had'}.
    </p>
  );
}

/** A muted "Loading…" line inside a panel, before anything has arrived. */
export function LoadingLine({ children = 'Loading…', padded = true }: { children?: React.ReactNode; padded?: boolean }) {
  return <p aria-busy="true" style={{ margin: 0, padding: padded ? '14px 18px' : 0, fontSize: 13, color: 'var(--tx2)' }}>{children}</p>;
}
