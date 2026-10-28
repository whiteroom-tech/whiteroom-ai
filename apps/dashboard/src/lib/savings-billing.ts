// Savings-share billing: what the nightly billing sync tells Stripe.
//
// Server-only and NOT a 'use server' module: every function here takes a user
// id, and as server actions they would let anyone read another account's
// savings or bill it.
//
// The prices and their maths live in lib/plans.ts. This file only moves the
// numbers: each completed day's billable savings to a Stripe meter, and the
// monthly platform fee onto the subscription once the account reaches it.
import 'server-only';

import { db } from '@/lib/db';
import { readCred, type CredColumn } from '@/lib/cred-seal';
import { fleetOwners } from '@/lib/control-auth';
import { auditSummary } from '@/lib/whiteroom/client';
import { feeStartsAt, planItem, priceFor, savingsCents, savingsMeterEvent, stripePriceId, type PaidPlanId } from '@/lib/plans';

const DAY_S = 86_400;

/**
 * Days a missed night can still be reported for, before yesterday. Stripe
 * takes meter events up to 35 days old; three keeps a short outage covered
 * without reaching far back.
 */
export const CATCH_UP_DAYS = 3;

/**
 * Where the last reported day is kept: the Stripe customer's metadata.
 *
 * A meter event's `identifier` makes a resend safe only within Stripe's
 * dedupe window, which is "at least 24 hours". Catching up a missed day two
 * nights later is outside it, so the identifier alone could bill a day twice.
 * Recording the last day sent, on the customer (no webhook of ours fires on
 * customer updates), stops that without a ledger table.
 */
export const REPORTED_THROUGH_KEY = 'wr_savings_reported_through';

// -- Days (UTC) --

/** "2026-10-27" for the UTC day holding `ms`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The UTC day `n` days after `day`. */
export function addUtcDays(day: string, n: number): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) + n * DAY_S * 1000);
}

/** The first UTC day that starts at or after `seconds`: the first whole billable day. */
export function firstWholeDay(seconds: number): string {
  const day = utcDay(seconds * 1000);
  return Date.parse(`${day}T00:00:00Z`) === seconds * 1000 ? day : addUtcDays(day, 1);
}

/**
 * The completed days still to report, oldest first: from the day after the
 * last one reported (or the first billable day), back at most CATCH_UP_DAYS
 * before yesterday, through yesterday. Today isn't over, so it waits.
 * `dropped` is the range owed but older than that window (null when none):
 * it is not reported, and is logged for a person to bill.
 */
export function daysToReport({ now, reportedThrough, firstDay }: { now: number; reportedThrough: string | null; firstDay: string }): { days: string[]; dropped: { from: string; to: string } | null } {
  const yesterday = addUtcDays(utcDay(now), -1);
  const windowStart = addUtcDays(yesterday, -CATCH_UP_DAYS);
  const owedFrom = reportedThrough && addUtcDays(reportedThrough, 1) > firstDay ? addUtcDays(reportedThrough, 1) : firstDay;
  const from = owedFrom > windowStart ? owedFrom : windowStart;
  const days: string[] = [];
  for (let d = from; d <= yesterday; d = addUtcDays(d, 1)) days.push(d);
  return { days, dropped: owedFrom < windowStart ? { from: owedFrom, to: addUtcDays(windowStart, -1) } : null };
}

/** The meter event's identifier for one account-day: the same on every resend. */
export function meterIdentifier(userId: string, day: string): string {
  return `wr:${userId}:${day}`;
}

