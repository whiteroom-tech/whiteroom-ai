'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { ThemeToggle } from '@/components/ThemeToggle';
import { FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';
import {
  cancelEmailChange,
  deleteAccount,
  requestEmailChange,
  signOutEverywhere,
  unlinkProvider,
  updateProfile,
  type AccountOverview,
} from '@/lib/account';
import { openBillingPortal, startCheckout } from '@/lib/billing';
import type { Entitlement } from '@/lib/entitlements';
import { PLAN_IDS, PLANS, formatPrice } from '@/lib/plans';

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  email: 'Email link',
};

type Banner = { tone: 'ok' | 'bad'; text: string } | null;

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
  return (
    <section
      style={{
        background: 'var(--card)',
        border: `1px solid ${tone === 'danger' ? 'var(--bad-line, var(--bad))' : 'var(--line)'}`,
        borderRadius: 10,
        padding: '20px 22px',
        marginBottom: 16,
      }}
    >
      <h2
        style={{
          fontFamily: FONT_DISPLAY,
          fontSize: 16,
          fontWeight: 700,
          color: tone === 'danger' ? 'var(--bad)' : 'var(--tx)',
          margin: 0,
        }}
      >
        {title}
      </h2>
      {description && (
        <p style={{ fontSize: 13.5, color: 'var(--tx2)', margin: '6px 0 0', maxWidth: '62ch' }}>{description}</p>
      )}
      <div style={{ marginTop: 18 }}>{children}</div>
    </section>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--tx3)',
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--sunk)',
  border: '1px solid var(--line)',
  borderRadius: 7,
  padding: '9px 11px',
  color: 'var(--tx)',
  fontSize: 14,
  fontFamily: 'inherit',
};

function button(variant: 'primary' | 'ghost' | 'danger', disabled = false): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: 13.5,
    fontWeight: 600,
    padding: '8px 15px',
    borderRadius: 7,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  };
  if (variant === 'primary') {
    return { ...base, background: 'var(--brand)', color: 'var(--bg)', border: '1px solid var(--brand)' };
  }
  if (variant === 'danger') {
    return { ...base, background: 'transparent', color: 'var(--bad)', border: '1px solid var(--bad)' };
  }
  return { ...base, background: 'transparent', color: 'var(--tx2)', border: '1px solid var(--line2)' };
}

export function SettingsView({
  account,
  entitlement,
  billingResult,
}: {
  account: AccountOverview;
  entitlement: Entitlement;
  billingResult: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [banner, setBanner] = useState<Banner>(
    billingResult === 'success'
      ? { tone: 'ok', text: 'Subscription active. It can take a moment for new limits to reach your fleets.' }
      : billingResult === 'cancelled'
        ? { tone: 'bad', text: 'Checkout cancelled — nothing was charged.' }
        : null,
  );

  useEffect(() => {
    const stored = localStorage.getItem('wr_theme');
    if (stored === 'light' || stored === 'dark') {
      document.querySelector('.wr-shell')?.setAttribute('data-theme', stored);
    }
  }, []);

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
    <div className="wr-shell" style={{ display: 'flex', height: '100vh', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <Sidebar />
      <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg)', color: 'var(--tx)' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', padding: '26px 24px 80px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
            <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 700, margin: 0 }}>Settings</h1>
            <ThemeToggle />
          </div>

          {banner && (
            <div
              role="status"
              style={{
                background: banner.tone === 'ok' ? 'var(--ok-bg)' : 'var(--bad-bg)',
                color: banner.tone === 'ok' ? 'var(--ok)' : 'var(--bad)',
                border: `1px solid ${banner.tone === 'ok' ? 'var(--ok)' : 'var(--bad)'}`,
                borderRadius: 8,
                padding: '10px 14px',
                fontSize: 13.5,
                marginBottom: 16,
              }}
            >
              {banner.text}
            </div>
          )}

          <ProfileSection account={account} pending={pending} run={run} />
          <PlanSection entitlement={entitlement} setBanner={setBanner} pending={pending} />
          <EmailSection account={account} pending={pending} run={run} />
          <MethodsSection account={account} pending={pending} run={run} />
          <SessionsSection pending={pending} />
          <DangerSection account={account} pending={pending} />
        </div>
      </main>
    </div>
  );
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
    <Section title="Profile" description="How you appear across the dashboard.">
      <div style={{ display: 'grid', gap: 16 }}>
        <div>
          <label htmlFor="name" style={labelStyle}>Display name</label>
          <input id="name" style={inputStyle} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="tz" style={labelStyle}>Timezone</label>
          <select id="tz" style={inputStyle} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            <option value="">Use my browser&apos;s timezone</option>
            {options.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        </div>
        <div>
          <button
            style={button('primary', pending || !dirty)}
            disabled={pending || !dirty}
            onClick={() => run(() => updateProfile({ name, timezone: timezone || null }), 'Profile saved.')}
          >
            Save profile
          </button>
        </div>
      </div>
    </Section>
  );
}

