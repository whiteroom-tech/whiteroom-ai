// Shared states (README › Screens › 11), so every page says the same thing
// the same way.

import { Button, Icon } from '@whiteroom/ui';

function clockTime(ms: number): string {
  // Some ICU versions put a narrow no-break space before am/pm.
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ').toLowerCase();
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

/** A panel's data didn't load (network, server error): says so, with Try again, instead of the panel vanishing. */
export function LoadFailed({ what, onRetry, busy }: { what: string; onRetry: () => void; busy?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <p role="alert" style={{ margin: 0, fontSize: 12.5, color: 'var(--bad)', flex: '1 1 220px' }}>Couldn&rsquo;t load {what}.</p>
      <Button size={28} busy={busy} busyLabel="Loading…" aria-label={`Try loading ${what} again`} onClick={onRetry}>Try again</Button>
    </div>
  );
}