function trialEndMs(trialEndsAt: string | null): number {
  const ms = trialEndsAt ? Date.parse(trialEndsAt) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * The first UTC day billed for a subscription: the first whole day after
 * the later of its Stripe trial, its start, and the account's own free
 * period (which Stripe can't carry as a trial in its last 48 hours).
 */
export function firstBillableDay(sub: { start_date: number; trial_end?: number | null }, trialEndsAt: string | null): string {
  return firstWholeDay(Math.max(sub.trial_end ?? 0, sub.start_date, Math.ceil(trialEndMs(trialEndsAt) / 1000)));
}

// -- Reads --

/**
 * Every fleet this account owns, with the token to read it. Linked-but-not-
 * owned fleets bill their owner. Null when an owned fleet has no token that
 * can be read: its savings would be missing from the total.
 */
async function ownedFleetKeys(userId: string): Promise<Array<{ fleetId: string; token: string }> | null> {
  const { rows } = await db().query(
    `SELECT 'users' AS "table", fleet_id AS "fleetId", fleet_token AS plain, fleet_token_enc AS sealed FROM users WHERE id = $1 AND fleet_id IS NOT NULL
     UNION ALL
     SELECT 'user_fleets', fleet_id, fleet_token, fleet_token_enc FROM user_fleets WHERE user_id = $1 AND fleet_id IS NOT NULL`,
    [userId],
  );
  const owners = await fleetOwners([...new Set(rows.map((r) => r.fleetId as string))]);
  const owned = new Set<string>();
  const keys = new Map<string, string>();
  for (const r of rows) {
    if (owners.get(r.fleetId) !== userId) continue;
    owned.add(r.fleetId);
    if (keys.has(r.fleetId)) continue;
    const token = readCred(`${r.table}.fleet_token` as CredColumn, userId, r.plain, r.sealed);
    if (token) keys.set(r.fleetId, token);
  }
  if (keys.size < owned.size) return null;
  return [...keys].map(([fleetId, token]) => ({ fleetId, token }));
}

/**
 * The account's billable savings per UTC day since `fromDay`, in micro-dollars,
 * summed across the fleets it owns: "Saved by WhiteRoom" as Home and
 * Performance show it, the engine's audit_summary savingsByDay (smaller
 * context) plus cacheByDay (the caching WhiteRoom added), priced at the
 * account's own model prices; unpriced savings aren't in it. Null when any
 * owned fleet can't be read (no usable token, or the engine refused), or the
 * engine is too old to split savings by day: a partial figure would
 * under-bill a day that can't be corrected afterwards. An account with no
 * fleets saved nothing: an empty map.
 */
export async function savingsByUtcDay(userId: string, fromDay: string): Promise<Map<string, number> | null> {
  const fleets = await ownedFleetKeys(userId);
  if (!fleets) return null;
  const from = new Date(`${fromDay}T00:00:00Z`);
  try {
    const summaries = await Promise.all(fleets.map((f) => auditSummary(f.fleetId, from, f.token, undefined, 'UTC')));
    const byDay = new Map<string, number>();
    for (const s of summaries) {
      if (!s.savingsByDay || !s.cacheByDay) return null;
      for (const d of [...s.savingsByDay, ...s.cacheByDay]) byDay.set(d.day, (byDay.get(d.day) ?? 0) + (d.usdMicros ?? 0));
    }
    return byDay;
  } catch {
    return null;
  }
}

/**
 * User accounts a Starter fee is charged for: the members of the
 * organization this account owns, or 1 for a personal account.
 */
export async function feeSeats(userId: string): Promise<number> {
  const { rows } = await db().query(
    `SELECT count(*)::int AS n FROM organization_members
      WHERE status = 'active'
        AND org_id = (SELECT org_id FROM organization_members WHERE user_id = $1 AND status = 'active' AND role = 'owner')`,
    [userId],
  );
  return Math.max(1, rows[0]?.n ?? 0);
}

// -- Stripe --

interface ItemLike {
  id: string;
  quantity?: number | null;
  price: { id: string };
}

/** The Stripe calls this file makes: the real client fits it, and tests pass a fake. */
export interface BillingStripe {
  subscriptions: {
    retrieve(id: string): Promise<{ status: string; start_date: number; trial_end?: number | null; items: { data: ItemLike[] } }>;
  };
  subscriptionItems: {
    create(params: { subscription: string; price: string; quantity: number; proration_behavior: 'none' }): Promise<unknown>;
    update(id: string, params: { quantity: number; proration_behavior: 'create_prorations' }): Promise<unknown>;
    del(id: string, params: { proration_behavior: 'none' }): Promise<unknown>;
  };
  customers: {
    retrieve(id: string): Promise<{ deleted?: unknown; metadata?: Record<string, string> }>;
    update(id: string, params: { metadata: Record<string, string> }): Promise<unknown>;
  };
  billing: {
    meterEvents: {
      create(params: { event_name: string; identifier: string; timestamp: number; payload: Record<string, string> }): Promise<unknown>;
    };
  };
}

export interface BillingAccount {
  userId: string;
  customerId: string;
  subscriptionId: string;
  /** End of the account's free period (users.trial_ends_at). */
  trialEndsAt: string | null;
}

export interface BillingDeps {
  savingsByUtcDay(userId: string, fromDay: string): Promise<Map<string, number> | null>;
  feeSeats(userId: string): Promise<number>;
}

export interface AccountResult {
  /** Meter events sent (days with savings). */
  events: number;
  /** Savings couldn't be read: nothing reported, the days wait for the next run. */
  savingsUnavailable: boolean;
  fee: 'added' | 'updated' | null;
}

/**
 * Reports each completed, not yet reported day's savings to the meter, in
 * whole cents. Only days wholly after the subscription's free period are
 * billed, and none while Stripe still has it on trial. A day with nothing
 * saved sends nothing but still counts as reported.
 */
export async function reportSavings(
  s: BillingStripe,
  account: BillingAccount,
  sub: { status: string; start_date: number; trial_end?: number | null },
  deps: Pick<BillingDeps, 'savingsByUtcDay'>,
  now: number,
  deadline: number = Infinity,
): Promise<Pick<AccountResult, 'events' | 'savingsUnavailable'>> {
  const eventName = savingsMeterEvent();
  if (!eventName || sub.status === 'trialing') return { events: 0, savingsUnavailable: false };

  const customer = await s.customers.retrieve(account.customerId);
  if (customer.deleted) return { events: 0, savingsUnavailable: false };
  const { days, dropped } = daysToReport({
    now,
    reportedThrough: customer.metadata?.[REPORTED_THROUGH_KEY] ?? null,
    firstDay: firstBillableDay(sub, account.trialEndsAt),
  });
  if (dropped) {
    // Handed to a person once: the mark moves past them, so the same range
    // isn't logged again on the next run while savings stay unreadable.
    console.error(
      `[billing-sync] savings for user ${account.userId} (customer ${account.customerId}) from ${dropped.from} to ${dropped.to} are older than the catch-up window and were not reported to Stripe; bill them by hand`,
    );
    await s.customers.update(account.customerId, { metadata: { [REPORTED_THROUGH_KEY]: dropped.to } });
  }
  if (days.length === 0) return { events: 0, savingsUnavailable: false };

  const byDay = await deps.savingsByUtcDay(account.userId, days[0]);
  if (!byDay) return { events: 0, savingsUnavailable: true };

  let events = 0;
  for (const day of days) {
    // Out of time: the rest wait, unmarked, for the next run.
    if (Date.now() > deadline) break;
    const cents = savingsCents(byDay.get(day));
    // The day is marked reported BEFORE its event is sent. The other order
    // can bill a day twice: an event sent, then a failed mark, and the
    // resend a night later falls outside Stripe's identifier dedupe window.
    // This order can at worst miss a day, for a person to bill by hand: a
    // failed send is logged below, and the line before the mark lets a run
    // killed between the two be found (a "reporting" line with no event in
    // Stripe). A failed mark sends nothing and the day is retried.
    if (cents > 0) console.info(`[billing-sync] reporting savings for user ${account.userId} on ${day}: ${cents} cents (customer ${account.customerId})`);
    await s.customers.update(account.customerId, { metadata: { [REPORTED_THROUGH_KEY]: day } });
    if (cents === 0) continue;
    const event = {
      event_name: eventName,
      identifier: meterIdentifier(account.userId, day),
      // The day's last second, so it lands in that day's billing period.
      timestamp: Date.parse(`${day}T00:00:00Z`) / 1000 + DAY_S - 1,
      payload: { stripe_customer_id: account.customerId, value: String(cents) },
    };
    try {
      // One immediate retry: seconds apart, the identifier makes it safe.
      await s.billing.meterEvents.create(event).catch(() => s.billing.meterEvents.create(event));
    } catch (err) {
      console.error(
        `[billing-sync] savings for user ${account.userId} on ${day} (${cents} cents, customer ${account.customerId}) were not reported to Stripe; bill them by hand:`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    }
    events++;
  }
  return { events, savingsUnavailable: false };
}

/**
 * The monthly platform fee, from FEE_AFTER_TRIAL_DAYS after the free period:
 * added once (no proration: the first full month is the first one charged),
 * then kept at the right quantity. Starter is per user account, Pro one per
 * organization. A fee left from the other plan after a switch is removed.
 */
export async function syncFee(
  s: BillingStripe,
  account: BillingAccount,
  plan: PaidPlanId,
  items: ItemLike[],
  deps: Pick<BillingDeps, 'feeSeats'>,
  now: number,
): Promise<AccountResult['fee']> {
  const start = feeStartsAt(account.trialEndsAt);
  const price = stripePriceId(plan, 'fee');
  if (!start || now < start.getTime() || !price) return null;

  for (const item of items) {
    const found = priceFor(item.price.id);
    if (found?.kind === 'fee' && found.plan !== plan) await s.subscriptionItems.del(item.id, { proration_behavior: 'none' });
  }

  const want = plan === 'starter' ? await deps.feeSeats(account.userId) : 1;
  const current = items.find((i) => i.price.id === price);
  if (!current) {
    await s.subscriptionItems.create({ subscription: account.subscriptionId, price, quantity: want, proration_behavior: 'none' });
    return 'added';
  }
  if ((current.quantity ?? 1) !== want) {
    await s.subscriptionItems.update(current.id, { quantity: want, proration_behavior: 'create_prorations' });
    return 'updated';
  }
  return null;
}

/**
 * One account's nightly billing: savings to the meter, then the fee. A
 * subscription still on a retired price is left alone: it has no meter
 * price to bill against, and a fee on top would charge it twice.
 */
export async function syncAccountBilling(
  s: BillingStripe,
  account: BillingAccount,
  deps: BillingDeps,
  now: number = Date.now(),
  deadline: number = Infinity,
): Promise<AccountResult | null> {
  const sub = await s.subscriptions.retrieve(account.subscriptionId);
  const found = planItem(sub.items.data);
  if (!found || priceFor(found.item.price.id)?.kind === 'legacy') return null;
  const reported = await reportSavings(s, account, sub, deps, now, deadline);
  // Past the deadline the fee waits for the next run too: it's idempotent.
  const fee = Date.now() > deadline ? null : await syncFee(s, account, found.plan, sub.items.data, deps, now);
  return { ...reported, fee };
}

/**
 * The first day a subscription is billed for savings, or null when it bills
 * none: not one of ours, or still on a retired price.
 */
export async function billedFrom(s: BillingStripe, subscriptionId: string, trialEndsAt: string | null): Promise<string | null> {
  const sub = await s.subscriptions.retrieve(subscriptionId);
  const found = planItem(sub.items.data);
  if (!found || priceFor(found.item.price.id)?.kind === 'legacy') return null;
  return firstBillableDay(sub, trialEndsAt);
}

/**
 * The account's billable savings this calendar month (UTC) so far, in cents,
 * counted as the sync bills them: only days from `firstDay` (see
 * firstBillableDay), each day rounded down. Null when it can't be read.
 */
export async function monthToDateSavingsCents(userId: string, firstDay: string, now: number = Date.now()): Promise<number | null> {
  const monthStart = `${utcDay(now).slice(0, 7)}-01`;
  const from = firstDay > monthStart ? firstDay : monthStart;
  if (from > utcDay(now)) return 0;
  const byDay = await savingsByUtcDay(userId, from);
  if (!byDay) return null;
  let cents = 0;
  for (const [day, micros] of byDay) if (day >= from) cents += savingsCents(micros);
  return cents;
}
