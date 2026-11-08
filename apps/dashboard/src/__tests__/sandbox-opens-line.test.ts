import { expect, it } from 'vitest';
import { sandboxOpensLine } from '@/lib/sandbox-opens-line';

// The over-cap line (free tier §3.10): the open time in the viewer's zone, "tomorrow at" when it's their next day.
const MIDNIGHT_UTC = Date.UTC(2026, 10, 9, 0, 0);

it('same day in the viewer’s zone: "at"', () => {
  // 20:00 UTC on Nov 8 is 3:00 PM in New York; midnight UTC is 7:00 PM there, same day.
  expect(sandboxOpensLine(MIDNIGHT_UTC, Date.UTC(2026, 10, 8, 20, 0), 'America/New_York')).toBe('Your account is ready. We’ll open your Sandbox at 7:00 PM your time.');
});

it('the viewer’s next day: "tomorrow at"', () => {
  // 17:00 UTC on Nov 8 is 10:30 PM in Kolkata; midnight UTC is 5:30 AM on Nov 9 there.
  expect(sandboxOpensLine(MIDNIGHT_UTC, Date.UTC(2026, 10, 8, 17, 0), 'Asia/Kolkata')).toBe('Your account is ready. We’ll open your Sandbox tomorrow at 5:30 AM your time.');
});

it('UTC viewer: midnight is always tomorrow', () => {
  expect(sandboxOpensLine(MIDNIGHT_UTC, Date.UTC(2026, 10, 8, 23, 59), 'UTC')).toBe('Your account is ready. We’ll open your Sandbox tomorrow at 12:00 AM your time.');
});