// -- Plan & billing --

function PlanSection({
  entitlement,
  setBanner,
  pending,
}: {
  entitlement: Entitlement;
  setBanner: (b: Banner) => void;
  pending: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const { plan, limits, usage, subscription } = entitlement;

  async function go(action: () => Promise<{ ok: boolean; url?: string; error?: string }>, key: string) {
    setBusy(key);
    try {
      const res = await action();
      // Stripe's hosted pages are a full navigation, not a fetch — assigning
      // location is the handoff.
      if (res.ok && res.url) window.location.href = res.url;
      else setBanner({ tone: 'bad', text: res.error ?? 'Could not reach Stripe.' });
    } catch (err) {
      setBanner({ tone: 'bad', text: err instanceof Error ? err.message : 'Could not reach Stripe.' });
    } finally {
      setBusy(null);
    }
  }

  const fleetsAtLimit = usage.fleets >= limits.maxFleets;

  return (
    <Section title="Plan" description="What your subscription currently allows. Limits apply to every fleet on the account.">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          paddingBottom: 16,
          borderBottom: '1px solid var(--line)',
          marginBottom: 16,
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ fontFamily: FONT_DISPLAY, fontSize: 19, fontWeight: 700 }}>{PLANS[plan].name}</span>
            {subscription?.planOverride && (
              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: 'var(--ho-bg)', color: 'var(--ho)' }}>
                comped
              </span>
            )}
            {subscription?.cancelAtPeriodEnd && (
              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: 'var(--warn-bg)', color: 'var(--warn)' }}>
                ends {subscription.currentPeriodEnd?.slice(0, 10)}
              </span>
            )}
            {subscription?.status === 'past_due' && (
              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: 'var(--bad-bg)', color: 'var(--bad)' }}>
                payment failed
              </span>
            )}
          </div>
          <p style={{ fontSize: 13, color: 'var(--tx2)', margin: '4px 0 0' }}>{PLANS[plan].blurb}</p>
        </div>
        {/* Only when there's a real Stripe customer behind it. A comped account
            has a `pending_…` placeholder in that column (see setPlanOverride),
            and offering it a portal link would just produce an error. */}
        {subscription?.stripeCustomerId?.startsWith('cus_') && (
          <button style={button('ghost', busy !== null)} disabled={busy !== null} onClick={() => go(openBillingPortal, 'portal')}>
            {busy === 'portal' ? 'Opening…' : 'Manage billing'}
          </button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
        <Meter label="Fleets" used={usage.fleets} limit={limits.maxFleets} atLimit={fleetsAtLimit} />
        <Stat label="Agents per fleet" value={String(limits.maxAgentsPerFleet)} />
        <Stat label="History kept" value={`${limits.retentionDays} days`} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
        {PLAN_IDS.filter((p) => p !== 'free' && p !== plan).map((p) => (
          <div
            key={p}
            style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px', background: 'var(--sunk)' }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontFamily: FONT_DISPLAY, fontSize: 15, fontWeight: 700 }}>{PLANS[p].name}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: 'var(--tx2)' }}>
                {formatPrice(PLANS[p].priceCents)}<span style={{ color: 'var(--tx3)', fontSize: 11 }}>/mo</span>
              </span>
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 14px', display: 'grid', gap: 5 }}>
              {PLANS[p].features.map((f) => (
                <li key={f} style={{ fontSize: 12.5, color: 'var(--tx2)', display: 'flex', gap: 7 }}>
                  <span style={{ color: 'var(--brand)' }}>·</span>{f}
                </li>
              ))}
            </ul>
            <button
              style={{ ...button('primary', busy !== null || pending), width: '100%' }}
              disabled={busy !== null || pending}
              onClick={() => go(() => startCheckout(p), p)}
            >
              {busy === p ? 'Opening…' : `Switch to ${PLANS[p].name}`}
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--sunk)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ ...labelStyle, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 15, fontWeight: 600, color: 'var(--tx)' }}>{value}</div>
    </div>
  );
}

