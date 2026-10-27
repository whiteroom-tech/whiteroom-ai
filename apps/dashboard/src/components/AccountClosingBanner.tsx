'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Banner, Button } from '@whiteroom/ui';
import { cancelAccountDeletion, getAccountClosing } from '@/lib/account';
import { closingDate as day, type Closing } from '@/lib/closing-shared';
import { ROUTES } from '@/lib/routes';

/** Fired after a deletion starts or is cancelled, so every banner on the page re-reads. */
export const CLOSING_CHANGED = 'wr:account-closing-changed';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days left, counting a part day as a day; 0 once the time has passed. */
export function daysLeft(closesAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(closesAt).getTime() - now) / DAY_MS));
}

/** The banner's words for a closing window. */
export function closingMessage(c: Closing, now = Date.now()): string {
  const left = daysLeft(c.closesAt, now);
  const when = `${day(c.closesAt)}, in ${left} day${left === 1 ? '' : 's'}`;
  if (c.reason === 'deleted') {
    return left > 0
      ? `Your account will be deleted on ${when}. Your fleet keeps working until then.`
      : 'Your account is being deleted.';
  }
  return left > 0
    ? `Your plan has ended. Your fleet keeps working until ${when}. Then it closes and your WhiteRoom fleet key stops working.`
    : `Your fleet closed on ${day(c.closesAt)}. Its audit trail is kept for 12 months.`;
}

const linkClass = 'wr-btn wr-btn--secondary wr-btn--h28';

/**
 * Every signed-in page, while the account is closing (deleted, or plan
 * lapsed): days left, a way to the export, and Cancel deletion or Choose a
 * plan. Renders nothing otherwise.
 */
export function AccountClosingBanner() {
  const [closing, setClosing] = useState<Closing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    getAccountClosing().then(setClosing, () => setClosing(null));
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(CLOSING_CHANGED, load);
    return () => window.removeEventListener(CLOSING_CHANGED, load);
  }, [load]);

  if (!closing) return null;
  const open = daysLeft(closing.closesAt) > 0;

  async function cancel() {
    setBusy(true);
    setError('');
    try {
      const res = await cancelAccountDeletion();
      if (res.ok) window.dispatchEvent(new Event(CLOSING_CHANGED));
      else setError(res.error);
    } catch {
      setError('Could not cancel the deletion. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const actions = open ? (
    <>
      <Link href={`${ROUTES.settings}#audit-integrity`} className={linkClass} style={{ textDecoration: 'none' }}>Download export</Link>
      {closing.reason === 'deleted'
        ? <Button size={28} busy={busy} busyLabel="Cancelling…" onClick={() => void cancel()}>Cancel deletion</Button>
        : <Link href={`${ROUTES.settings}#plan`} className={linkClass} style={{ textDecoration: 'none' }}>Choose a plan</Link>}
    </>
  ) : undefined;

  return (
    <div style={{ padding: '12px 16px 0' }} data-testid="account-closing-banner">
      <Banner variant="warn" actions={actions}>
        {closingMessage(closing)}
        {error && <span role="alert" style={{ display: 'block', color: 'var(--bad)', marginTop: 4 }}>{error}</span>}
      </Banner>
    </div>
  );
}
