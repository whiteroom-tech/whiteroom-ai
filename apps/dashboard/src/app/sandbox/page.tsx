'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { Sidebar } from '@/components/Sidebar';
import { FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';
import {
  createSandbox,
  sandboxStatus,
  destroySandbox as destroySandboxApi,
  sandboxReport,
  pauseSandboxAgent,
  resumeSandboxAgent,
  resetSandboxSession,
  startDemo,
  sandboxHistory as fetchHistory,
  PROXY_URL,
  type CreateSandboxResult,
  type SandboxStatusResult,
  type SandboxReportResult,
  type SandboxHistoryEntry,
} from '@/lib/whiteroom/client';

type Phase = 'interstitial' | 'setup' | 'checklist' | 'go-live' | 'expired';

const ASSERTION_LABELS: Record<string, { label: string; hint: string; required: boolean }> = {
  basic_connect: { label: 'Connected', hint: 'Agent registered and first call proxied', required: true },
  watch_expiry: { label: 'Handoff created', hint: 'Watch expired and handover doc generated', required: true },
  handover_roundtrip: { label: 'Resumed after handoff', hint: 'New watch started with compressed context', required: true },
  context_compression: { label: 'Compression working', hint: 'Handover doc has compression ratio', required: false },
  compliance_gate: { label: 'Rest enforced', hint: 'Agent call rejected during mandatory rest period', required: false },
  graceful_disconnect: { label: 'Disconnect handled', hint: 'Agent went silent and watchdog recovered it', required: false },
  multi_agent_relay: { label: 'Multi-agent relay', hint: 'Paired agents handed off work to each other', required: false },
};

function AssertionIcon({ status }: { status: string }) {
  if (status === 'observed') return <span style={{ color: 'var(--ok)', fontSize: 14, fontWeight: 700 }}>✓</span>;
  if (status === 'failed') return <span style={{ color: 'var(--bad)', fontSize: 14, fontWeight: 700 }}>✗</span>;
  return <span style={{ color: 'var(--tx3)', fontSize: 14 }}>○</span>;
}

const BTN = {
  primary: { padding: '6px 14px', borderRadius: 6, background: 'var(--brand)', color: 'var(--bg)', fontWeight: 600, fontSize: 11, border: 'none', cursor: 'pointer' } as const,
  secondary: { padding: '6px 14px', borderRadius: 6, background: 'var(--card)', color: 'var(--tx2)', fontWeight: 600, fontSize: 11, border: '1px solid var(--line2)', cursor: 'pointer' } as const,
  ghost: { padding: '6px 14px', borderRadius: 6, background: 'transparent', color: 'var(--tx3)', fontWeight: 600, fontSize: 11, border: '1px solid var(--line)', cursor: 'pointer' } as const,
  success: { padding: '6px 14px', borderRadius: 6, background: 'var(--ok)', color: 'var(--bg)', fontWeight: 700, fontSize: 11, border: 'none', cursor: 'pointer' } as const,
  warn: { padding: '6px 14px', borderRadius: 6, background: 'var(--warn)', color: 'var(--bg)', fontWeight: 600, fontSize: 11, border: 'none', cursor: 'pointer' } as const,
  danger: { fontSize: 11, color: 'var(--bad)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 } as const,
};

export default function SandboxPage() {
  const { data: session } = useSession();
  const userId = session?.user?.email ?? 'anon';
  const [phase, setPhase] = useState<Phase>('interstitial');
  const [sandbox, setSandbox] = useState<CreateSandboxResult | null>(null);
  const [status, setStatus] = useState<SandboxStatusResult | null>(null);
  const [report, setReport] = useState<SandboxReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [paused, setPaused] = useState(false);
  const [demoRunning, setDemoRunning] = useState(false);
  const [history, setHistory] = useState<SandboxHistoryEntry[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startPolling = useCallback((sbxUserId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const s = await sandboxStatus(sbxUserId);
      if (s.error) return;
      setStatus(s);
      if (s.expiresInSeconds !== null && s.expiresInSeconds !== undefined && s.expiresInSeconds <= 0) {
        setPhase('expired');
        if (pollRef.current) clearInterval(pollRef.current);
      }
    }, 3000);
  }, []);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  useEffect(() => {
    async function checkExisting() {
      const s = await sandboxStatus(userId);
      if (s.success && s.sandboxId) {
        setSandbox({ success: true, sandboxId: s.sandboxId, expiresAt: s.expiresAt });
        setStatus(s);
        setPhase('checklist');
        startPolling(userId);
      }
      const h = await fetchHistory(userId);
      if (h.sessions) setHistory(h.sessions);
    }
    checkExisting();
  }, [userId, startPolling]);

  const handleCreateSandbox = async (opts: { isTrial?: boolean; apiKey?: string }) => {
    setLoading(true);
    setError('');
    const result = await createSandbox({ userId, isTrial: opts.isTrial, apiKey: opts.apiKey });
    setLoading(false);
    if (result.error) { setError(result.error); return; }
    setSandbox(result);
    setPhase('setup');
  };

  const handleDestroy = async () => {
    if (!sandbox?.sandboxId) return;
    setLoading(true);
    await destroySandboxApi(sandbox.sandboxId);
    setSandbox(null);
    setStatus(null);
    setPhase('interstitial');
    setPaused(false);
    setLoading(false);
    if (pollRef.current) clearInterval(pollRef.current);
  };

  const handleReset = async () => {
    if (!sandbox?.sandboxId) return;
    setLoading(true);
    await resetSandboxSession(sandbox.sandboxId);
    setStatus(null);
    setPaused(false);
    setPhase('checklist');
    setLoading(false);
    startPolling(userId);
  };

  const handlePause = async () => {
    if (!status?.agents?.[0]) return;
    const agent = status.agents[0];
    setLoading(true);
    await pauseSandboxAgent(sandbox!.sandboxId!, agent.agentId);
    setPaused(true);
    setLoading(false);
  };

  const handleResume = async () => {
    if (!status?.agents?.[0]) return;
    const agent = status.agents[0];
    setLoading(true);
    await resumeSandboxAgent(sandbox!.sandboxId!, agent.agentId);
    setPaused(false);
    setLoading(false);
  };

  const handleStartDemo = async () => {
    if (!sandbox?.sandboxId) return;
    setDemoRunning(true);
    const result = await startDemo(sandbox.sandboxId);
    if (result.error) setError(result.error);
    setTimeout(() => setDemoRunning(false), 20000);
  };

  const handleGoLive = () => setPhase('go-live');

  const handleExportReport = async () => {
    if (!sandbox?.sandboxId) return;
    const r = await sandboxReport(sandbox.sandboxId);
    setReport(r);
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `whiteroom-sandbox-report-${sandbox.sandboxId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrintReport = async () => {
    if (!sandbox?.sandboxId) return;
    const res = await fetch(`${PROXY_URL}/api/white-room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'test_report_html', sandbox_id: sandbox.sandboxId }),
    });
    const html = await res.text();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (w) setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const proxyUrl = sandbox?.proxyKey ? `${PROXY_URL}/${sandbox.proxyKey}` : '';
  const assertions = status?.assertionStates ?? {};
  const requiredPassed = Object.entries(assertions)
    .filter(([k]) => ASSERTION_LABELS[k]?.required)
    .every(([, v]) => v.status === 'observed');
  const expiresIn = status?.expiresInSeconds ?? null;

  return (
    <div className="wr-shell" style={{ background: 'var(--bg)', color: 'var(--tx)', fontFamily: "'Inter', system-ui, sans-serif", fontSize: 13, display: 'grid', gridTemplateColumns: '212px 1fr', gridTemplateRows: 'minmax(0, 1fr)', height: '100vh', overflow: 'hidden' }}>
      <Sidebar />

      <div className="flex flex-col" style={{ minWidth: 0, minHeight: 0 }}>
        {/* Top bar — matches fleet page */}
        <div className="flex items-center gap-3" style={{ height: 54, flexShrink: 0, borderBottom: '1px solid var(--line)', padding: '0 20px' }}>
          <span style={{ fontSize: 12.5, color: 'var(--tx3)' }}>
            <b style={{ color: 'var(--tx)', fontWeight: 600 }}>Sandbox</b>
            {sandbox?.sandboxId && <span style={{ marginLeft: 8, fontFamily: FONT_MONO, fontSize: 10, color: 'var(--tx3)' }}>/ {sandbox.sandboxId}</span>}
          </span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600, letterSpacing: 1, color: 'var(--warn)', background: 'var(--warn-bg)', border: '1px solid var(--warn-line)', borderRadius: 4, padding: '2px 8px' }}>TEST ENV</span>
          {sandbox?.isTrial && <span style={{ fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600, letterSpacing: 1, color: 'var(--info)', background: 'var(--info-bg)', border: '1px solid var(--info)', borderRadius: 4, padding: '2px 8px' }}>TRIAL</span>}
          {paused && <span style={{ fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600, letterSpacing: 1, color: 'var(--warn)', background: 'var(--warn-bg)', border: '1px solid var(--warn-line)', borderRadius: 4, padding: '2px 8px' }}>PAUSED</span>}
          <span style={{ marginLeft: 'auto' }} />
          {expiresIn !== null && expiresIn > 0 && (
            <span style={{ fontSize: 10, fontFamily: FONT_MONO, color: expiresIn < 600 ? 'var(--warn)' : 'var(--tx3)' }}>
              {Math.floor(expiresIn / 60)}m {expiresIn % 60}s remaining
            </span>
          )}
        </div>

        {paused && (
          <div style={{ padding: '10px 20px', background: 'var(--warn-bg)', borderBottom: '1px solid var(--warn-line)', fontSize: 11, color: 'var(--warn)' }}>
            Paused — your agent is receiving hold responses. Calls are not being forwarded to the LLM.
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '24px 32px' }}>
          {error && (
            <div style={{ padding: '10px 14px', background: 'var(--bad-bg)', border: '1px solid var(--bad)', borderRadius: 6, color: 'var(--bad)', fontSize: 11, marginBottom: 16 }}>{error}</div>
          )}

          {/* INTERSTITIAL */}
          {phase === 'interstitial' && (
            <div style={{ maxWidth: 440, margin: '48px auto', textAlign: 'center' }}>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 700, letterSpacing: 1.5, marginBottom: 6 }}>TEST YOUR AGENT</div>
              <p style={{ color: 'var(--tx2)', fontSize: 11.5, marginBottom: 28, lineHeight: 1.6 }}>
                Spin up a sandbox environment to validate that WhiteRoom governance works with your agent before going to production.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <button
                  onClick={() => handleCreateSandbox({ isTrial: true })}
                  disabled={loading}
                  style={{ ...BTN.primary, padding: '10px 20px', fontSize: 12, opacity: loading ? 0.5 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}
                >
                  {loading ? 'Creating...' : 'Use trial credits (no API key needed)'}
                </button>
                <div style={{ fontSize: 10, color: 'var(--tx3)', letterSpacing: 0.5 }}>or</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder="sk-ant-... or sk-..."
                    style={{ flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid var(--line2)', background: 'var(--sunk)', color: 'var(--tx)', fontSize: 11, fontFamily: FONT_MONO }}
                  />
                  <button
                    onClick={() => handleCreateSandbox({ apiKey: apiKeyInput })}
                    disabled={loading || !apiKeyInput}
                    style={{ ...BTN.secondary, opacity: loading || !apiKeyInput ? 0.4 : 1, cursor: loading || !apiKeyInput ? 'not-allowed' : 'pointer' }}
                  >
                    Use my key
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* HISTORY — shown on interstitial */}
          {phase === 'interstitial' && history.length > 0 && (
            <div style={{ maxWidth: 480, margin: '32px auto 0' }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const, marginBottom: 8 }}>Past Sessions</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {history.map(s => (
                  <div key={s.sandboxId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--card)', border: '1px solid var(--line)', fontSize: 11 }}>
                    <span style={{ width: 48, fontWeight: 700, fontSize: 10, letterSpacing: 0.5, color: s.overall === 'pass' ? 'var(--ok)' : s.overall === 'fail' ? 'var(--bad)' : 'var(--tx3)' }}>
                      {s.overall === 'pass' ? 'PASS' : s.overall === 'fail' ? 'FAIL' : 'PARTIAL'}
                    </span>
                    <span style={{ flex: 1, fontFamily: FONT_MONO, fontSize: 10, color: 'var(--tx3)' }}>{s.sandboxId.slice(0, 20)}...</span>
                    <span style={{ fontSize: 10, color: 'var(--tx3)' }}>{new Date(s.destroyedAt).toLocaleDateString()}</span>
                    <span style={{ fontSize: 10, color: 'var(--tx3)' }}>{s.totalTasks} tasks</span>
                    {s.isTrial && <span style={{ fontSize: 9, fontFamily: FONT_MONO, color: 'var(--info)', border: '1px solid var(--info)', borderRadius: 3, padding: '1px 5px' }}>TRIAL</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SETUP RAIL */}
          {phase === 'setup' && sandbox && (
            <div style={{ maxWidth: 480, margin: '36px auto' }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const, marginBottom: 16 }}>Setup</div>
              <p style={{ color: 'var(--tx2)', fontSize: 11.5, marginBottom: 18, lineHeight: 1.6 }}>
                Point your agent at this proxy URL. All LLM calls through it are governed by WhiteRoom.
              </p>
              <div style={{ background: 'var(--sunk)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 14px', fontFamily: FONT_MONO, fontSize: 11, wordBreak: 'break-all', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ flex: 1, color: 'var(--brand)' }}>{proxyUrl}/v1/messages</span>
                <button
                  onClick={() => navigator.clipboard.writeText(`${proxyUrl}/v1/messages`)}
                  style={{ ...BTN.primary, padding: '4px 10px', fontSize: 10, flexShrink: 0 }}
                >
                  Copy
                </button>
              </div>
              <button onClick={() => setShowHelp(!showHelp)} style={{ fontSize: 11, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: showHelp ? 10 : 18 }}>
                {showHelp ? '▾ Hide help' : '▸ Help me connect'}
              </button>
              {showHelp && (
                <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px', fontSize: 11, color: 'var(--tx2)', lineHeight: 1.7, marginBottom: 18 }}>
                  <p>Replace your LLM base URL with the proxy URL above. For example:</p>
                  <pre style={{ fontFamily: FONT_MONO, fontSize: 10.5, background: 'var(--sunk)', padding: 10, borderRadius: 4, overflowX: 'auto', margin: '8px 0', color: 'var(--brand)' }}>
{`ANTHROPIC_BASE_URL=${proxyUrl}`}
                  </pre>
                  <p>Your API key stays the same — WhiteRoom proxies the call through to the provider.</p>
                </div>
              )}
              <button
                onClick={() => { setPhase('checklist'); startPolling(userId); }}
                style={{ ...BTN.primary, padding: '8px 18px', fontSize: 12 }}
              >
                I&apos;m connected — start the test
              </button>
            </div>
          )}

          {/* CHECKLIST */}
          {phase === 'checklist' && (
            <div style={{ maxWidth: 520, margin: '16px auto' }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const, marginBottom: 4 }}>
                {status?.agents?.length ? 'Running Checks' : 'Listening for Connections'}
              </div>
              <p style={{ color: 'var(--tx2)', fontSize: 11, marginBottom: 18 }}>
                {status?.agents?.length ? 'Your agent is connected. Watching governance events.' : 'Start your agent and point it at the sandbox proxy URL.'}
              </p>

              <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 20 }}>
                {Object.entries(ASSERTION_LABELS).map(([key, { label, hint, required }]) => {
                  const a = assertions[key];
                  const s = a?.status ?? 'waiting';
                  return (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 6, background: 'var(--card)', border: `1px solid ${s === 'observed' ? 'var(--ok)' : s === 'failed' ? 'var(--bad)' : 'var(--line)'}`, transition: 'border-color 0.3s' }}>
                      <AssertionIcon status={s} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 11.5 }}>
                          {label}
                          {!required && <span style={{ fontSize: 9.5, color: 'var(--tx3)', marginLeft: 6, fontWeight: 500 }}>optional</span>}
                        </div>
                        <div style={{ fontSize: 10.5, color: 'var(--tx3)', marginTop: 1 }}>{hint}</div>
                        {s === 'failed' && a?.diagnostic && (
                          <div style={{ fontSize: 10.5, color: 'var(--bad)', marginTop: 3 }}>{a.diagnostic}</div>
                        )}
                        {s === 'observed' && a?.metric !== undefined && (
                          <div style={{ fontSize: 10, color: 'var(--ok)', marginTop: 2, fontFamily: FONT_MONO }}>{a.metric}% compression</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ fontSize: 10, color: 'var(--tx3)', marginBottom: 16, fontFamily: FONT_MONO }}>
                {(() => {
                  const req = Object.entries(assertions).filter(([k]) => ASSERTION_LABELS[k]?.required);
                  const reqPassed = req.filter(([, v]) => v.status === 'observed').length;
                  const opt = Object.entries(assertions).filter(([k]) => !ASSERTION_LABELS[k]?.required);
                  const optPassed = opt.filter(([, v]) => v.status === 'observed').length;
                  return `${reqPassed} of ${req.length} required · ${optPassed} of ${opt.length} optional`;
                })()}
              </div>

              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 14 }}>
                {status?.agents?.length ? (
                  paused ? (
                    <button onClick={handleResume} disabled={loading} style={BTN.primary}>Resume</button>
                  ) : (
                    <button onClick={handlePause} disabled={loading} style={BTN.warn}>Pause</button>
                  )
                ) : null}
                <button onClick={handleStartDemo} disabled={loading || demoRunning} style={demoRunning ? { ...BTN.ghost, opacity: 0.5, cursor: 'not-allowed' } : { ...BTN.secondary, background: 'var(--ho-bg)', color: 'var(--ho)', border: '1px solid var(--ho)' }}>{demoRunning ? 'Demo running...' : 'Run demo agent'}</button>
                <button onClick={handleReset} disabled={loading} style={BTN.ghost}>Start over</button>
                <button onClick={handleExportReport} style={BTN.ghost}>Export JSON</button>
                <span style={{ flex: 1 }} />
                {requiredPassed && (
                  <button onClick={handleGoLive} style={{ ...BTN.success, padding: '6px 18px' }}>Go live →</button>
                )}
              </div>

              <button onClick={handleDestroy} style={BTN.danger}>Destroy sandbox</button>
            </div>
          )}

          {/* GO LIVE */}
          {phase === 'go-live' && (
            <div style={{ maxWidth: 560, margin: '32px auto' }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: 'var(--ok)', textTransform: 'uppercase' as const, marginBottom: 4 }}>Ready for Production</div>
              <p style={{ color: 'var(--tx2)', fontSize: 11, marginBottom: 18, lineHeight: 1.6 }}>
                All required checks passed. Follow the cutover guide below to switch to production.
              </p>

              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px', marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const, marginBottom: 8 }}>Sandbox Summary</div>
                {Object.entries(assertions).map(([key, val]) => (
                  <div key={key} style={{ fontSize: 11, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                    <AssertionIcon status={val.status} />
                    <span style={{ color: 'var(--tx2)' }}>{ASSERTION_LABELS[key]?.label ?? key}</span>
                    {val.metric !== undefined && <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: 'var(--tx3)' }}>{val.metric}%</span>}
                  </div>
                ))}
              </div>

              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '16px', marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 10 }}>Cutover Guide</div>
                <ol style={{ paddingLeft: 18, fontSize: 11, color: 'var(--tx2)', lineHeight: 1.8, margin: 0 }}>
                  <li>Replace your sandbox proxy URL with the production URL:
                    <pre style={{ fontFamily: FONT_MONO, fontSize: 10, background: 'var(--sunk)', padding: 8, borderRadius: 4, overflowX: 'auto', margin: '6px 0', color: 'var(--brand)' }}>ANTHROPIC_BASE_URL={PROXY_URL}/sk-wr-YOUR_KEY/v1/messages</pre>
                  </li>
                  <li>Ensure your production API key is stored via the dashboard&apos;s BYOK setup.</li>
                  <li>Deploy your agent. WhiteRoom will auto-register it on first proxied call.</li>
                  <li>Monitor the Fleet page for the first watch cycle to confirm governance is active.</li>
                </ol>
              </div>

              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '16px', marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 10 }}>First Hour Checklist</div>
                <div style={{ fontSize: 11, color: 'var(--tx2)', lineHeight: 1.8 }}>
                  {[
                    'Agent appears on Fleet page with "working" status',
                    'First task completes and appears in audit log',
                    'Watch timer counts down correctly',
                    'Handover triggers at watch expiry',
                    'Agent resumes after rest period',
                    'Handover doc is populated with context summary',
                  ].map((item, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <span style={{ color: 'var(--tx3)', fontSize: 10, flexShrink: 0, width: 14, textAlign: 'right' as const, fontFamily: FONT_MONO }}>{i + 1}.</span>
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={handleExportReport} style={BTN.secondary}>Export JSON</button>
                <button onClick={handlePrintReport} style={BTN.secondary}>Print report</button>
                <button onClick={() => { handleDestroy(); }} style={BTN.secondary}>Close sandbox</button>
              </div>
            </div>
          )}

          {/* EXPIRED */}
          {phase === 'expired' && (
            <div style={{ maxWidth: 440, margin: '48px auto', textAlign: 'center' }}>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 16, fontWeight: 700, letterSpacing: 1.5, marginBottom: 8 }}>SANDBOX EXPIRED</div>
              <p style={{ color: 'var(--tx2)', fontSize: 11, marginBottom: 20 }}>Your sandbox session has ended. You can view your test report or create a new sandbox.</p>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                <button onClick={handleExportReport} style={BTN.primary}>View report</button>
                <button onClick={() => { setSandbox(null); setStatus(null); setPhase('interstitial'); }} style={BTN.secondary}>Create new sandbox</button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between" style={{ padding: '6px 20px', borderTop: '1px solid var(--line)', background: 'var(--sunk)', fontSize: 10, color: 'var(--tx3)', flexShrink: 0 }}>
          <span>White Room v1.1 Beta</span>
          <span>&copy; 2026 WhiteRoom</span>
        </div>
      </div>
    </div>
  );
}
