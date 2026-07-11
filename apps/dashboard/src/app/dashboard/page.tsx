'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Onboarding } from './onboarding';
import { posthog, initAnalytics } from '@/lib/analytics';

const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL || 'https://proxy.whiteroom.tech';

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

async function provisionFleet(apiKey: string, fleetId: string) {
  const res = await fetch(`${PROXY_URL}/api/white-room`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ action: 'register_agent', fleet_id: fleetId, agent_id: 'setup-agent', agent_role: 'worker' }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return res.json();
}

// Report via fleet token — the token is scoped to this fleet regardless of
// which API key the fleet is bound to on the proxy side.
async function getFleetReport(fleetToken: string) {
  const res = await fetch(`${PROXY_URL}/api/white-room`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'token_login', fleet_token: fleetToken }),
  });
  return res.json();
}

export default function DashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [props, setProps] = useState<{
    name: string; email: string; apiKey: string; fleetId: string;
    fleetToken: string | null; report: Record<string, unknown> | null; isNew: boolean;
  } | null>(null);

  useEffect(() => {
    const supabase = createClient();

    // getSession reads the cached local session (no network) so returning
    // users render instantly; the fleet report fills in when it arrives.
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const user = session?.user;
      if (!user) { router.push('/sign-in'); return; }

      const email = user.email || '';
      const name = user.user_metadata?.full_name || email.split('@')[0];
      const fleetId = emailToFleetId(email);

      let apiKey = user.user_metadata?.whiteroom_api_key;
      let fleetToken = user.user_metadata?.whiteroom_fleet_token || null;
      let isNew = false;

      if (!apiKey) {
        apiKey = generateApiKey();
        try {
          const res = await provisionFleet(apiKey, fleetId);
          if (res.error) {
            setProvisionError(`Fleet provisioning failed: ${res.error}`);
          } else {
            fleetToken = res.fleetToken || null;
          }
        } catch (err) {
          setProvisionError(`Fleet provisioning failed: ${err instanceof Error ? err.message : 'network error'}`);
        }

        await supabase.auth.updateUser({
          data: { whiteroom_api_key: apiKey, whiteroom_fleet_id: fleetId, whiteroom_fleet_token: fleetToken },
        });
        isNew = true;
      }

      setProps({ name, email, apiKey, fleetId, fleetToken, report: null, isNew });
      setLoading(false);

      initAnalytics();
      posthog.identify(user.id, { email });
      posthog.capture(isNew ? 'sign_up' : 'signed_in', { fleet_id: fleetId });

      if (!isNew && fleetToken) {
        try {
          const r = await getFleetReport(fleetToken);
          if (r.success && r.report) {
            setProps((prev) => (prev ? { ...prev, report: r.report } : prev));
          }
        } catch {}
      }
    });
  }, [router]);

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
