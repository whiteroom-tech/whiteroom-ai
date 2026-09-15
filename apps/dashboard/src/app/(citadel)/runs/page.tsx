'use client';

import { useEffect, useState, useCallback } from 'react';
import { clearFleetCredentials } from '@/lib/fleet-credentials';
import { claimFleet, listFleets, tokenLogin, performanceIndex, performanceFleetHourly } from '@/lib/whiteroom/client';
import { resolveAuthKey, isApiKey } from '@/lib/fleet-helpers';
import { ThemeToggle } from '@/components/ThemeToggle';
import type { PerformanceIndexResult, FleetHourlyResult, FleetHourlyDataPoint, PerformanceModelSummary } from '@/lib/whiteroom/types';
import { Logo, FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';

const CARD: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 20, marginBottom: 24 };
const H3: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: 'var(--tx)', marginBottom: 12, margin: 0 };

function fmtCost(micros: number): string {
  if (micros === 0) return '$0.00';
  const d = micros / 1_000_000;
  return d < 0.01 ? `$${d.toFixed(4)}` : d < 1 ? `$${d.toFixed(3)}` : `$${d.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return n < 1_000_000 ? `${(n / 1000).toFixed(1)}K` : `${(n / 1_000_000).toFixed(2)}M`;
}

function FleetActivityChart({ hourly }: { hourly: FleetHourlyDataPoint[] }) {
  const maxCalls = Math.max(...hourly.map(h => h.calls), 1);
  return (
    <div style={CARD}>
      <h3 style={H3}>Fleet Activity</h3>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 140 }}>
        {hourly.map((h, i) => {
          const cp = (h.completeCount / maxCalls) * 100;
          const ep = (h.errorCount / maxCalls) * 100;
          const op = ((h.calls - h.completeCount - h.errorCount) / maxCalls) * 100;
          const t = new Date(h.hour);
          return (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }} title={`${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\n${h.calls} calls, ${h.completeCount} complete, ${h.errorCount} errors`}>
              {op > 0 && <div style={{ width: '100%', height: `${op}%`, background: 'var(--tx3)', opacity: 0.3 }} />}
              {ep > 0 && <div style={{ width: '100%', height: `${ep}%`, background: 'var(--warn)', opacity: 0.85 }} />}
              <div style={{ width: '100%', height: `${Math.max(cp, h.calls > 0 ? 1 : 0)}%`, background: 'var(--brand)', opacity: 0.75 }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--tx3)', marginTop: 4, fontFamily: FONT_MONO }}>
        <span>{hourly.length > 0 ? new Date(hourly[0].hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
        <span>{hourly.length > 0 ? new Date(hourly[hourly.length - 1].hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 11, color: 'var(--tx3)' }}>
        {[['var(--brand)', 0.75, 'Complete'], ['var(--warn)', 0.85, 'Errors'], ['var(--tx3)', 0.3, 'Other']].map(([bg, op, label]) => (
          <span key={label as string}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: bg as string, opacity: op as number, marginRight: 4 }} />{label as string}</span>
        ))}
      </div>
    </div>
  );
}

function CostDonut({ models }: { models: PerformanceModelSummary[] }) {
  const total = models.reduce((s, m) => s + m.costMicros, 0);
  if (total === 0) return null;
  const colors = ['var(--brand)', 'var(--ok)', 'var(--warn)', 'var(--ho)', 'var(--info)', 'var(--bad)'];
  const sz = 140, cx = sz / 2, cy = sz / 2, r = 52, sw = 14;
  let cum = 0;
  const arcs = models.map((m, i) => {
    const pct = m.costMicros / total;
    const sa = cum * 2 * Math.PI - Math.PI / 2;
    cum += pct;
    const ea = cum * 2 * Math.PI - Math.PI / 2;
    const d = pct >= 0.999
      ? `M ${cx + r},${cy} A ${r},${r} 0 1,1 ${cx - r},${cy} A ${r},${r} 0 1,1 ${cx + r},${cy}`
      : `M ${cx + r * Math.cos(sa)},${cy + r * Math.sin(sa)} A ${r},${r} 0 ${pct > 0.5 ? 1 : 0},1 ${cx + r * Math.cos(ea)},${cy + r * Math.sin(ea)}`;
    return { d, color: colors[i % colors.length], model: m, pct };
  });

  return (
    <div style={CARD}>
      <h3 style={H3}>Cost Breakdown</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
        <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
          {arcs.map((a, i) => <path key={i} d={a.d} fill="none" stroke={a.color} strokeWidth={sw} strokeLinecap="butt" />)}
          <text x={cx} y={cy - 4} textAnchor="middle" fill="var(--tx)" fontSize="16" fontWeight="700" fontFamily={FONT_MONO}>{fmtCost(total)}</text>
          <text x={cx} y={cy + 12} textAnchor="middle" fill="var(--tx3)" fontSize="10">total</text>
        </svg>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {arcs.map((a, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: a.color, flexShrink: 0 }} />
              <span style={{ color: 'var(--tx2)', minWidth: 60 }}>{a.model.provider}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx)' }}>{a.model.model ?? 'unknown'}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx3)', marginLeft: 'auto' }}>{(a.pct * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function RunsPage() {
  const [fleetId, setFleetId] = useState<string | null>(() => typeof window !== 'undefined' ? localStorage.getItem('wr_fleet') : null);
  const [fleetToken, setFleetToken] = useState<string | null>(() => typeof window !== 'undefined' ? (localStorage.getItem('wr_fleet_token') || localStorage.getItem('wr_token')) : null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loginToken, setLoginToken] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const [hoursBack, setHoursBack] = useState(168);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [indexData, setIndexData] = useState<PerformanceIndexResult | null>(null);
  const [hourlyData, setHourlyData] = useState<FleetHourlyResult | null>(null);

  const authKey = resolveAuthKey(fleetToken);

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
  }, [fleetToken, fleetId]);

  function resetSession(loginError?: string) {
    clearFleetCredentials();
    setFleetId(null);
    setFleetToken(null);
    setAuthenticated(false);
    if (loginError) setLoginError(loginError);
  }

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

  const fetchData = useCallback(async () => {
    if (!fleetId) return;
    setLoading(true);
    setError('');
    try {
      const [idx, hourly] = await Promise.all([
        performanceIndex(fleetId, hoursBack, authKey),
        performanceFleetHourly(fleetId, hoursBack * 2, authKey),
      ]);
      if (idx.error) { setError(idx.error); return; }
      setIndexData(idx);
      if (!hourly.error) setHourlyData(hourly);
    } catch {
      setError('Failed to load runs data.');
    } finally {
      setLoading(false);
    }
  }, [fleetId, hoursBack, authKey]);

  useEffect(() => {
    if (authenticated) fetchData();
  }, [authenticated, fetchData]);

  const hourly = hourlyData?.hourly ?? [];
  const mid = Math.floor(hourly.length / 2);
  const displayHourly = mid > 0 ? hourly.slice(mid) : hourly;
  const models = indexData?.summary.models ?? [];

  if (!authenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--bg)', fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div className="w-full max-w-md rounded-xl p-10 text-center" style={{ background: 'var(--card)', border: '1px solid var(--line)' }}>
          <div className="flex items-center justify-center gap-2.5 mb-1">
            <Logo width={22} height={30} gradientId="wr-l" />
            <span style={{ fontFamily: FONT_DISPLAY, fontSize: 26, fontWeight: 700, letterSpacing: 3, color: 'var(--tx)' }}>WHITE ROOM</span>
          </div>
          <p style={{ fontSize: 11.5, letterSpacing: 1, color: 'var(--tx3)', marginBottom: 32 }}>FLEET MONITORING DASHBOARD</p>

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

  return (
    <div className="flex flex-col" style={{ minWidth: 0, minHeight: 0, flex: 1 }}>
      {/* Top bar */}
      <div className="flex items-center gap-3" style={{ height: 54, flexShrink: 0, borderBottom: '1px solid var(--line)', padding: '0 20px' }}>
        <span style={{ fontSize: 14, color: 'var(--tx3)' }}>
          <b style={{ color: 'var(--tx)', fontWeight: 600 }}>Runs</b> / {fleetId}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, letterSpacing: 1, color: 'var(--info)', background: 'var(--info-bg)', border: '1px solid var(--info)', borderRadius: 4, padding: '2px 8px' }}>BETA</span>
        <span style={{ marginLeft: 'auto' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {([24, 72, 168] as const).map(h => (
            <button key={h} onClick={() => setHoursBack(h)} style={{
              fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              background: hoursBack === h ? 'var(--brand-dim)' : 'transparent',
              color: hoursBack === h ? 'var(--brand)' : 'var(--tx3)',
              border: `1px solid ${hoursBack === h ? 'var(--brand)' : 'var(--line)'}`,
            }}>{h === 24 ? '24h' : h === 72 ? '3d' : '7d'}</button>
          ))}
        </div>
        <ThemeToggle />
        <button onClick={() => resetSession()} style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tx2)', border: '1px solid var(--line2)', borderRadius: 6, padding: '6px 12px', background: 'var(--card)', cursor: 'pointer' }}>Sign out</button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24 }}>
        {error && <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bad-bg)', color: 'var(--bad)', fontSize: 13, marginBottom: 16 }}>{error}</div>}
        {loading && !indexData && <div style={{ color: 'var(--tx3)', fontSize: 14, textAlign: 'center', padding: 40 }}>Loading...</div>}

        {displayHourly.length > 0 && <FleetActivityChart hourly={displayHourly} />}

        <div style={{ display: 'grid', gridTemplateColumns: models.length > 0 ? '1fr 1fr' : '1fr', gap: 16, marginBottom: 24 }}>
          {models.length > 0 && <CostDonut models={models} />}
          {models.length > 0 && (
            <div style={CARD}>
              <h3 style={H3}>Traffic by Model</h3>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ color: 'var(--tx3)', fontWeight: 600, textAlign: 'left' }}>
                      <th style={{ padding: '6px 8px' }}>Model</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Calls</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Input</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Output</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((m, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--line)' }}>
                        <td style={{ padding: 8, fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx)' }}>{m.model ?? 'unknown'}</td>
                        <td style={{ padding: 8, textAlign: 'right', color: 'var(--tx)' }}>{m.calls.toLocaleString()}</td>
                        <td style={{ padding: 8, textAlign: 'right', fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx2)' }}>{fmtTokens(m.inputTokens)}</td>
                        <td style={{ padding: 8, textAlign: 'right', fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx2)' }}>{fmtTokens(m.outputTokens)}</td>
                        <td style={{ padding: 8, textAlign: 'right', fontFamily: FONT_MONO, fontSize: 12, color: 'var(--brand)' }}>{fmtCost(m.costMicros)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {!loading && !error && displayHourly.length === 0 && models.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--tx3)', padding: 40 }}>
            No run data yet. Connect an agent and start making API calls to see activity here.
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex justify-between" style={{ padding: '6px 20px', borderTop: '1px solid var(--line)', background: 'var(--sunk)', fontSize: 11.5, color: 'var(--tx3)', flexShrink: 0 }}>
        <span>White Room v1.1 Beta</span>
        <span>© 2026 WhiteRoom</span>
      </div>
    </div>
  );
}
