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
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { AppShell } from '@/components/AppShell';
import { TextSizeControl } from '@/components/TextSizeControl';
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
import { AUDIT_KEPT, PLANS, TRIAL_DAYS, hasLiveSubscription, type PlanId } from '@/lib/plans';
import { agentsIncluded, monthShareLine } from '@/lib/metric-display';
import { getMonthSavings } from '@/lib/plan-savings';
import { CLOSE_WINDOW_DAYS, isClosingOpen, SUPPORT_EMAIL, type ClosingState } from '@/lib/closing-shared';
import { BlockedFix, CLOSING_CHANGED, closingMessage, SupportLink } from '@/components/AccountClosingBanner';
import { plural, DAY_MS } from '@/lib/format';

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  email: 'Email link',
};

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
  return <SettingsCard id={id} title={tone === 'danger' ? <span style={{ color: 'var(--bad)' }}>{title}</span> : title} sub={description} tone={tone}>{children}</SettingsCard>;
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
  samples?: { data?: DataSettings; smaller?: CompressionPreview; alerts?: AlertsStatus; audit?: AuditIntegrity };
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
    <AppShell>
      <SettingsHeader email={account.email} />
      <main style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <div ref={sections} className="wr-settings-stack wr-setup-page">
          <PageLead>Profile, plan, data, alerts and sign-in.</PageLead>

          {banner && (
            <Banner variant={banner.tone === 'ok' ? 'info' : 'error'} icon={banner.tone === 'ok' ? 'check' : undefined} actions={banner.support ? <SupportLink /> : undefined}>{banner.text}</Banner>
          )}

          <ProfileSection account={account} pending={pending} run={run} />
          <div id="plan"><PlanSection entitlement={entitlement} purchasablePlans={purchasablePlans} setBanner={setBanner} pending={pending} /></div>
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
  // After mount: the server's zone isn't the viewer's, and rendering it would mismatch hydration.
  useEffect(() => { setBrowserZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'your local zone'); }, []);

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
      {/* M15: dashboard dates follow the browser whatever is picked here; say exactly that. */}
      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: '10px 0 14px' }}>
        Saved with your profile. For now, dates use this browser&apos;s time zone ({browserZone}).
      </p>
      {/* Applies at once and lives in this browser; Save profile doesn't change it. */}
      <div style={labelStyle}>Text size</div>
      <div style={{ marginBottom: 18 }}><TextSizeControl /></div>
      <Button
        disabled={pending || !dirty}
        onClick={() => run(() => updateProfile({ name, timezone: timezone || null }), 'Profile saved.')}
      >
        Save profile
      </Button>
    </Section>
  );
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
}: {
  entitlement: Entitlement;
  purchasablePlans: PlanId[];
  setBanner: (b: Notice) => void;
  pending: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const { plan, limits, usage, subscription } = entitlement;
  const agents = agentsIncluded(plan, usage.agents);
  // This month's savings in cents: null while loading or unreadable ("—"
  // shown). Only fetched once the free period is over.
  const [monthShare, setMonthShare] = useState<number | null>(null);
  // Not on a comped plan: nothing is billed there.
  const showsShare = !entitlement.onTrial && PLANS[plan].pricing !== null && !subscription?.planOverride;
  useEffect(() => {
    if (!showsShare) return;
    let live = true;
    getMonthSavings().then((r) => { if (live) setMonthShare(r?.savedCents ?? null); }, () => { if (live) setMonthShare(null); });
    return () => { live = false; };
  }, [showsShare]);

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
  const canBuy = (p: PlanId) => purchasablePlans.includes(p) && (p !== plan || entitlement.onTrial);
  const trialEnd = shortDay(entitlement.trialEndsAt);
  // ceil so an active trial never reads "0 days left"; capped because a DST
  // shift inside the window can push a fresh trial to its length and an hour.
  const trialDaysLeft = Math.min(TRIAL_DAYS, Math.max(1, Math.ceil((Date.parse(entitlement.trialEndsAt) - Date.now()) / DAY_MS)));

  return (
    <Section title="Plan" description="Limits apply to every fleet on the account">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 'var(--fs-card)', fontWeight: 600 }}>{PLANS[plan].name}</strong>
            {entitlement.onTrial && <span className="wr-settings-pill" data-tone="ok">free · {trialDaysLeft} {plural(trialDaysLeft, 'day')} left</span>}
            {subscription?.planOverride && <span className="wr-settings-pill" data-tone="ok">comped</span>}
            {subscription?.cancelAtPeriodEnd && <span className="wr-settings-pill" data-tone="warn">ends {subscription.currentPeriodEnd ? shortDay(subscription.currentPeriodEnd) : ''}</span>}
            {subscription?.status === 'past_due' && <span className="wr-settings-pill" data-tone="bad">payment failed</span>}
          </div>
          <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: '4px 0 0' }}>{PLANS[plan].blurb}</p>
        </div>
        {/* Only when there's a real Stripe customer behind it. A comped account
            has a `pending_…` placeholder in that column (see setPlanOverride),
            and offering it a portal link would just produce an error. */}
        {subscription?.stripeCustomerId?.startsWith('cus_') && (
          <Button variant="secondary" disabled={busy !== null} onClick={() => go(openBillingPortal, 'portal')}>
            {busy === 'portal' ? 'Opening…' : 'Manage billing'}
          </Button>
        )}
      </div>

      {showsShare && (
        <p style={{ fontSize: 'var(--fs-sm)', margin: '0 0 14px', fontVariantNumeric: 'tabular-nums' }}>{monthShareLine(plan, monthShare ?? null)}</p>
      )}
      {entitlement.onTrial && <p style={{ fontSize: 'var(--fs-sm)', margin: '0 0 14px' }}>Free until {trialEnd}</p>}

      <div className="wr-settings-stats">
        <Meter label="Fleets" used={usage.fleets} limit={limits.maxFleets} over={usage.fleets > limits.maxFleets ? `${usage.fleets - limits.maxFleets} over the ${PLANS[plan].name} limit` : undefined} />
        {/* Live registered agents, never 0 when the engine can't be reached (M16).
            The plan's agent count is soft: going over it stops nothing. */}
        {agents ? (
          <div className="wr-settings-stat" data-warn={agents.over ? '' : undefined}>
            <div className="wr-settings-stat__label">Agents</div>
            <div className="wr-settings-stat__num">{agents.value}</div>
            {agents.over && (
              <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--tx2)' }}>
                Nothing stops · <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: 'inherit' }}>Talk to us about larger fleets</a>
              </div>
            )}
          </div>
        ) : usage.agents !== null && plan === 'expired' ? (
          <Meter label="Agents" used={usage.agents} limit={limits.maxAgentsPerFleet} over={usage.agents > limits.maxAgentsPerFleet ? `${usage.agents - limits.maxAgentsPerFleet} over the ${PLANS[plan].name} limit` : undefined} />
        ) : (
          <Stat label="Agents registered" value={usage.agents === null ? 'Unavailable' : String(usage.agents)} />
        )}
        <Stat label="History kept" value={`${limits.retentionDays} days`} />
      </div>
      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: '12px 0 16px' }}>
        History means calls and runs. The audit trail is kept for {AUDIT_KEPT}.
      </p>

      <div className="wr-settings-plans">
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
                onClick={() => go(() => (subscribed ? openBillingPortal() : startCheckout(p)), p)}
              >
                {busy === p
                  ? 'Opening…'
                  : p === 'starter' && entitlement.onTrial
                    ? `Subscribe (free until ${trialEnd})`
                    : `Switch to ${PLANS[p].name}`}
              </Button>
            )}
          </div>
        ))}
      </div>
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
            {new Date(account.pendingEmailChange.expiresAt).toLocaleTimeString()}.
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
  const [timeZone, setTimeZone] = useState<string | undefined>('UTC');
  useEffect(() => { setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'); }, []);
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
