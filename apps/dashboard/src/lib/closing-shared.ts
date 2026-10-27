// What the closing window (account deleted or plan lapsed) shares between
// server and browser code. lib/account-closing.ts holds the server side.

/** Days between deleting the account (or the plan lapsing) and the fleets closing. */
export const CLOSE_WINDOW_DAYS = 14;

export type CloseReason = 'deleted' | 'lapsed';

export interface Closing {
  reason: CloseReason;
  /** ISO time the fleets close. */
  closesAt: string;
}

/** "November 10, 2026": the day a window ends, as emails and the dashboard say it (UTC). */
export function closingDate(closesAt: string): string {
  return new Date(closesAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
