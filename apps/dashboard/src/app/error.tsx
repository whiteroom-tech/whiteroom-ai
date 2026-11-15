'use client';

import { useEffect } from 'react';
import { BrandLink, Button } from '@whiteroom/ui';

/**
 * A page that failed to load or draw: say so, and offer another try.
 * Next 16.4 passes `{ error: unknown, reset, retry }` (ErrorInfo in
 * next/dist/client/components/error-boundary); `retry` refetches the page,
 * where `reset` would only redraw what failed.
 */
export default function PageError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main className="wr-shell wr-stop">
      <BrandLink />
      <h1 className="wr-stop__title">Something went wrong</h1>
      <p className="wr-stop__text">This page didn’t load. Your agents aren’t affected.</p>
      <Button variant="primary" onClick={() => retry()}>Retry</Button>
    </main>
  );
}
