'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Onboarding } from './onboarding';

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
  const [props, setProps] = useState<{
    name: string; email: string; apiKey: string; fleetId: string;
    fleetToken: string | null; report: Record<string, unknown> | null; isNew: boolean;
  } | null>(null);

  useEffect(() => {
    const supabase = createClient();

    supabase.auth.getUser().then(async ({ data: { user } }) => {
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
          const result = await provisionFleet(apiKey, fleetId);
          fleetToken = result.fleetToken || null;
        } catch {}

        await supabase.auth.updateUser({
          data: { whiteroom_api_key: apiKey, whiteroom_fleet_id: fleetId, whiteroom_fleet_token: fleetToken },
        });
        isNew = true;
      }

      let report = null;
      if (!isNew && fleetToken) {
        try {
          const r = await getFleetReport(fleetToken);
          if (r.success && r.report) report = r.report;
        } catch {}
      }

      setProps({ name, email, apiKey, fleetId, fleetToken, report, isNew });
      setLoading(false);
    });
  }, [router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#070B14' }}>
        <p className="text-sm font-mono" style={{ color: '#6B7C9E' }}>Loading dashboard...</p>
      </div>
    );
  }

  if (!props) return null;

  return <Onboarding {...props} />;
}
