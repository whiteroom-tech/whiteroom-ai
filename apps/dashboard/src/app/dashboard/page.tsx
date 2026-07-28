'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { getUserFleets, removeUserFleet } from '@/lib/user-fleets';
import { Onboarding } from './onboarding';
import { posthog, initAnalytics } from '@/lib/analytics';

const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL || 'https://proxy.whiteroom.tech';

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
    name: string; email: string; fleetId: string;
    fleetToken: string | null; report: Record<string, unknown> | null; isNew: boolean;
  } | null>(null);

  useEffect(() => {
    const supabase = createClient();

    async function handleUser(user: NonNullable<Awaited<ReturnType<typeof supabase.auth.getUser>>['data']['user']>) {
      const email = user.email || '';
      const name = user.user_metadata?.full_name || email.split('@')[0];

      initAnalytics();
      posthog.identify(user.id, { email });

      const userFleets = await getUserFleets();

      let validFleet: typeof userFleets[0] | null = null;
      let validReport: Record<string, unknown> | null = null;
      for (const fleet of userFleets) {
        try {
          const r = await getFleetReport(fleet.fleet_token);
          if (r.success && r.report) {
            validFleet = fleet;
            validReport = r.report;
            break;
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
