'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Banner, Button } from '@whiteroom/ui';
import { cancelAccountDeletion, getAccountClosing } from '@/lib/account';
import { viewerZone } from '@/lib/zone-time';
import {
  blockedMessage,
  closingDate,
  daysLeft,
  isClosingOpen,
  SUPPORT_EMAIL,
  type Closing,
} from '@/lib/closing-shared';
import { AUDIT_KEPT } from '@/lib/plans';
import { ROUTES } from '@/lib/routes';
import { plural } from '@/lib/format';

/** Fired after a deletion starts or is cancelled, so every banner on the page re-reads. */
export const CLOSING_CHANGED = 'wr:account-closing-changed';

/**
 * The banner's words for a closing window. Dates and days left are counted
 * in `timeZone` (the viewer's), so "November 10" and "in 3 days" agree.
 */
export function closingMessage(c: Closing, now = Date.now(), timeZone?: string): string {
  const left = daysLeft(c.closesAt, now, timeZone);
  const date = closingDate(c.closesAt, timeZone);
  const until = `${date}${left === 0 ? ' (today)' : `, in ${left} ${plural(left, 'day')}`}`;
  const keyStops = 'After that, your WhiteRoom fleet key stops working.';
  if (c.reason === 'deleted') {
    const removed = c.deleteAfter && c.deleteAfter !== c.closesAt ? c.deleteAfter : null;
    if (isClosingOpen(c, now)) {
      return removed
        ? `Your account will be deleted. Your fleet keeps working until ${until}. ${keyStops} Your account is removed on ${closingDate(removed, timeZone)}.`
        : `Your account will be deleted on ${until}. Your fleet keeps working until then. ${keyStops}`;
    }
    if (c.blocked) return blockedMessage(c.blocked.reason);
    return removed && new Date(removed).getTime() > now
      ? `Your fleet is closed. Your account is removed on ${closingDate(removed, timeZone)}.`
      : 'Your account is being deleted.';
  }
  return isClosingOpen(c, now)
    ? `Your plan has ended. Your fleet keeps working until ${until}. ${keyStops}`
    : `Your fleet closed on ${date}. Its audit trail is kept for ${AUDIT_KEPT}.`;
}

/** How long a read of the closing state is reused across pages: it changes rarely, and a change here re-reads at once. */
export const CLOSING_READ_TTL_MS = 60_000;
let lastRead: { at: number; value: Promise<Awaited<ReturnType<typeof getAccountClosing>>> } | null = null;

/** The account's closing state, shared by the pages opened within CLOSING_READ_TTL_MS. */
export function readClosing(fresh = false): ReturnType<typeof getAccountClosing> {
  if (!fresh && lastRead && Date.now() - lastRead.at < CLOSING_READ_TTL_MS) return lastRead.value;
  const value = getAccountClosing();
  lastRead = { at: Date.now(), value };
  // A failed or unknown read isn't kept, so the next page tries again.
  value.then((v) => { if (v === 'unknown' && lastRead?.value === value) lastRead = null; }, () => { if (lastRead?.value === value) lastRead = null; });
  return value;
}

/** Test hook: forget the shared read. */
export function _forgetClosingRead(): void {
  lastRead = null;
}

const linkClass = 'wr-btn wr-btn--secondary wr-btn--h28';

/** The fix a blocked deletion needs, as a link: Manage billing, or the organization. */
export function BlockedFix({ kind }: { kind: 'subscription' | 'organization' }) {
  return kind === 'subscription'
    ? <Link href={`${ROUTES.settings}#plan`} className={linkClass}>Manage billing</Link>
    : <Link href={ROUTES.organization} className={linkClass}>Open organization</Link>;
}

/** The way back to the full export, while the account can still download it. */
function ExportLink() {
  return <Link href={`${ROUTES.settings}#audit-integrity`} className={linkClass}>Download export</Link>;
}

/** A mailto link to support, for what only support can resolve. */
export function SupportLink() {
  return <a href={`mailto:${SUPPORT_EMAIL}`} className={linkClass}>Contact support</a>;
}

/**
 * Every signed-in page, while the account is closing (deleted, or plan
 * lapsed): when, a way to the export, and Cancel deletion or Choose a plan.
 * A deletion that ended but can't finish (blocked) says why, with the fix
 * and Keep my account. A closed fleet offers the export and support.
 * Renders nothing otherwise. A state that couldn't be read keeps what was
 * already shown rather than clearing it.
 */
export function AccountClosingBanner() {
  const [closing, setClosing] = useState<Closing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The viewer's zone, read after mount so server and browser render alike.
  const [timeZone, setTimeZone] = useState<string | undefined>('UTC');
  useEffect(() => { setTimeZone(viewerZone()); }, []);

  const load = useCallback((fresh: boolean) => {
    readClosing(fresh).then(
      (state) => { if (state !== 'unknown') setClosing(state); },
      () => {},
    );
  }, []);

  useEffect(() => {
    load(false);
    // A change on this page (delete, cancel, keep): read it again at once.
    const changed = () => load(true);
    window.addEventListener(CLOSING_CHANGED, changed);
    return () => window.removeEventListener(CLOSING_CHANGED, changed);
  }, [load]);

  if (!closing) return null;
  const open = isClosingOpen(closing);

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

  let actions: React.ReactNode;
  if (open) {
    actions = (
      <>
        <ExportLink />
        {closing.reason === 'deleted'
          ? <Button size={28} busy={busy} busyLabel="Cancelling…" onClick={() => void cancel()}>Cancel deletion</Button>
          : <Link href={`${ROUTES.settings}#plan`} className={linkClass}>Choose a plan</Link>}
      </>
    );
  } else if (closing.blocked) {
    actions = (
      <>
        <BlockedFix kind={closing.blocked.kind} />
        <Button size={28} busy={busy} busyLabel="Keeping…" onClick={() => void cancel()}>Keep my account</Button>
      </>
    );
  } else if (closing.reason === 'deleted' && closing.deleteAfter && new Date(closing.deleteAfter).getTime() > Date.now()) {
    actions = (
      <>
        <ExportLink />
        <Button size={28} busy={busy} busyLabel="Keeping…" onClick={() => void cancel()}>Keep my account</Button>
      </>
    );
  } else if (closing.reason === 'lapsed') {
    actions = (
      <>
        <ExportLink />
        <SupportLink />
      </>
    );
  }

  return (
    <div style={{ padding: '12px 16px 0' }} data-testid="account-closing-banner">
      <Banner variant="warn" actions={actions}>
        {closingMessage(closing, Date.now(), timeZone)}
        {error && <span role="alert" style={{ display: 'block', color: 'var(--bad)', marginTop: 4 }}>{error}</span>}
      </Banner>
    </div>
  );
}
