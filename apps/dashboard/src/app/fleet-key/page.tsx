'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { getUserProvisioning, upsertUserProvisioning } from '@/lib/users';
import { Onboarding } from './onboarding';
import { ThemedShell } from '@/components/ThemedShell';
import { AppShell } from '@/components/AppShell';
import { posthog, initAnalytics } from '@/lib/analytics';
import { createFleet, tokenLogin, fleetProvisioned, registerAgent, claimFleet } from '@/lib/whiteroom/client';

function generateApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return 'sk-wr-' + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function emailToFleetId(email: string) {
  return email.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
}

export default function DashboardPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [loading, setLoading] = useState(true);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [props, setProps] = useState<{
    name: string; email: string; apiKey: string; fleetId: string;
    fleetToken: string | null; isNew: boolean;
  } | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (status === 'loading') return;
    if (status === 'unauthenticated') {
      router.push('/sign-in');
      return;
    }
    if (started.current || !session?.user) return;
    started.current = true;

    async function handleUser(user: NonNullable<typeof session>['user']) {
      const email = user.email || '';
      const name = user.name || email.split('@')[0];
      const provisioning = await getUserProvisioning();
      // The fleet is fixed once provisioned. Deriving it from the email on
      // every load meant an email change silently provisioned a new, empty
      // fleet and revoked the old one's entitlement (audit F11).
      let fleetId = provisioning.fleetId ?? emailToFleetId(email);
      const isNew = !provisioning.apiKey;
      const apiKey = provisioning.apiKey ?? generateApiKey();
      let fleetToken = provisioning.fleetToken;

      // Assert the fleet on EVERY load, not just the first sign-in.
      //
      // create_fleet is idempotent, and fleetProvisioned() explains why the
      // response has to be read by its token rather than its error field.
      //
      // Deliberately NOT register_agent: that would invent a placeholder agent
      // ("setup-agent") just to bootstrap the fleet, which then sits idle in
      // the operator's grid forever. Real agents register themselves on their
      // first proxied call.
      //
      // Calling it unconditionally is what makes this self-healing: if the
      // fleet disappears from under us — data loss, a database migration, or
      // an engine outage during someone's first sign-in — it gets recreated
      // instead of leaving the account permanently stuck on "Fleet not found
      // or not initialized", with no code path that ever retries.
      let registered = false;
      let regError = '';
      try {
        const res = await createFleet(fleetId, apiKey);
        if (fleetProvisioned(res)) {
          fleetToken = res.fleetToken;
          registered = true;
        } else {
          regError = res.error ?? 'unknown error';
        }
      } catch (err) {
        regError = err instanceof Error ? err.message : 'network error';
      }

      // A new account whose email-derived id is already held by another key
      // (an address differing only in punctuation, or an id claimed first)
      // gets an unguessable id of its own instead of a dead end.
      if (!registered && !provisioning.fleetId) {
        const fallbackId = `${fleetId}-${crypto.randomUUID().slice(0, 8)}`;
        try {
          const res = await createFleet(fallbackId, apiKey);
          if (fleetProvisioned(res)) {
            fleetId = fallbackId;
            fleetToken = res.fleetToken;
            registered = true;
          }
        } catch { /* keep the original error */ }
      }

      // A stored fleet token authenticates even when the API key does not, so
      // only treat this as fatal when the account has no working path at all.
      if (!registered && !fleetToken) {
        setProvisionError(`Fleet provisioning failed: ${regError}`);
        setLoading(false);
        return;
      }

      // Persist only once the engine has accepted the key — the previous code
      // saved it unconditionally, which is how accounts ended up holding a key
      // the engine had never seen. Also re-sync the fleet token, which drifts
      // whenever a fleet is recreated.
      if (registered && (isNew || fleetToken !== provisioning.fleetToken)) {
        await upsertUserProvisioning({ apiKey, fleetId, fleetToken });
      }

      setProps({ name, email, apiKey, fleetId, fleetToken, isNew });
      setLoading(false);

      initAnalytics();
      posthog.identify(user.id, { email });
      posthog.capture(isNew ? 'sign_up' : 'signed_in', { fleet_id: fleetId });

      if (!isNew) {
        let needsReRegister = !fleetToken;

        if (fleetToken) {
          try {
            // Only a health check now: a token the engine no longer knows
            // means the fleet needs re-registering.
            const r = await tokenLogin(fleetToken);
            if (!(r.success && r.report)) needsReRegister = true;
          } catch {
            needsReRegister = true;
          }
        }

        if (needsReRegister) {
          try {
            const res = await registerAgent(fleetId, apiKey);
            if (res.fleetToken) {
              fleetToken = res.fleetToken;
            }
          } catch {}

          if (!fleetToken) {
            try {
              const claim = await claimFleet(fleetId, apiKey);
              if (claim.fleetToken) {
                fleetToken = claim.fleetToken;
              }
            } catch {}
          }

          if (fleetToken) {
            await upsertUserProvisioning({ apiKey, fleetId, fleetToken });
            setProps((prev) => prev ? { ...prev, fleetToken } : prev);
          }
        }
      }
    }

    void handleUser(session.user).catch(() => {
      setProvisionError('Could not load your fleet. Please reload and try again.');
      setLoading(false);
    });
  }, [status, session, router]);

  if (loading) {
    return (
      <ThemedShell className="flex items-center justify-center">
        <p className="text-sm font-mono" style={{ color: 'var(--tx2)' }}>Loading dashboard...</p>
      </ThemedShell>
    );
  }

  if (provisionError) {
    return (
      <ThemedShell className="flex items-center justify-center">
        <div className="text-center space-y-4" style={{ maxWidth: 400 }}>
          <p className="text-sm font-mono" style={{ color: 'var(--bad)' }}>{provisionError}</p>
          <button
            onClick={() => { setProvisionError(null); setLoading(true); window.location.reload(); }}
            className="px-6 py-2 rounded-lg text-sm font-semibold cursor-pointer"
            style={{ background: 'var(--raised)', color: 'var(--tx)', border: '1px solid var(--line2)' }}
          >
            Retry
          </button>
        </div>
      </ThemedShell>
    );
  }

  if (!props) return null;

  return (
    <AppShell>
      <Onboarding {...props} />
    </AppShell>
  );
}
