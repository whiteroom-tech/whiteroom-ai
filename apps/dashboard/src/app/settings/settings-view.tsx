'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useLinkedSection } from '@/hooks/useLinkedSection';
import { AlertsSection } from '@/components/settings/AlertsSection';
import { DataPrivacySection } from '@/components/settings/DataPrivacySection';
import { SmallerHandoversSection } from '@/components/settings/SmallerHandoversSection';
import { AuditIntegritySection } from '@/components/settings/AuditIntegritySection';
import { useRouter } from 'next/navigation';
import { PageHeader, PageLead } from '@/components/citadel/PageChrome';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { FleetAuthProvider, useFleetAuth } from '@/hooks/useFleetAuth';
import { AppShell } from '@/components/AppShell';
import { Banner, Button, FONT_MONO } from '@whiteroom/ui';
import {
  cancelAccountDeletion,
  cancelEmailChange,
  deleteAccount,
  requestEmailChange,
  signOutEverywhere,
  unlinkProvider,
  updateProfile,
  type AccountOverview,
  type ActionResult,
} from '@/lib/account';
import { openBillingPortal, startCheckout } from '@/lib/billing';
import type { AlertsStatus, CompressionPreview, DataSettings } from '@/lib/whiteroom/client';
import type { AuditIntegrity } from '@/lib/whiteroom/types';
import type { Entitlement } from '@/lib/entitlements';
import { AUDIT_KEPT, PLANS, hasLiveSubscription, type PlanId } from '@/lib/plans';
import { agentsIncluded, monthShareLine } from '@/lib/metric-display';
import { getMonthSavings } from '@/lib/plan-savings';
import { CLOSE_WINDOW_DAYS, isClosingOpen, SUPPORT_EMAIL, type ClosingState } from '@/lib/closing-shared';
import { BlockedFix, CLOSING_CHANGED, closingMessage, SupportLink } from '@/components/AccountClosingBanner';
import { fmtTime, plural } from '@/lib/format';
import { browserZone as readBrowserZone, dayKey, daysBetween, setViewerZone } from '@/lib/zone-time';
import { useSavedViewerZone, useViewerZone } from '@/hooks/useViewerZone';
import { GOING_LIVE_LABEL, useGoLive, type GoLiveStatus } from '@/components/AccountPlanBanner';
import { GRACE_LINE, graceFix, NO_CARD, PAST_DUE_LINE, planDay, planSettled, subscriptionEnded } from '@/lib/plan-banner-shared';

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  email: 'Email link',
};

/** Each section's place on the page; the ids are on the cards or their wrappers below. */
const JUMPS: { id: string; label: string; fleet?: true }[] = [
  { id: 'settings-profile', label: 'Profile' },
  { id: 'plan', label: 'Plan' },
  { id: 'data-privacy', label: 'Data and privacy', fleet: true },
  { id: 'smaller-context', label: 'Smaller context', fleet: true },
  { id: 'alerts', label: 'Alerts', fleet: true },
  { id: 'audit-integrity', label: 'Audit trail', fleet: true },
  { id: 'settings-email-address', label: 'Email and sign-in' },
  { id: 'delete-account', label: 'Delete account' },
];

/**
 * A row of links to each section. Plain #links: the browser scrolls and the
 * address can be shared. Wraps on a phone. The fleet's sections show only with
 * a fleet signed in (or /dev sample data), so no link points at nothing.
 */
function JumpLinks({ preview }: { preview: boolean }) {
  const { fleetId } = useFleetAuth();
  const fleet = preview || !!fleetId;
  return (
    <nav aria-label="Settings sections" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: 'var(--fs-sm)' }}>
      {JUMPS.filter((j) => fleet || !j.fleet).map((j) => <a key={j.id} href={`#${j.id}`} className="wr-link">{j.label}</a>)}
    </nav>
  );
}

/** `support`: only support can resolve it, so the banner offers a way to reach them. */
type Notice = { tone: 'ok' | 'bad'; text: string; support?: boolean } | null;

