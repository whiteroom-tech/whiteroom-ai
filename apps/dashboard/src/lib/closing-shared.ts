// What the closing window (account deleted or plan lapsed) shares between
// server and browser code. lib/account-closing.ts holds the server side.

/** Days between deleting the account (or the plan lapsing) and the fleets closing. */
export const CLOSE_WINDOW_DAYS = 14;

/** How close to its end a window can no longer be cancelled: the engine may already be closing the fleet. */
export const CANCEL_CUTOFF_MS = 10 * 60 * 1000;

/** Where a closed account asks to start again. The contact the docs already give. */
export const SUPPORT_EMAIL = 'info@whiteroom.tech';

export type CloseReason = 'deleted' | 'lapsed';

/** A stored close_reason as a CloseReason: anything but 'lapsed' is a deletion. */
export function closeReasonOf(v: unknown): CloseReason {
  return v === 'lapsed' ? 'lapsed' : 'deleted';
}

export interface Closing {
  reason: CloseReason;
  /** ISO time the fleets close. */
  closesAt: string;
  /**
   * A deletion: when the account itself is removed (ISO). The same as
   * closesAt, except after a deletion that replaced a running lapse, where
   * the fleet still closes at the lapse's end but the account gets 14 days.
   */
  deleteAfter?: string;
  /**
   * A deletion whose window has ended but can't finish yet (set once the
   * billing sync has found it blocked): why, as a short phrase, and which
   * kind of fix it needs.
   */
  blocked?: { reason: string; kind: 'subscription' | 'organization' };
}

/** What the banner and Settings know: the window, none, or 'unknown' when it couldn't be read. */
export type ClosingState = Closing | null | 'unknown';

/** Whether the window is still running: the fleet hasn't closed yet. */
export function isClosingOpen(c: Pick<Closing, 'closesAt'>, now = Date.now()): boolean {
  return new Date(c.closesAt).getTime() > now;
}

/** What the banner, Settings and the email say about a blocked deletion. */
export function blockedMessage(why: string): string {
  return `We can't delete your account yet: ${why}. Fix that and we'll finish. Your fleet is already closed.`;
}

/**
 * "November 10, 2026" in `timeZone` (the viewer's in the dashboard, UTC in
 * emails), the same zone daysLeft counts in, so the two never disagree.
 */
export function closingDate(iso: string, timeZone: string | undefined = 'UTC'): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone });
}

/** Calendar days from now until `iso` in `timeZone` (0 on the day itself, and once it has passed). */
export function daysLeft(iso: string, now = Date.now(), timeZone: string | undefined = 'UTC'): number {
  if (!isClosingOpen({ closesAt: iso }, now)) return 0;
  const day = (t: number) => {
    const [y, m, d] = new Date(t).toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.max(0, Math.round((day(new Date(iso).getTime()) - day(now)) / 86_400_000));
}
