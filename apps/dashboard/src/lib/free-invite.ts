// The Free invite link (FREE_PLAN=invite): `/sign-in?free=<code>`.
//
// proxy.ts checks the code and, when it matches FREE_INVITE_CODE, sets a
// short-lived, HttpOnly cookie signed with AUTH_SECRET, then drops the code
// from the URL. The auth adapter's createUser checks that cookie again before
// a new account starts on Free. The signature covers the expiry and the code
// itself (the cookie doesn't carry the code), so changing FREE_INVITE_CODE
// also invalidates every cookie already handed out.
//
// No server-only or database imports: proxy.ts imports this.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const FREE_INVITE_COOKIE = 'wr_free_invite';

/** How long the cookie lasts: long enough to finish a Google or email sign-in. */
export const FREE_INVITE_TTL_MS = 30 * 60_000;

/** The invite code currently accepted, or null when none is set. */
function inviteCode(): string | null {
  return process.env.FREE_INVITE_CODE?.trim() || null;
}

function signingSecret(): string | null {
  return process.env.AUTH_SECRET || null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Whether `given` is the current invite code, compared in constant time. False when no code is set. */
export function inviteCodeMatches(given: string | null | undefined): boolean {
  const want = inviteCode();
  if (!want || typeof given !== 'string' || !given) return false;
  return timingSafeEqual(sha256(given.trim()), sha256(want));
}

function mac(expires: number, code: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(`wr-free-invite|v1|${expires}|${code}`).digest();
}

/** A fresh cookie value for the current code, or null when no code or no signing secret is set. */
export function signInviteCookie(now: number = Date.now()): string | null {
  const code = inviteCode();
  const secret = signingSecret();
  if (!code || !secret) return null;
  const expires = now + FREE_INVITE_TTL_MS;
  return `${expires}.${mac(expires, code, secret).toString('base64url')}`;
}

/**
 * Whether `value` is an unexpired cookie signed for the current code. A
 * forged, expired or malformed value, an old code, or no code or secret set
 * all read as false.
 */
export function verifyInviteCookie(value: string | null | undefined, now: number = Date.now()): boolean {
  const code = inviteCode();
  const secret = signingSecret();
  if (!code || !secret || typeof value !== 'string') return false;
  const m = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return false;
  const expires = Number(m[1]);
  // Expired, or further out than any cookie this code would have issued.
  if (!(expires > now) || expires > now + FREE_INVITE_TTL_MS + 60_000) return false;
  const given = Buffer.from(m[2], 'base64url');
  const want = mac(expires, code, secret);
  return given.length === want.length && timingSafeEqual(given, want);
}