function Section({
  title,
  description,
  children,
  tone = 'default',
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  tone?: 'default' | 'danger';
}) {
  const id = `settings-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return <SettingsCard id={id} anchor title={tone === 'danger' ? <span style={{ color: 'var(--bad)' }}>{title}</span> : title} sub={description} tone={tone}>{children}</SettingsCard>;
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--fs-sm)',
  fontWeight: 600,
  color: 'var(--tx2)',
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 40,
  background: 'var(--card)',
  border: '1px solid var(--line2)',
  borderRadius: 8,
  padding: '0 12px',
  color: 'var(--tx)',
  fontSize: 'var(--fs-md)',
  fontFamily: 'inherit',
};

export function SettingsView({
  account,
  entitlement,
  purchasablePlans,
  billingResult,
  closing,
  samples,
}: {
  account: AccountOverview;
  entitlement: Entitlement;
  purchasablePlans: PlanId[];
  billingResult: string | null;
  /** The account's closing window (deleted or plan lapsed), null, or 'unknown' when it couldn't be read. */
  closing: ClosingState;
  /** /dev/settings: sample fleet settings for the sections that read the engine. */
  samples?: { data?: DataSettings; smaller?: CompressionPreview; alerts?: AlertsStatus; audit?: AuditIntegrity; goLive?: GoLiveStatus };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const sections = useRef<HTMLDivElement>(null);
  useLinkedSection(sections);
  const [banner, setBanner] = useState<Notice>(
    billingResult === 'success'
      ? { tone: 'ok', text: 'Subscription active. It can take a moment for new limits to reach your fleets.' }
      : billingResult === 'cancelled'
        ? { tone: 'bad', text: 'Checkout cancelled — nothing was charged.' }
        : null,
  );

  function run(action: () => Promise<{ ok: boolean; error?: string }>, successText: string) {
    startTransition(async () => {
      try {
        const res = await action();
        if (res.ok) {
          setBanner({ tone: 'ok', text: successText });
          router.refresh();
        } else {
          setBanner({ tone: 'bad', text: res.error ?? 'Something went wrong.' });
        }
      } catch (err) {
        setBanner({ tone: 'bad', text: err instanceof Error ? err.message : 'Something went wrong.' });
      }
    });
  }

  return (
    // One fleet session check for the header and the four fleet sections, not one each.
    <FleetAuthProvider>
    <AppShell>
      <SettingsHeader email={account.email} />
      <main style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <div ref={sections} className="wr-settings-stack wr-setup-page">
          <PageLead>Profile, plan, data, alerts and sign-in.</PageLead>
          <JumpLinks preview={!!samples} />

          {banner && (
            <Banner variant={banner.tone === 'ok' ? 'info' : 'error'} icon={banner.tone === 'ok' ? 'check' : undefined} actions={banner.support ? <SupportLink /> : undefined}>{banner.text}</Banner>
          )}

          <ProfileSection account={account} pending={pending} run={run} />
          <div id="plan"><PlanSection entitlement={entitlement} purchasablePlans={purchasablePlans} setBanner={setBanner} pending={pending} goLivePreview={samples?.goLive} /></div>
          <DataPrivacySection preview={samples?.data} />
          <SmallerHandoversSection sample={samples?.smaller} />
          <div id="alerts"><AlertsSection preview={samples?.alerts} /></div>
          <div id="audit-integrity"><AuditIntegritySection preview={samples?.audit} /></div>
          <EmailSection account={account} pending={pending} run={run} />
          <MethodsSection account={account} pending={pending} run={run} />
          <SessionsSection pending={pending} />
          <div id="delete-account"><DangerSection account={account} closing={closing} pending={pending} /></div>
        </div>
      </main>
    </AppShell>
    </FleetAuthProvider>
  );
}

/** "/ fleet-id" when a fleet is signed in (as on every page), else the account email. */
function SettingsHeader({ email }: { email: string | null }) {
  const { fleetId } = useFleetAuth();
  return fleetId
    ? <PageHeader title="Settings" fleetId={fleetId} />
    : <PageHeader title="Settings" fleetId={email} fleetTitle="Signed in as" />;
}

// -- Profile --

function ProfileSection({
  account,
  pending,
  run,
}: {
  account: AccountOverview;
  pending: boolean;
  run: (a: () => Promise<{ ok: boolean; error?: string }>, s: string) => void;
}) {
  const [name, setName] = useState(account.name ?? '');
  const [timezone, setTimezone] = useState(account.timezone ?? '');
  const [browserZone, setBrowserZone] = useState('your local zone');
  // The zone dates use now: the saved one (when this browser knows it), else null for the browser's.
  const inUse = useSavedViewerZone();
  // After mount: the server's zone isn't the viewer's, and rendering it would mismatch hydration.
  useEffect(() => { setBrowserZone(readBrowserZone() || 'your local zone'); }, []);

  // Populated after mount, never during render.
  //
  // Node and the browser ship different ICU timezone databases, so a list
  // built while server-rendering this client component doesn't match the one
  // the browser builds — React reports it as a hydration mismatch on the first
  // <option> that differs (America/Creston vs America/Coyhaique, in practice).
  // Deferring to an effect means the list is only ever produced by the engine
  // that will actually display it.
  //
  // Intl.supportedValuesOf also isn't in every engine's typings and isn't worth
  // a polyfill — fall back to the browser's own zone if it's missing.
  const [zones, setZones] = useState<string[] | null>(null);
  useEffect(() => {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    try {
      setZones(supported ? supported('timeZone') : [Intl.DateTimeFormat().resolvedOptions().timeZone]);
    } catch {
      setZones([Intl.DateTimeFormat().resolvedOptions().timeZone]);
    }
  }, []);

  // Before the list arrives, offer just the saved value so the select still
  // shows what the account is actually set to rather than snapping to "browser
  // default" for a frame.
  const options = zones ?? (account.timezone ? [account.timezone] : []);

  const dirty = name !== (account.name ?? '') || timezone !== (account.timezone ?? '');

  return (
    <Section title="Profile" description="How you appear across the dashboard">
      <div className="wr-settings-pair">
        <div>
          <label htmlFor="name" style={labelStyle}>Display name</label>
          <input id="name" style={inputStyle} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="tz" style={labelStyle}>Time zone</label>
          <select id="tz" style={inputStyle} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            <option value="">Use my browser&apos;s time zone ({browserZone})</option>
            {options.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        </div>
      </div>
      {/* Say plainly which zone every date and day on the dashboard is in. */}
      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: '10px 0 14px' }}>
        {inUse ? <>Dates and days use {inUse}.</> : <>Dates and days use your browser&apos;s time zone ({browserZone}).</>}
      </p>
      <Button
        disabled={pending || !dirty}
        onClick={() => run(() => saveProfile({ name, timezone: timezone || null }), 'Profile saved.')}
      >
        Save profile
      </Button>
    </Section>
  );
}

/**
 * Save the profile and, once saved, switch every date on the dashboard to the
 * new zone at once rather than on the next load. `update` is the server action.
 */
export async function saveProfile(
  input: { name: string; timezone: string | null },
  update: typeof updateProfile = updateProfile,
): Promise<{ ok: boolean; error?: string }> {
  const res = await update(input);
  if (res.ok) setViewerZone(input.timezone);
  return res;
}

/** "Dec 26", or "Jan 4, 2027" outside the current year, for a plan date (stored at UTC midnight, so read in UTC). */
export function shortDay(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  const otherYear = d.getUTCFullYear() !== new Date(now).getUTCFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(otherYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}

// -- Plan & billing --

function PlanSection({
  entitlement,
  purchasablePlans,
  setBanner,
  pending,
  goLivePreview,
}: {
  entitlement: Entitlement;
  purchasablePlans: PlanId[];
  setBanner: (b: Notice) => void;
  pending: boolean;
  /** /dev/settings: Go live as busy or refused. */
  goLivePreview?: GoLiveStatus;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const { plan, limits, usage, subscription } = entitlement;
  const agents = agentsIncluded(plan, usage.agents);
  // The account's free period, by date: a subscriber can be inside it too
  // (Stripe carries the rest over as a trial), where onTrial is false.
  const freeNow = Date.parse(entitlement.trialEndsAt) > Date.now();
  // Not on a comped plan or a contract: nothing is billed there.
  const selfServe = PLANS[plan].pricing !== null && !subscription?.planOverride;
  // This month's savings in cents: null while loading or unreadable ("—"
  // shown), 'none' when no subscription bills savings (the line is hidden).
  const [monthShare, setMonthShare] = useState<number | null | 'none'>(null);
  const wantsShare = selfServe && !freeNow;
  const showsShare = wantsShare && monthShare !== 'none';
  useEffect(() => {
    if (!wantsShare) return;
    let live = true;
    getMonthSavings().then(
      (r) => { if (live) setMonthShare(r === null ? null : 'savedCents' in r ? r.savedCents : 'none'); },
      () => { if (live) setMonthShare(null); },
    );
    return () => { live = false; };
  }, [wantsShare]);

  async function go(action: () => Promise<{ ok: boolean; url?: string; error?: string; support?: boolean }>, key: string) {
    setBusy(key);
    try {
      const res = await action();
      // Stripe's hosted pages are a full navigation, not a fetch — assigning
      // location is the handoff.
      if (res.ok && res.url) window.location.href = res.url;
      else setBanner({ tone: 'bad', text: res.error ?? 'Could not reach Stripe.', support: res.support });
    } catch (err) {
      setBanner({ tone: 'bad', text: err instanceof Error ? err.message : 'Could not reach Stripe.' });
    } finally {
      setBusy(null);
    }
  }

  // A paying customer switches plan in the portal (Checkout would start a
  // second subscription), so the cards route there instead.
  const subscribed = hasLiveSubscription(subscription);
  // On the free period, Starter is still worth offering: subscribing is how
  // they keep it once the free days are up.
  // Never on a custom contract or a comped plan: a Checkout there would start
  // a second, self-serve bill beside it.
  const contracted = plan === 'enterprise' || !!subscription?.planOverride;
  // A lapsed plan in its grace can be bought again: it's the plan they had.
  // Its day in the viewer's zone once known (UTC while hydrating, as the server renders it).
  const zone = useViewerZone();
  const graceEnd = entitlement.graceEndsAt ? (zone ? planDay(entitlement.graceEndsAt, zone) : shortDay(entitlement.graceEndsAt)) : null;
  // A card that failed (still retrying, or lapsed into its grace) is fixed in the billing portal: Update card.
  // A plan cancelled on purpose that runs out isn't a failed payment: it keeps today's line.
  const cancelled = !!graceEnd && !!subscription?.cancelAtPeriodEnd;
  // Once Stripe has cancelled the subscription a new card can't keep it: a new plan does (or us, when none can be bought).
  const ended = subscriptionEnded(subscription?.status);
  const fix = graceFix(!ended, !contracted && purchasablePlans.length > 0);
  const cardFailed = graceEnd && !cancelled ? GRACE_LINE(graceEnd, fix) : hasLiveSubscription(subscription) && subscription?.status === 'past_due' ? PAST_DUE_LINE : null;
  const cardAction = graceEnd && !cancelled ? fix : 'card';
  // The same plan again only once its subscription is gone; while it exists (unpaid), a new card keeps it and a
  // second Checkout would start a second subscription beside it, so plan changes go through the portal then.
  const graceLive = !!graceEnd && !ended && !!subscription?.stripeSubscriptionId;
  const canBuy = (p: PlanId) => !contracted && purchasablePlans.includes(p) && (p !== plan || entitlement.onTrial || (!!graceEnd && !graceLive));
  const live = useGoLive('settings', goLivePreview);
  const trialEnd = shortDay(entitlement.trialEndsAt);
  // Counted in the viewer's zone, so only once it's known: the server's UTC
  // count can differ by a day and would mismatch hydration.
  const trialDaysLeft = zone !== null ? freeDaysLeft(entitlement.trialEndsAt) : null;
  const plansOpen = !planSettled({ plan, onTrial: entitlement.onTrial, cardFailed: !!cardFailed, cancelled });

  return (
    <Section title="Plan" description="Limits apply to every fleet on the account">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 'var(--fs-card)', fontWeight: 600 }}>{PLANS[plan].name}</strong>
            {entitlement.onTrial && <span className="wr-settings-pill" data-tone="ok">free until {trialEnd}{trialDaysLeft !== null && <> · {trialDaysLeft} {plural(trialDaysLeft, 'day')} left</>}</span>}
            {subscription?.planOverride && <span className="wr-settings-pill" data-tone="ok">comped</span>}
            {subscription?.cancelAtPeriodEnd && <span className="wr-settings-pill" data-tone="warn">ends {subscription.currentPeriodEnd ? shortDay(subscription.currentPeriodEnd) : ''}</span>}
            {subscription?.status === 'past_due' && <span className="wr-settings-pill" data-tone="bad">payment failed</span>}
          </div>
          <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: '4px 0 0' }}>{PLANS[plan].blurb}</p>
        </div>
        {/* Only when there's a real Stripe customer behind it. A comped account
            has a `pending_…` placeholder in that column (see setPlanOverride),
            and offering it a portal link would just produce an error. */}
        {subscription?.stripeCustomerId?.startsWith('cus_') && (!cardFailed || cardAction !== 'card') && (
          <Button variant="secondary" disabled={busy !== null} onClick={() => go(openBillingPortal, 'portal')}>
            {busy === 'portal' ? 'Opening…' : 'Manage billing'}
          </Button>
        )}
      </div>

      {showsShare && (
        <p style={{ fontSize: 'var(--fs-sm)', margin: '0 0 14px', fontVariantNumeric: 'tabular-nums' }}>{monthShareLine(plan, monthShare)}</p>
      )}
      {plan === 'free' && (
        <div style={{ display: 'grid', gap: 6, justifyItems: 'start', margin: '0 0 14px' }}>
          <Button variant="primary" busy={live.busy} busyLabel={GOING_LIVE_LABEL} disabled={busy !== null || pending} onClick={live.goLive}>Go live</Button>
          {live.error && <p role="alert" style={{ fontSize: 'var(--fs-sm)', color: 'var(--bad)', margin: 0 }}>{live.error}</p>}
          <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: 0 }}>{NO_CARD}</p>
        </div>
      )}
      {cancelled && <p style={{ fontSize: 'var(--fs-sm)', margin: '0 0 14px' }}>Your plan pauses on {graceEnd}. Subscribe again to keep it.</p>}
      {cardFailed && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '0 0 14px' }}>
          <p style={{ fontSize: 'var(--fs-sm)', margin: 0, flex: '1 1 260px' }}>{cardFailed}</p>
          {cardAction === 'card' ? (
            <Button variant="primary" disabled={busy !== null} onClick={() => go(openBillingPortal, 'portal')}>
              {busy === 'portal' ? 'Opening…' : 'Update card'}
            </Button>
          ) : cardAction === 'buy' ? (
            <Button variant="primary" disabled={busy !== null} onClick={() => { const el = document.getElementById('settings-plan-choices'); el?.closest('details')?.setAttribute('open', ''); el?.scrollIntoView({ block: 'start' }); }}>Choose a plan</Button>
          ) : (
            <Button variant="primary" disabled={busy !== null} onClick={() => { window.location.href = `mailto:${SUPPORT_EMAIL}`; }}>Talk to us</Button>
          )}
        </div>
      )}
      {/* Subscribed inside the free period: the badge is gone, so the line says when billing starts. */}
      {selfServe && freeNow && !entitlement.onTrial && <p style={{ fontSize: 'var(--fs-sm)', margin: '0 0 14px' }}>Free until {trialEnd}</p>}

      <div className="wr-settings-stats">
        {/* Not on Free: its Sandbox fleet isn't counted, and 0 / 0 agents says nothing. */}
        {plan !== 'free' && <Meter label="Fleets" used={usage.fleets} limit={limits.maxFleets} over={usage.fleets > limits.maxFleets ? `${usage.fleets - limits.maxFleets} over the ${PLANS[plan].name} limit` : undefined} />}
        {/* Live registered agents, never 0 when the engine can't be reached (M16).
            The plan's agent count is soft: going over it stops nothing. */}
        {plan === 'free' ? null : agents ? (
          <div className="wr-settings-stat" data-warn={agents.over ? '' : undefined}>
            <div className="wr-settings-stat__label">Agents</div>
            <div className="wr-settings-stat__num">{agents.value}</div>
            {agents.note && (
              <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--tx2)' }}>
                {agents.note} <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: 'inherit' }}>Talk to us about larger fleets</a>
              </div>
            )}
          </div>
        ) : usage.agents !== null && plan === 'suspended' ? (
          <Meter label="Agents" used={usage.agents} limit={limits.maxAgentsPerFleet} over={usage.agents > limits.maxAgentsPerFleet ? `${usage.agents - limits.maxAgentsPerFleet} over the ${PLANS[plan].name} limit` : undefined} />
        ) : (
          <Stat label="Agents registered" value={usage.agents === null ? 'Unavailable' : String(usage.agents)} />
        )}
        <Stat label="History kept" value={`${limits.retentionDays} days`} />
      </div>
      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: '12px 0 16px' }}>
        History means calls and runs. The audit trail is kept for {AUDIT_KEPT}.
      </p>

      {/* Folded for a settled account (nothing to buy next); open wherever a card's button is the next step. */}
      <details open={plansOpen}>
      <summary style={{ cursor: 'pointer', fontWeight: 600, margin: '0 0 12px' }}>Compare plans</summary>
      <div className="wr-settings-plans" id="settings-plan-choices">
        {(['starter', 'pro', 'enterprise'] as const).map((p) => (
          <div key={p} className="wr-settings-plan">
            <h3 style={{ margin: 0, fontSize: 'var(--fs-card)', fontWeight: 600 }}>{PLANS[p].name}</h3>
            <p style={{ fontSize: 'var(--fs-sm)', margin: '6px 0 0' }}>{PLANS[p].priceLine}</p>
            <ul style={{ margin: '10px 0 16px', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {PLANS[p].features.map((f) => <li key={f}>{f}</li>)}
            </ul>
            {p === 'enterprise' ? (
              <a href={`mailto:${SUPPORT_EMAIL}`} className="wr-btn wr-btn--secondary wr-btn--h32">Talk to us</a>
            ) : canBuy(p) && (
              <Button
                variant={p === 'starter' && entitlement.onTrial ? 'secondary' : 'primary'}
                disabled={busy !== null || pending}
                onClick={() => go(() => (subscribed || graceLive ? openBillingPortal() : startCheckout(p)), p)}
              >
                {busy === p
                  ? 'Opening…'
                  : p === 'starter' && entitlement.onTrial
                    ? `Subscribe (free until ${trialEnd})`
                    : p === plan && graceEnd
                      ? `Subscribe to ${PLANS[p].name} again`
                      : `Switch to ${PLANS[p].name}`}
              </Button>
            )}
          </div>
        ))}
      </div>
      </details>
    </Section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="wr-settings-stat">
      <div className="wr-settings-stat__label">{label}</div>
      <div className="wr-settings-stat__num">{value}</div>
    </div>
  );
}

function Meter({ label, used, limit, over }: { label: string; used: number; limit: number; over?: string }) {
  return (
    <div className="wr-settings-stat" data-warn={over ? '' : undefined}>
      <div className="wr-settings-stat__label">{label}</div>
      <div className="wr-settings-stat__num" style={{ color: over ? 'var(--warn)' : undefined }}>{used} / {limit}</div>
      {over
        ? <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--warn)' }}>{over}</div>
        : used >= limit && <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--tx2)' }}>At the limit: another one is refused</div>}
    </div>
  );
}

// -- Email --

function EmailSection({
  account,
  pending,
  run,
}: {
  account: AccountOverview;
  pending: boolean;
  run: (a: () => Promise<{ ok: boolean; error?: string }>, s: string) => void;
}) {
  const [newEmail, setNewEmail] = useState('');
  // In the viewer's zone, so only once hydrated (the server would write its own).
  const expiresIso = account.pendingEmailChange?.expiresAt;
  const expiresAt = useViewerZone() !== null && expiresIso ? fmtTime(expiresIso) : '';

  return (
    <Section
      title="Email address"
      description="The address you sign in with. A change must be confirmed from the new inbox."
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <span>Current: <span style={{ fontFamily: FONT_MONO }}>{account.email}</span></span>
        {account.emailVerified && (
          <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: 'var(--ok-bg)', color: 'var(--ok)' }}>
            verified
          </span>
        )}
      </div>

      {account.pendingEmailChange ? (
        <div
          style={{
            background: 'var(--warn-bg)',
            border: '1px solid var(--warn)',
            borderRadius: 8,
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--warn)' }}>
            Waiting on confirmation at{' '}
            <span style={{ fontFamily: FONT_MONO }}>{account.pendingEmailChange.newEmail}</span>. The link expires at{' '}
            {expiresAt}.
          </div>
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => run(cancelEmailChange, 'Email change cancelled.')}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px' }}>
            <label htmlFor="newEmail" style={labelStyle}>New email</label>
            <input
              id="newEmail"
              type="email"
              style={inputStyle}
              value={newEmail}
              placeholder="you@company.com"
              onChange={(e) => setNewEmail(e.target.value)}
            />
          </div>
          <Button
            variant="secondary"
            disabled={pending || newEmail.trim().length === 0}
            onClick={() =>
              run(async () => {
                const res = await requestEmailChange(newEmail);
                if (res.ok) setNewEmail('');
                return res;
              }, 'Confirmation link sent. Open it from the new inbox to finish.')
            }
          >
            Send confirmation
          </Button>
        </div>
      )}
    </Section>
  );
}

// -- Sign-in methods --

function MethodsSection({
  account,
  pending,
  run,
}: {
  account: AccountOverview;
  pending: boolean;
  run: (a: () => Promise<{ ok: boolean; error?: string }>, s: string) => void;
}) {
  return (
    <Section title="Sign-in methods" description="At least one has to stay">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {account.methods.map((m) => {
          const same = account.methods.filter((o) => o.provider === m.provider);
          return (
            <div key={m.id} className="wr-srow">
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ fontWeight: 600 }}>{PROVIDER_LABELS[m.provider] ?? m.provider}</strong>
                {/* Several rows can share a provider — two Google accounts on
                    one user is a real shape in production — so the account
                    number is what tells them apart. */}
                {same.length > 1 && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', marginLeft: 6 }}>account {same.findIndex((o) => o.id === m.id) + 1}</span>}
                {/* Google's account ref is a numeric ID that means nothing to
                    people; the email method's ref is the address itself. */}
                {m.provider === 'email' && <div style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', color: 'var(--tx2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.accountRef}</div>}
              </div>
              {m.provider !== 'email' && <span className="wr-settings-pill" data-tone="ok">Connected</span>}
              {m.canUnlink ? (
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => run(() => unlinkProvider(m.id), `${PROVIDER_LABELS[m.provider] ?? m.provider} unlinked.`)}
                >
                  Unlink
                </Button>
              ) : (
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
                  {m.provider === 'email' ? 'Always available' : 'Only method'}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// -- Sessions --

function SessionsSection({ pending }: { pending: boolean }) {
  const [busy, setBusy] = useState(false);

  return (
    <Section
      title="Active sessions"
      description="Signs you out on every device, including this one"
    >
      <Button
        variant="secondary"
        disabled={pending || busy}
        onClick={() => {
          setBusy(true);
          // Ends with a redirect to /sign-in, so there is no success state to
          // render here — the page is gone either way.
          signOutEverywhere().catch(() => setBusy(false));
        }}
      >
        {busy ? 'Signing out…' : 'Sign out everywhere'}
      </Button>
    </Section>
  );
}

// -- Danger --

export function DangerSection({ account, closing, pending }: { account: AccountOverview; closing: ClosingState; pending: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The viewer's zone, read after mount so server and browser render alike;
  // the banner counts in the same one.
  // UTC while hydrating (or when the browser names no zone); then the viewer's, following a new saved zone at once.
  const timeZone = useViewerZone() || 'UTC';
  // A change from here or from the banner (cancel, keep): read the page's state again.
  useEffect(() => {
    const changed = () => router.refresh();
    window.addEventListener(CLOSING_CHANGED, changed);
    return () => window.removeEventListener(CLOSING_CHANGED, changed);
  }, [router]);

  const matches = confirm.trim().toLowerCase() === (account.email ?? '').toLowerCase();
  const fleets = plural(account.fleetCount, 'fleet');
  const exportLink = <a href="#audit-integrity" style={{ color: 'var(--brand)' }}>download your data</a>;
  const errorLine = error && <p role="alert" style={{ fontSize: 'var(--fs-sm)', color: 'var(--bad)', margin: '0 0 12px' }}>{error}</p>;
  const text = (t: React.ReactNode) => <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: '0 0 16px', maxWidth: '62ch' }}>{t}</p>;

  async function act(action: () => Promise<ActionResult>, failure: string) {
    setBusy(true);
    setError('');
    try {
      const res = await action();
      if (!res.ok) { setError(res.error); return; }
      setOpen(false);
      setConfirm('');
      window.dispatchEvent(new Event(CLOSING_CHANGED));
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  if (closing === 'unknown') {
    return (
      <Section title="Delete account" tone="danger">
        {text("Couldn't check your account status. Reload the page to try again.")}
      </Section>
    );
  }

  const deleting = closing?.reason === 'deleted' ? closing : null;
  const keep = (
    <Button variant="secondary" disabled={pending || busy} onClick={() => void act(cancelAccountDeletion, 'Could not keep the account.')}>
      {busy ? 'Keeping…' : 'Keep my account'}
    </Button>
  );

  if (deleting && !isClosingOpen(deleting)) {
    const waiting = !!deleting.deleteAfter && new Date(deleting.deleteAfter).getTime() > Date.now();
    return (
      <Section title="Delete account" tone="danger">
        {text(closingMessage(deleting, Date.now(), timeZone))}
        {errorLine}
        {(deleting.blocked || waiting) && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {deleting.blocked && <BlockedFix kind={deleting.blocked.kind} />}
            {keep}
          </div>
        )}
      </Section>
    );
  }

  if (deleting) {
    return (
      <Section title="Delete account" tone="danger">
        {text(<>{closingMessage(deleting, Date.now(), timeZone)} Until then you can {exportLink} or cancel. The audit trail is kept for {AUDIT_KEPT}.</>)}
        {errorLine}
        <Button variant="secondary" disabled={pending || busy} onClick={() => void act(cancelAccountDeletion, 'Could not cancel the deletion.')}>
          {busy ? 'Cancelling…' : 'Cancel deletion'}
        </Button>
      </Section>
    );
  }

  return (
    <Section
      title="Delete account"
      tone="danger"
      description={`Deletes your account after ${CLOSE_WINDOW_DAYS} days and closes your ${fleets}. Cancel any paid subscription first, and hand over any organization you solely own.`}
    >
      {!open ? (
        <Button variant="danger" disabled={pending} onClick={() => setOpen(true)}>
          Delete my account
        </Button>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', maxWidth: '62ch' }}>
            <p style={{ margin: '0 0 6px' }}>What happens:</p>
            <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc', display: 'grid', gap: 4 }}>
              <li>For the next {CLOSE_WINDOW_DAYS} days your {fleets} keep{account.fleetCount === 1 ? 's' : ''} working. You can {exportLink} or cancel at any time.</li>
              <li>After {CLOSE_WINDOW_DAYS} days your WhiteRoom fleet key stops working and calls through it are refused. Your account is removed.</li>
              <li>The audit trail is kept for {AUDIT_KEPT}.</li>
            </ul>
          </div>
          <div>
            <label htmlFor="confirmDelete" style={labelStyle}>
              Type {account.email} to confirm
            </label>
            <input
              id="confirmDelete"
              style={inputStyle}
              value={confirm}
              autoComplete="off"
              onChange={(e) => { setConfirm(e.target.value); setError(''); }}
            />
          </div>
          {error && <p role="alert" style={{ fontSize: 'var(--fs-sm)', color: 'var(--bad)', margin: 0 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Button
              variant="danger-fill"
              disabled={!matches || busy}
              onClick={() => void act(() => deleteAccount(confirm), 'Could not delete the account.')}
            >
              {busy ? 'Deleting…' : `Delete in ${CLOSE_WINDOW_DAYS} days`}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => { setOpen(false); setConfirm(''); setError(''); }}>
              Keep my account
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

/**
 * Days left in the free period, as calendar days from today to the end day in the viewer's
 * zone: "Dec 30" is 63 days from Oct 28 whatever the hour. Rounded, so a DST day (23 or 25
 * hours) doesn't tip it; at least 1 while it hasn't ended. Not capped: an older account's
 * free period is longer than today's 30 days.
 */
export function freeDaysLeft(trialEndsAt: string, now: number = Date.now()): number {
  return Math.max(1, daysBetween(dayKey(now), dayKey(Date.parse(trialEndsAt))));
}
