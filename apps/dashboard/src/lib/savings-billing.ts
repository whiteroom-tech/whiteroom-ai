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
 */
export function daysToReport({ now, reportedThrough, firstDay }: { now: number; reportedThrough: string | null; firstDay: string }): string[] {
  const yesterday = addUtcDays(utcDay(now), -1);
  let from = addUtcDays(yesterday, -CATCH_UP_DAYS);
  if (firstDay > from) from = firstDay;
  if (reportedThrough && addUtcDays(reportedThrough, 1) > from) from = addUtcDays(reportedThrough, 1);
  const days: string[] = [];
  for (let d = from; d <= yesterday; d = addUtcDays(d, 1)) days.push(d);
  return days;
}

/** The meter event's identifier for one account-day: the same on every resend. */
export function meterIdentifier(userId: string, day: string): string {
  return `wr:${userId}:${day}`;
}

function trialEndMs(trialEndsAt: string | null): number {
  const ms = trialEndsAt ? Date.parse(trialEndsAt) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

// -- Reads --

/** Every fleet this account owns, with the token to read it. Linked-but-not-owned fleets bill their owner. */
async function ownedFleetKeys(userId: string): Promise<Array<{ fleetId: string; token: string }>> {
  const { rows } = await db().query(
    `SELECT 'users' AS "table", fleet_id AS "fleetId", fleet_token AS plain, fleet_token_enc AS sealed FROM users WHERE id = $1 AND fleet_id IS NOT NULL
     UNION ALL
     SELECT 'user_fleets', fleet_id, fleet_token, fleet_token_enc FROM user_fleets WHERE user_id = $1 AND fleet_id IS NOT NULL`,
    [userId],
  );
  const owners = await fleetOwners([...new Set(rows.map((r) => r.fleetId as string))]);
  const keys = new Map<string, string>();
  for (const r of rows) {
    if (keys.has(r.fleetId) || owners.get(r.fleetId) !== userId) continue;
    const token = readCred(`${r.table}.fleet_token` as CredColumn, userId, r.plain, r.sealed);
    if (token) keys.set(r.fleetId, token);
  }
  return [...keys].map(([fleetId, token]) => ({ fleetId, token }));
}

/**
 * The account's billable savings per UTC day since `fromDay`, in micro-dollars,
 * summed across the fleets it owns: the engine's audit_summary savingsByDay
 * ("Saved by WhiteRoom", priced at the account's own model prices; unpriced
 * savings aren't in it). Null when any fleet can't be read, or the engine is
 * too old to split savings by day: a partial figure would under-bill a day
 * that can't be corrected afterwards.
 */
export async function savingsByUtcDay(userId: string, fromDay: string): Promise<Map<string, number> | null> {
  const fleets = await ownedFleetKeys(userId);
  const from = new Date(`${fromDay}T00:00:00Z`);
  try {
    const summaries = await Promise.all(fleets.map((f) => auditSummary(f.fleetId, from, f.token, undefined, 'UTC')));
    const byDay = new Map<string, number>();
    for (const s of summaries) {
      if (!s.savingsByDay) return null;
      for (const d of s.savingsByDay) byDay.set(d.day, (byDay.get(d.day) ?? 0) + (d.usdMicros ?? 0));
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
): Promise<Pick<AccountResult, 'events' | 'savingsUnavailable'>> {
  const eventName = savingsMeterEvent();
  if (!eventName || sub.status === 'trialing') return { events: 0, savingsUnavailable: false };

  const customer = await s.customers.retrieve(account.customerId);
  if (customer.deleted) return { events: 0, savingsUnavailable: false };
  const days = daysToReport({
    now,
    reportedThrough: customer.metadata?.[REPORTED_THROUGH_KEY] ?? null,
    // Never before the account's own free period ends, even when Stripe
    // couldn't carry its last hours over as a trial.
    firstDay: firstWholeDay(Math.max(sub.trial_end ?? 0, sub.start_date, Math.ceil(trialEndMs(account.trialEndsAt) / 1000))),
  });
  if (days.length === 0) return { events: 0, savingsUnavailable: false };

  const byDay = await deps.savingsByUtcDay(account.userId, days[0]);
  if (!byDay) return { events: 0, savingsUnavailable: true };

  let events = 0;
  for (const day of days) {
    const cents = savingsCents(byDay.get(day));
    if (cents > 0) {
      await s.billing.meterEvents.create({
        event_name: eventName,
        identifier: meterIdentifier(account.userId, day),
        // The day's last second, so it lands in that day's billing period.
        timestamp: Date.parse(`${day}T00:00:00Z`) / 1000 + DAY_S - 1,
        payload: { stripe_customer_id: account.customerId, value: String(cents) },
      });
      events++;
    }
    // After each day, so a failure part-way never resends a day already sent.
    await s.customers.update(account.customerId, { metadata: { [REPORTED_THROUGH_KEY]: day } });
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
): Promise<AccountResult | null> {
  const sub = await s.subscriptions.retrieve(account.subscriptionId);
  const found = planItem(sub.items.data);
  if (!found || priceFor(found.item.price.id)?.kind === 'legacy') return null;
  const reported = await reportSavings(s, account, sub, deps, now);
  const fee = await syncFee(s, account, found.plan, sub.items.data, deps, now);
  return { ...reported, fee };
}

/** The account's billable savings this calendar month (UTC) so far, in cents. Null when it can't be read. */
export async function monthToDateSavingsCents(userId: string, now: number = Date.now()): Promise<number | null> {
  const byDay = await savingsByUtcDay(userId, `${utcDay(now).slice(0, 7)}-01`);
  if (!byDay) return null;
  let micros = 0;
  for (const v of byDay.values()) micros += v;
  return savingsCents(micros);
}
