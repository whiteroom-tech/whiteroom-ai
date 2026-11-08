// What the Sandbox shows for the account's plan (Free tier spec Part 1 §3.1,
// §3.3, §3.7, §5): the Free line or the invite line above the steps, and the
// clean report's verdict. Decided by the account's plan, never by FREE_PLAN.
// Pure; the server action that reads it is sandbox-plan.ts.

import { SUPPORT_EMAIL } from '@/lib/closing-shared';
import { ROUTES } from '@/lib/routes';

/** The account's plan as the Sandbox needs it. `other`: every plan with live access, and anything unknown (today's page). */
export interface SandboxPlanView {
  plan: 'free' | 'suspended' | 'other';
  /** A plan can be bought now (Stripe prices set): Choose a plan; else Talk to us. */
  canBuy: boolean;
  /** A pending invitation's organization name (Free only): its line replaces the Free line. */
  invite: string | null;
}

/** Today's page: no plan lines, today's verdict. */
export const OTHER_PLAN: SandboxPlanView = { plan: 'other', canBuy: false, invite: null };

export const FREE_LINE = 'You’re on Free. Your 30 free days start when you take an agent live.';
export const RESET_7_DAYS = 'Your Sandbox history was cleared after 7 days.';
export const inviteLine = (org: string) => `${org} invited you to join their organization.`;

export const READY = 'Ready for live traffic.';
export const TAKE_IT_LIVE = 'Take it live';
export const TAKING_IT_LIVE = 'Taking it live…';
export const TAKE_IT_LIVE_SUB = 'Starts your 30 free days. No card needed.';
export const TAKE_IT_LIVE_FAILED = 'Couldn’t take it live. Try again.';
export const SUSPENDED_READY = (canBuy: boolean) => canBuy
  ? 'Ready for live traffic. Choose a plan to switch your fleets back on.'
  : 'Ready for live traffic. Talk to us to switch your fleets back on.';

/** Where Choose a plan goes; Talk to us mails support. */
export const CHOOSE_PLAN_HREF = `${ROUTES.settings}#plan`;
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;

/** After Take it live: Fleet key, with its one-time "You're live" banner, at the line to copy. */
export const LIVE_HREF = `${ROUTES.fleetKey}?live=1#point`;

/**
 * The one info line above the steps (§5), Free only (and so never on an
 * organization's fleet): the 7-day reset once, on the first visit after it
 * (any step; it replaces the Free line on that visit), else on Connect, a
 * pending invite, else the Free line.
 */
export function sandboxPlanLine(plan: SandboxPlanView, o: { resetUnseen: boolean; connect: boolean }): { kind: 'reset' | 'invite' | 'free'; text: string } | null {
  if (plan.plan !== 'free') return null;
  if (o.resetUnseen) return { kind: 'reset', text: RESET_7_DAYS };
  if (!o.connect) return null;
  if (plan.invite) return { kind: 'invite', text: inviteLine(plan.invite) };
  return { kind: 'free', text: FREE_LINE };
}

/** The 7-day reset line shows once, on the first visit after it happens: the reset last shown, per browser. */
export const RESET_SEEN_KEY = 'wr:sandbox-auto-reset-seen';
