'use client';

import { useEffect } from 'react';
import { BrandLink, Button } from '@whiteroom/ui';

/**
 * A page that failed to load or draw: say so, and offer another try.
 * Next 16.4 passes `retry` (refetch the page) next to the older `reset`
 * (redraw what failed); Retry uses `retry` and falls back to `reset`, which
 * every version passes.
 */
export default function PageError({ error, reset, retry }: { error: unknown; reset: () => void; retry?: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main className="wr-shell wr-stop">
      <BrandLink />
      <h1 className="wr-stop__title">Something went wrong</h1>
      <p className="wr-stop__text">This page didn’t load. Your agents aren’t affected.</p>
      <Button variant="primary" onClick={() => (retry ?? reset)()}>Retry</Button>
    </main>
  );
}
