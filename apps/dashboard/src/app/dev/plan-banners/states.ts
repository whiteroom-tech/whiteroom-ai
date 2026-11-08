import type { GoLiveStatus } from '@/components/AccountPlanBanner';
import type { PlanState } from '@/lib/plan-banner-shared';
import { GO_LIVE_REFUSED, NETWORK_LINE } from '@/lib/plan-banner-shared';

// Plan states for the /dev previews (mockup parity: Free-tier mockups S3,
// S5–S7b, S11, S20–S22). Nothing is read; ?plan=<name> picks one.
const DAY = 86_400_000;
const base: PlanState = { banner: null, date: null, canBuy: true, cardFixable: true, caveat: null, trialEndsAt: null };
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

export const PLAN_PREVIEWS: Record<string, { label: string; state: PlanState; goLive?: GoLiveStatus }> = {
  free: { label: 'S3 / S20 · Free', state: { ...base, banner: 'free', caveat: 'free' } },
  'free-busy': { label: 'S21 · Free, Go live busy', state: { ...base, banner: 'free', caveat: 'free' }, goLive: { busy: true, error: '' } },
  'free-refused': { label: 'S21 · Free, Go live refused', state: { ...base, banner: 'free', caveat: 'free' }, goLive: { busy: false, error: GO_LIVE_REFUSED } },
  'free-network': { label: 'S21 · Free, Go live network error', state: { ...base, banner: 'free', caveat: 'free' }, goLive: { busy: false, error: NETWORK_LINE } },
  live: { label: 'S5 · Just went live', state: { ...base, trialEndsAt: inDays(30) } },
  suspended: { label: 'S6(a) / S22 · Suspended, a plan can be bought', state: { ...base, banner: 'suspended', caveat: 'suspended' } },
  'suspended-talk': { label: 'S6(b) · Suspended, nothing to buy', state: { ...base, banner: 'suspended', caveat: 'suspended', canBuy: false } },
  'trial-ending': { label: 'S6b(a) · Trial ending, a plan can be bought', state: { ...base, banner: 'trial_ending', date: inDays(5), trialEndsAt: inDays(5) } },
  'trial-ending-talk': { label: 'S6b(b) · Trial ending, nothing to buy', state: { ...base, banner: 'trial_ending', date: inDays(5), trialEndsAt: inDays(5), canBuy: false } },
  grace: { label: 'S7 · Grace', state: { ...base, banner: 'grace', date: inDays(11) } },
  'grace-ended': { label: 'S7 · Grace, subscription cancelled by Stripe', state: { ...base, banner: 'grace', date: inDays(11), cardFixable: false } },
  'past-due': { label: 'S7b · Card failed (past_due)', state: { ...base, banner: 'past_due' } },
};

export function planPreview(name: unknown): { state: PlanState; goLive?: GoLiveStatus } | null {
  return typeof name === 'string' && Object.hasOwn(PLAN_PREVIEWS, name) ? PLAN_PREVIEWS[name] : null;
}