function Meter({ label, used, limit, atLimit }: { label: string; used: number; limit: number; atLimit: boolean }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div style={{ background: 'var(--sunk)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ ...labelStyle, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 15, fontWeight: 600, color: atLimit ? 'var(--warn)' : 'var(--tx)' }}>
        {used} / {limit}
      </div>
      <div style={{ height: 3, borderRadius: 99, background: 'var(--track)', marginTop: 8, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: atLimit ? 'var(--warn)' : 'var(--brand)' }} />
      </div>
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
      description="This is the address you sign in with, so a change has to be confirmed from the new inbox before it takes effect."
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 13.5, color: 'var(--tx)' }}>{account.email}</span>
        {account.emailVerified && (
          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: 'var(--ok-bg)', color: 'var(--ok)' }}>
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
          <div style={{ fontSize: 13, color: 'var(--warn)' }}>
            Waiting on confirmation at{' '}
            <span style={{ fontFamily: FONT_MONO }}>{account.pendingEmailChange.newEmail}</span>. The link expires at{' '}
            {new Date(account.pendingEmailChange.expiresAt).toLocaleTimeString()}.
          </div>
          <button
            style={button('ghost', pending)}
            disabled={pending}
            onClick={() => run(cancelEmailChange, 'Email change cancelled.')}
          >
            Cancel
          </button>
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
          <button
            style={button('ghost', pending || newEmail.trim().length === 0)}
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
          </button>
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
    <Section title="Sign-in methods" description="Ways you can get into this account. At least one has to stay.">
      <div style={{ display: 'grid', gap: 1, background: 'var(--line)', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
        {account.methods.map((m) => (
          <div
            key={m.id}
            style={{
              background: 'var(--sunk)',
              padding: '13px 15px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                {PROVIDER_LABELS[m.provider] ?? m.provider}
                {/* Several rows can share a provider — two Google accounts on
                    one user is a real shape in production — so the account
                    reference below is what tells them apart. */}
                {account.methods.filter((o) => o.provider === m.provider).length > 1 && (
                  <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--tx3)', marginLeft: 6 }}>
                    account {account.methods.filter((o) => o.provider === m.provider).findIndex((o) => o.id === m.id) + 1}
                  </span>
                )}
              </div>
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11.5,
                  color: 'var(--tx3)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {m.accountRef}
              </div>
            </div>
            {m.canUnlink ? (
              <button
                style={button('ghost', pending)}
                disabled={pending}
                onClick={() => run(() => unlinkProvider(m.id), `${PROVIDER_LABELS[m.provider] ?? m.provider} unlinked.`)}
              >
                Unlink
              </button>
            ) : (
              <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>
                {m.provider === 'email' ? 'Always available' : 'Only method'}
              </span>
            )}
          </div>
        ))}
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
      description="Signs you out on every device, including this one. Use it if you've signed in somewhere you no longer control."
    >
      <button
        style={button('ghost', pending || busy)}
        disabled={pending || busy}
        onClick={() => {
          setBusy(true);
          // Ends with a redirect to /sign-in, so there is no success state to
          // render here — the page is gone either way.
          signOutEverywhere().catch(() => setBusy(false));
        }}
      >
        {busy ? 'Signing out…' : 'Sign out everywhere'}
      </button>
    </Section>
  );
}

// -- Danger --

function DangerSection({ account, pending }: { account: AccountOverview; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const matches = confirm.trim().toLowerCase() === (account.email ?? '').toLowerCase();

  return (
    <Section
      title="Delete account"
      tone="danger"
      description="Removes your profile, linked fleets and subscription. Your fleets keep running on the engine — they belong to whoever holds the fleet token — but this dashboard will no longer know about them."
    >
      {!open ? (
        <button style={button('danger', pending)} disabled={pending} onClick={() => setOpen(true)}>
          Delete my account
        </button>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
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
          {error && <p style={{ fontSize: 13, color: 'var(--bad)', margin: 0 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              style={button('danger', !matches || busy)}
              disabled={!matches || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await deleteAccount(confirm);
                  if (!res.ok) { setError(res.error); setBusy(false); }
                } catch (err) {
                  // A NEXT_REDIRECT from the successful path also lands here;
                  // it rethrows itself, so only real failures need surfacing.
                  setError(err instanceof Error ? err.message : 'Could not delete the account.');
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Deleting…' : 'Permanently delete'}
            </button>
            <button style={button('ghost', busy)} disabled={busy} onClick={() => { setOpen(false); setConfirm(''); setError(''); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}
