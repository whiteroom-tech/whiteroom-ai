// What the closing window (account deleted or plan lapsed) shares between
// server and browser code. lib/account-closing.ts holds the server side.

/** Days between deleting the account (or the plan lapsing) and the fleets closing. */
export const CLOSE_WINDOW_DAYS = 14;

export type CloseReason = 'deleted' | 'lapsed';

export interface Closing {
  reason: CloseReason;
  /** ISO time the fleets close. */
  closesAt: string;
  /**
   * A deletion whose window has ended but can't finish yet (set once the
   * billing sync has found it blocked): why, and which kind of fix it needs.
   */
  blocked?: { reason: string; kind: 'subscription' | 'organization' };
}

/** What the banner, Settings and the email say about a blocked deletion: the reason, then the two ways out. */
export function blockedMessage(reason: string): string {
  return `Your account can't be deleted yet: ${reason} Your fleet is already closed. Once that's done, your account is deleted. Or keep your account.`;
}

/** "November 10, 2026": the day a window ends, as emails and the dashboard say it (UTC). */
export function closingDate(closesAt: string): string {
  return new Date(closesAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
