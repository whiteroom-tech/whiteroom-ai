'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { getUserProvisioning, upsertUserProvisioning } from '@/lib/users';
import { Onboarding } from './onboarding';
import { posthog, initAnalytics } from '@/lib/analytics';
import { registerAgent, tokenLogin } from '@/lib/whiteroom/client';
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
      let apiKey = provisioning.apiKey;
      let fleetToken = provisioning.fleetToken;
      let isNew = false;

      if (!apiKey) {
        apiKey = generateApiKey();
        try {
          const res = await registerAgent(fleetId, apiKey);
          if (res.error) {
            setProvisionError(`Fleet provisioning failed: ${res.error}`);
          } else {
            fleetToken = res.fleetToken || null;
          }
        } catch (err) {
          setProvisionError(`Fleet provisioning failed: ${err instanceof Error ? err.message : 'network error'}`);
        }

        await upsertUserProvisioning({ apiKey, fleetId, fleetToken });
        isNew = true;
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
