// The over-cap line (spec §3.8, S1 and S15): what a new Free account made
// over the day's sign-up cap is told about when its Sandbox opens. Client-safe:
// the sign-in page and the Sandbox card both show it.

/** "7:00 PM" on the clock in `tz` ('' = the runtime's zone). */
function clock(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined }).format(new Date(ms));
}

/** "2026-11-09": the calendar day of `ms` in `tz`. */
function day(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz || undefined }).format(new Date(ms));
}

/**
 * "Your account is ready. We'll open your Sandbox at 7:00 PM your time.", or
 * "…tomorrow at 5:30 AM your time." when it opens on the viewer's next day.
 */
export function sandboxOpensLine(opensAtMs: number, nowMs: number, tz: string): string {
  const when = day(opensAtMs, tz) === day(nowMs, tz) ? 'at' : 'tomorrow at';
  return `Your account is ready. We'll open your Sandbox ${when} ${clock(opensAtMs, tz)} your time.`;
}
