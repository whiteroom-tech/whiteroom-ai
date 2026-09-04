'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { getUserProvisioning, upsertUserProvisioning } from '@/lib/users';
import { Onboarding } from './onboarding';
import { posthog, initAnalytics } from '@/lib/analytics';
import { createFleet, tokenLogin, fleetProvisioned } from '@/lib/whiteroom/client';
import type { FleetReport } from '@/lib/whiteroom/types';

function generateApiKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let key = 'sk-wr-';
  for (let i = 0; i < 40; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
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
    fleetToken: string | null; report: FleetReport | null; isNew: boolean;
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
      const fleetId = emailToFleetId(email);

      const provisioning = await getUserProvisioning();
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

      setProps({ name, email, apiKey, fleetId, fleetToken, report: null, isNew });
      setLoading(false);

      initAnalytics();
      posthog.identify(user.id, { email });
      posthog.capture(isNew ? 'sign_up' : 'signed_in', { fleet_id: fleetId });

      if (!isNew && fleetToken) {
        try {
          const r = await tokenLogin(fleetToken);
          if (r.success && r.report) {
            const report = r.report;
            setProps((prev) => (prev ? { ...prev, report } : prev));
          }
        } catch {}
      }
    }

    handleUser(session.user);
  }, [status, session, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#070B14' }}>
        <p className="text-sm font-mono" style={{ color: '#6B7C9E' }}>Loading dashboard...</p>
      </div>
    );
  }

  if (provisionError) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#070B14' }}>
        <div className="text-center space-y-4" style={{ maxWidth: 400 }}>
          <p className="text-sm font-mono" style={{ color: '#ef4444' }}>{provisionError}</p>
          <button
            onClick={() => { setProvisionError(null); setLoading(true); window.location.reload(); }}
            className="px-6 py-2 rounded-lg text-sm font-semibold cursor-pointer"
            style={{ background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155' }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!props) return null;

  return <Onboarding {...props} />;
}
