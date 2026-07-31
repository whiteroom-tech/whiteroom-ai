'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { getUserFleets, removeUserFleet } from '@/lib/user-fleets';
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
  const [loading, setLoading] = useState(true);
  const [props, setProps] = useState<{
    name: string; email: string; apiKey: string; fleetId: string;
    fleetToken: string | null; report: FleetReport | null; isNew: boolean;
  } | null>(null);

  useEffect(() => {
    const supabase = createClient();

    async function handleUser(user: NonNullable<Awaited<ReturnType<typeof supabase.auth.getUser>>['data']['user']>) {
      const email = user.email || '';
      const name = user.user_metadata?.full_name || email.split('@')[0];
      const fleetId = emailToFleetId(email);

      let apiKey = user.user_metadata?.whiteroom_api_key;
      let fleetToken = user.user_metadata?.whiteroom_fleet_token || null;
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

        await supabase.auth.updateUser({
          data: { whiteroom_api_key: apiKey, whiteroom_fleet_id: fleetId, whiteroom_fleet_token: fleetToken },
        });
        isNew = true;
      }

      setProps({ name, email, apiKey, fleetId, fleetToken, report: null, isNew });
      setLoading(false);

      initAnalytics();
      posthog.identify(user.id, { email });

      const userFleets = await getUserFleets();

      let validFleet: typeof userFleets[0] | null = null;
      let validReport: Record<string, unknown> | null = null;
      for (const fleet of userFleets) {
        try {
          const r = await tokenLogin(fleetToken);
          if (r.success && r.report) {
            const report = r.report;
            setProps((prev) => (prev ? { ...prev, report } : prev));
          }
          await removeUserFleet(fleet.id);
        } catch {
          await removeUserFleet(fleet.id);
        }
      }

      if (!validFleet) {
        localStorage.removeItem('wr_fleet_token');
        posthog.capture('signed_in', { fleet_id: null });
        setProps({ name, email, fleetId: '', fleetToken: null, report: null, isNew: true });
        setLoading(false);
        return;
      }

      const fleetToken = validFleet.fleet_token;
      const fleetId = validFleet.fleet_id || '';
      localStorage.setItem('wr_fleet_token', fleetToken);

      posthog.capture('signed_in', { fleet_id: fleetId });
      setProps({ name, email, fleetId, fleetToken, report: validReport, isNew: false });
      setLoading(false);
    }

    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        handleUser(user);
      } else {
        router.push('/sign-in');
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

  if (!props) return null;

  return <Onboarding {...props} />;
}
