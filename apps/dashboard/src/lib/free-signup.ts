import 'server-only';
import { createHmac } from 'node:crypto';
import type { AdapterUser } from 'next-auth/adapters';
import { cookies, headers } from 'next/headers';
import { db } from '@/lib/db';
import { FREE_INVITE_COOKIE, verifyInviteCookie } from '@/lib/free-invite';
import { freePlanMode } from '@/lib/plans';

// Where a new sign-up becomes Free (spec Part 1 §4, Q1, Q2). Called from the
// auth adapter's createUser, so the account's plan is decided with the row,
// never left to the users.trial_ends_at column default.
//
// Nobody is turned away. Over the day's cap, over the per-address limit, or
// a plus-address of an existing Free account: the account is still made as
// Free, its Sandbox opens at the next 00:00 UTC (users.sandbox_opens_at),
// and an ALERT line is logged.

/** New Free accounts a day before the rest that day open tomorrow. */
export const FREE_SIGNUPS_PER_UTC_DAY = 200;

/** New Free accounts from one client address a UTC day before the rest open tomorrow. */
export const FREE_SIGNUPS_PER_IP_PER_DAY = 5;

/** The address with any +tag removed and lower-cased: a+1@x.com counts as a@x.com. */
export function emailKey(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0) return e;
  const local = e.slice(0, at);
  const plus = local.indexOf('+');
  return `${plus > 0 ? local.slice(0, plus) : local}${e.slice(at)}`;
}

/** The first instant of the UTC day after `now`. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * The client's address from X-Forwarded-For. The dashboard sits behind
 * Google's load balancer, which appends "<client>, <load balancer>" to
 * whatever the client sent, so the client is the second entry from the end;
 * a lone entry is the client itself. '' when there's no header (local dev).
 */
export function clientIp(forwardedFor: string | null | undefined): string {
  const parts = (forwardedFor ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
}

/** A keyed hash of the address, so the address itself is never stored. */
export function ipHash(ip: string): string {
  return createHmac('sha256', process.env.AUTH_SECRET || 'wr-free-signup').update(`wr-free-signup-ip|${ip}`).digest('hex');
}

/**
 * Whether this sign-up starts on Free: every new sign-up with FREE_PLAN=public;
 * with FREE_PLAN=invite only one carrying a valid invite cookie (forged,
 * expired or for an old code: not Free); never with FREE_PLAN=off.
 */
export async function signUpIsFree(): Promise<boolean> {
  const mode = freePlanMode();
  if (mode === 'off') return false;
  if (mode === 'public') return true;
  try {
    return verifyInviteCookie((await cookies()).get(FREE_INVITE_COOKIE)?.value);
  } catch {
    return false;
  }
}

async function requestIp(): Promise<string> {
  try {
    return clientIp((await headers()).get('x-forwarded-for'));
  } catch {
    return '';
  }
}

export interface FreeSignupCounts { today: number; fromIp: number; sameIdentity: number }

/** Why a new Free account's Sandbox waits until tomorrow, if it does. */
export function deferReasons(c: FreeSignupCounts): string[] {
  const reasons: string[] = [];
  if (c.today >= FREE_SIGNUPS_PER_UTC_DAY) reasons.push(`over the day's cap of ${FREE_SIGNUPS_PER_UTC_DAY} Free sign-ups`);
  if (c.fromIp >= FREE_SIGNUPS_PER_IP_PER_DAY) reasons.push(`over ${FREE_SIGNUPS_PER_IP_PER_DAY} Free sign-ups from one address today`);
  if (c.sameIdentity > 0) reasons.push('a plus-address of an existing Free account');
  return reasons;
}

/**
 * Makes the account as Free in one transaction: the users row with
 * trial_state 'not_started' and trial_ends_at now() in the same INSERT, and
 * its free_signups row. Any failure rolls both back and throws, which fails
 * the sign-up (the person tries again); there is no fallback to the 90-day
 * column default.
 */
export async function createFreeUser(user: Omit<AdapterUser, 'id'>, now: Date = new Date()): Promise<AdapterUser> {
  const ip = ipHash(await requestIp());
  const key = emailKey(user.email ?? '');
  const client = await db().connect();
  let reasons: string[] = [];
  let opensAt: Date | null = null;
  let created: AdapterUser;
  try {
    await client.query('BEGIN');
    // One Free sign-up at a time, so two at once can't both slip under a limit.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('wr_free_signups'))`);
    const { rows: [c] } = await client.query(
      `SELECT count(*)::int AS today,
              count(*) FILTER (WHERE ip_hash = $2)::int AS from_ip,
              (SELECT count(*)::int FROM free_signups WHERE email_key = $3) AS same_identity
         FROM free_signups WHERE created_at >= $1`,
      [utcDayStart(now), ip, key],
    );
    reasons = deferReasons({ today: c?.today ?? 0, fromIp: c?.from_ip ?? 0, sameIdentity: c?.same_identity ?? 0 });
    opensAt = reasons.length > 0 ? nextUtcMidnight(now) : null;
    const { rows } = await client.query(
      `INSERT INTO users (name, email, "emailVerified", image, trial_state, trial_ends_at, sandbox_opens_at)
       VALUES ($1, $2, $3, $4, 'not_started', now(), $5)
       RETURNING id, name, email, "emailVerified", image`,
      [user.name ?? null, user.email, user.emailVerified ?? null, user.image ?? null, opensAt],
    );
    created = rows[0];
    if (!created?.id) throw new Error('no row returned');
    await client.query(`INSERT INTO free_signups (user_id, ip_hash, email_key) VALUES ($1, $2, $3)`, [created.id, ip, key]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[signup] could not make the Free account:', err instanceof Error ? err.message : 'unknown error');
    throw new Error('Could not create the account. Try again.');
  } finally {
    client.release();
  }
  if (opensAt) {
    // No address or email in the log: the reasons and the user id are enough to look into it.
    console.error(`[signup] ALERT: new Free account ${created.id} ${reasons.join('; ')}; its Sandbox opens at ${opensAt.toISOString()}`);
  }
  return created;
}
