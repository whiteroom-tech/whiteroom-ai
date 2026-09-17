'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { clearFleetCredentials } from '@/lib/fleet-credentials';
import { claimFleet, fleetReport, listFleets, tokenLogin, pauseAgent as pauseAgentApi } from '@/lib/whiteroom/client';
import { resolveAuthKey, isApiKey } from '@/lib/fleet-helpers';
import { Sidebar } from '@/components/Sidebar';
import { ThemeToggle } from '@/components/ThemeToggle';
import { OverviewContent } from '@/components/citadel/OverviewContent';
import { UsageSavingsSection } from '@/components/citadel/UsageSavingsSection';
import type { FleetReport } from '@/lib/whiteroom/types';
import { Logo, FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';

export default function FleetDashboard() {
  useEffect(() => {
    const stored = localStorage.getItem('wr_theme');
    if (stored === 'light' || stored === 'dark') {
      document.querySelector('.wr-shell')?.setAttribute('data-theme', stored);
    }
  }, []);

  const [report, setReport] = useState<FleetReport | null>(null);
  const [error, setError] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [loginToken, setLoginToken] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab') === 'analytics' ? 'analytics' : searchParams.get('tab') === 'visualization' ? 'visualization' : 'live';
  const [activeTab, setActiveTab] = useState<'live' | 'analytics' | 'visualization'>(tabParam);

  useEffect(() => { setActiveTab(tabParam); }, [tabParam]);

  const [fleetId, setFleetId] = useState<string | null>(() => typeof window !== 'undefined' ? localStorage.getItem('wr_fleet') : null);
  const [fleetToken, setFleetToken] = useState<string | null>(() => typeof window !== 'undefined' ? (localStorage.getItem('wr_fleet_token') || localStorage.getItem('wr_token')) : null);

  const authKey = resolveAuthKey(fleetToken);

  async function handleFleetLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError('');
    setLoginLoading(true);
    try {
      const apiKeyLogin = isApiKey(loginToken);
      let resolvedFleetId: string;
      let resolvedFleetToken: string;

      if (apiKeyLogin) {
        const listData = await listFleets(loginToken);
        const fleets = listData.fleets ?? [];
        if (!fleets.length) {
          setLoginError('No fleets found for this API key. Register an agent first.');
          return;
        }
        resolvedFleetId = fleets[0].fleetId;
        const claim = await claimFleet(resolvedFleetId, loginToken);
        if (claim.error || !claim.fleetToken) {
          setLoginError(claim.error || 'Could not retrieve fleet token.');
          return;
        }
        resolvedFleetToken = claim.fleetToken;
      } else {
        const data = await tokenLogin(loginToken);
        if (data.error) {
          setLoginError(data.error);
          return;
        }
        resolvedFleetId = data.fleetId ?? '';
        resolvedFleetToken = loginToken;
      }

      clearFleetCredentials();
      localStorage.setItem('wr_fleet', resolvedFleetId);
      localStorage.setItem('wr_fleet_token', resolvedFleetToken);
      setFleetId(resolvedFleetId);
      setFleetToken(resolvedFleetToken);
      setAuthenticated(true);
      window.location.reload();
    } catch {
      setLoginError('Could not connect to WhiteRoom server');
    } finally {
      setLoginLoading(false);
    }
  }

  const fetchReport = useCallback(async () => {
    if (!fleetId) return;
    try {
      const data = await fleetReport(fleetId, authKey);
      if (data.error) {
        if (data.error.toLowerCase().includes('unauthorized') || data.error.toLowerCase().includes('invalid')) {
          resetSession(data.error);
        } else {
          setError(data.error);
        }
        return;
      }
      setReport(data);
    } catch { setError('Connection lost'); }
  }, [fleetId, authKey]);

  const handleStopAll = useCallback(async () => {
    if (!fleetId || !report) return;
    const working = report.status.working || [];
    await Promise.all(working.map((id: string) => pauseAgentApi(fleetId, id, authKey)));
    await fetchReport();
  }, [fleetId, report, authKey, fetchReport]);

  useEffect(() => {
    if (!fleetToken) { setAuthenticated(false); return; }

    if (!fleetId && fleetToken) {
      tokenLogin(fleetToken).then(data => {
        if (data.fleetId) {
          localStorage.setItem('wr_fleet', data.fleetId);
          window.location.reload();
        } else {
          resetSession('Fleet token invalid. Please enter your API key.');
        }
      }).catch(() => { resetSession(); });
      return;
    }

    setAuthenticated(true);
    fetchReport();
    const interval = setInterval(fetchReport, 10000);
    return () => clearInterval(interval);
  }, [fleetToken, fetchReport]);

  function resetSession(loginError?: string) {
    clearFleetCredentials();
    setFleetId(null);
    setFleetToken(null);
    setAuthenticated(false);
    if (loginError) setLoginError(loginError);
  }

  if (!authenticated) {
    return (
      <div className="wr-shell min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--bg)', fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div className="w-full max-w-md rounded-xl p-10 text-center" style={{ background: 'var(--card)', border: '1px solid var(--line)' }}>
          <div className="flex items-center justify-center gap-2.5 mb-1">
            <Logo width={22} height={30} gradientId="wr-l" />
            <span style={{ fontFamily: FONT_DISPLAY, fontSize: 26, fontWeight: 700, letterSpacing: 3, color: 'var(--tx)' }}>WHITE ROOM</span>
          </div>
          <p style={{ fontSize: 11.5, letterSpacing: 1, color: 'var(--tx3)', marginBottom: 32 }}>MONITORING DASHBOARD</p>

          <form onSubmit={handleFleetLogin} className="space-y-4 text-left">
            <div>
              <label htmlFor="fleet-token" style={{ display: 'block', fontSize: 11.5, color: 'var(--tx3)', marginBottom: 8, letterSpacing: 1, fontFamily: FONT_MONO }}>
                YOUR API KEY OR FLEET TOKEN
              </label>
              <input
                id="fleet-token"
                type="password"
                value={loginToken}
                onChange={(e) => setLoginToken(e.target.value)}
                placeholder="wr_... or sk-ant-..."
                required
                style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 16px', color: 'var(--tx)', fontSize: 14.5, fontFamily: FONT_MONO, outline: 'none' }}
              />
            </div>

            {loginError && (
              <p style={{ color: 'var(--bad)', fontSize: 14.5 }}>{loginError}</p>
            )}

            <button
              type="submit"
              disabled={loginLoading || !loginToken}
              style={{ width: '100%', background: 'var(--brand)', color: 'var(--bg)', borderRadius: 8, padding: '12px 0', fontWeight: 700, fontSize: 15, letterSpacing: 1, fontFamily: FONT_DISPLAY, border: 'none', cursor: loginLoading || !loginToken ? 'not-allowed' : 'pointer', opacity: loginLoading || !loginToken ? 0.4 : 1, transition: 'opacity .15s' }}
            >
              {loginLoading ? 'CONNECTING...' : 'CONNECT TO MY FLEET →'}
            </button>
          </form>

          <p style={{ color: 'var(--tx3)', fontSize: 11.5, textAlign: 'center', marginTop: 24, lineHeight: 1.6 }}>
            Your key is never stored or sent to any third party.<br />
            It is used only to identify your fleet in this session.
          </p>
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="wr-shell min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <p className="text-sm font-mono" style={{ color: 'var(--tx3)' }}>{error || 'Loading fleet...'}</p>
      </div>
    );
  }

  return (
    <div className="wr-shell" style={{ background: 'var(--bg)', color: 'var(--tx)', fontFamily: "'Inter', system-ui, sans-serif", fontSize: 14.5, display: 'grid', gridTemplateColumns: '212px 1fr', gridTemplateRows: 'minmax(0, 1fr)', height: '100vh', overflow: 'hidden' }}>
      <Sidebar />

      <div className="flex flex-col" style={{ minWidth: 0, minHeight: 0 }}>
        {/* Top bar */}
        <div className="flex items-center gap-3" style={{ height: 54, flexShrink: 0, borderBottom: '1px solid var(--line)', padding: '0 20px' }}>
          <span style={{ fontSize: 14, color: 'var(--tx3)' }}>
            <b style={{ color: 'var(--tx)', fontWeight: 600 }}>Overview</b> / {report.fleetId}
          </span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, letterSpacing: 1, color: 'var(--info)', background: 'var(--info-bg)', border: '1px solid var(--info)', borderRadius: 4, padding: '2px 8px' }}>BETA</span>
          <span style={{ marginLeft: 'auto' }} />
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ok)', background: 'var(--ok-bg)', border: '1px solid var(--ok)', borderRadius: 6, padding: '5px 11px' }}>● connected</span>
          <span style={{ fontSize: 11.5, fontWeight: 600, padding: '5px 11px', borderRadius: 6, background: report.compliance.allAgentsWithinLimits ? 'var(--ok-bg)' : 'var(--bad-bg)', color: report.compliance.allAgentsWithinLimits ? 'var(--ok)' : 'var(--bad)' }}>
            {report.compliance.allAgentsWithinLimits ? 'COMPLIANT' : 'VIOLATION'}
          </span>
          {activeTab === 'live' && (report.status.working || []).length > 0 && (
            <button onClick={handleStopAll} style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--bad)', border: '1px solid var(--bad)', borderRadius: 6, padding: '5px 11px', background: 'transparent', cursor: 'pointer' }}>
              ■ Stop All
            </button>
          )}
          <ThemeToggle />
          <button onClick={() => resetSession()} style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tx2)', border: '1px solid var(--line2)', borderRadius: 6, padding: '6px 12px', background: 'var(--card)', cursor: 'pointer' }}>Sign out</button>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {activeTab === 'live' ? (
            <OverviewContent fleetId={report.fleetId} authKey={authKey} onAuthError={(msg) => resetSession(msg)} />
          ) : activeTab === 'visualization' ? (
            <OverviewContent fleetId={report.fleetId} authKey={authKey} visualizationMode onAuthError={(msg) => resetSession(msg)} />
          ) : (
            <UsageSavingsSection fleetId={report.fleetId} authKey={authKey} />
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between" style={{ padding: '6px 20px', borderTop: '1px solid var(--line)', background: 'var(--sunk)', fontSize: 11.5, color: 'var(--tx3)', flexShrink: 0 }}>
          <span>White Room v1.1 Beta</span>
          <span>© 2026 WhiteRoom</span>
        </div>
      </div>
    </div>
  );
}
