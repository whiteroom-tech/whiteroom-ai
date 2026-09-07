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
  if (status === 'observed') return <span style={{ color: '#22c55e', fontSize: 16 }}>✓</span>;
  if (status === 'failed') return <span style={{ color: '#ef4444', fontSize: 16 }}>✗</span>;
  return <span style={{ color: 'var(--tx3)', fontSize: 16 }}>○</span>;
}

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
        <div className="flex items-center gap-3" style={{ height: 54, flexShrink: 0, borderBottom: '1px solid var(--line)', padding: '0 20px' }}>
          <span style={{ fontSize: 12.5, color: 'var(--tx3)' }}>
            <b style={{ color: 'var(--tx)', fontWeight: 600 }}>Sandbox</b>
            {sandbox?.sandboxId && <span style={{ marginLeft: 8, fontFamily: FONT_MONO, fontSize: 10, color: 'var(--tx3)' }}>/ {sandbox.sandboxId}</span>}
          </span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600, letterSpacing: 1, color: '#d97706', background: 'rgba(217,119,6,0.1)', border: '1px solid #d97706', borderRadius: 4, padding: '2px 8px' }}>TEST ENV</span>
          {sandbox?.isTrial && <span style={{ fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600, letterSpacing: 1, color: 'var(--info)', background: 'var(--info-bg)', border: '1px solid var(--info)', borderRadius: 4, padding: '2px 8px' }}>TRIAL</span>}
          {paused && <span style={{ fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600, letterSpacing: 1, color: '#d97706', background: 'rgba(217,119,6,0.15)', border: '1px solid #d97706', borderRadius: 4, padding: '2px 8px' }}>PAUSED</span>}
          <span style={{ marginLeft: 'auto' }} />
          {expiresIn !== null && expiresIn > 0 && (
            <span style={{ fontSize: 10, fontFamily: FONT_MONO, color: expiresIn < 600 ? '#d97706' : 'var(--tx3)' }}>
              {Math.floor(expiresIn / 60)}m {expiresIn % 60}s remaining
            </span>
          )}
        </div>

        {paused && (
          <div style={{ padding: '10px 20px', background: 'rgba(217,119,6,0.08)', borderBottom: '1px solid #d97706', fontSize: 12, color: '#d97706' }}>
            Paused — your agent is receiving hold responses. Calls are not being forwarded to the LLM.
          </div>
        )}

        <div className="flex-1" style={{ overflowY: 'auto', padding: '24px 32px' }}>
          {error && (
            <div style={{ padding: '10px 14px', background: 'var(--bad-bg)', border: '1px solid var(--bad)', borderRadius: 6, color: 'var(--bad)', fontSize: 12, marginBottom: 16 }}>{error}</div>
          )}

          {/* INTERSTITIAL */}
          {phase === 'interstitial' && (
            <div style={{ maxWidth: 480, margin: '60px auto', textAlign: 'center' }}>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 20, fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>TEST YOUR AGENT</div>
              <p style={{ color: 'var(--tx2)', fontSize: 12.5, marginBottom: 32, lineHeight: 1.6 }}>
                Spin up a sandbox environment to validate that WhiteRoom governance works with your agent before going to production.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <button
                  onClick={() => handleCreateSandbox({ isTrial: true })}
                  disabled={loading}
                  style={{ padding: '12px 20px', borderRadius: 8, background: '#d97706', color: '#fff', fontWeight: 600, fontSize: 13, border: 'none', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}
                >
                  {loading ? 'Creating...' : 'Use trial credits (no API key needed)'}
                </button>
                <div style={{ fontSize: 11, color: 'var(--tx3)', margin: '4px 0' }}>or</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder="sk-ant-... or sk-..."
                    style={{ flex: 1, padding: '10px 12px', borderRadius: 6, border: '1px solid var(--line2)', background: 'var(--sunk)', color: 'var(--tx)', fontSize: 12, fontFamily: FONT_MONO }}
                  />
                  <button
                    onClick={() => handleCreateSandbox({ apiKey: apiKeyInput })}
                    disabled={loading || !apiKeyInput}
                    style={{ padding: '10px 16px', borderRadius: 6, background: 'var(--brand)', color: '#fff', fontWeight: 600, fontSize: 12, border: 'none', cursor: loading || !apiKeyInput ? 'not-allowed' : 'pointer', opacity: loading || !apiKeyInput ? 0.6 : 1 }}
                  >
                    Use my key
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* HISTORY — shown on interstitial */}
          {phase === 'interstitial' && history.length > 0 && (
            <div style={{ maxWidth: 520, margin: '40px auto 0' }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Past Sessions</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {history.map(s => (
                  <div key={s.sandboxId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 8, background: 'var(--card)', border: '1px solid var(--line)', fontSize: 12 }}>
                    <span style={{ width: 56, fontWeight: 600, color: s.overall === 'pass' ? '#22c55e' : s.overall === 'fail' ? 'var(--bad)' : 'var(--tx3)' }}>
                      {s.overall === 'pass' ? 'PASS' : s.overall === 'fail' ? 'FAIL' : 'PARTIAL'}
                    </span>
                    <span style={{ flex: 1, fontFamily: FONT_MONO, fontSize: 10, color: 'var(--tx3)' }}>{s.sandboxId.slice(0, 20)}...</span>
                    <span style={{ fontSize: 10, color: 'var(--tx3)' }}>{new Date(s.destroyedAt).toLocaleDateString()}</span>
                    <span style={{ fontSize: 10, color: 'var(--tx3)' }}>{s.totalTasks} tasks</span>
                    {s.isTrial && <span style={{ fontSize: 9, fontFamily: FONT_MONO, color: 'var(--info)', border: '1px solid var(--info)', borderRadius: 3, padding: '1px 4px' }}>TRIAL</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SETUP RAIL */}
          {phase === 'setup' && sandbox && (
            <div style={{ maxWidth: 520, margin: '40px auto' }}>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 16, fontWeight: 700, letterSpacing: 1, marginBottom: 16 }}>SETUP</div>
              <p style={{ color: 'var(--tx2)', fontSize: 12, marginBottom: 20, lineHeight: 1.6 }}>
                Point your agent at this proxy URL. All LLM calls through it are governed by WhiteRoom.
              </p>
              <div style={{ background: 'var(--sunk)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px', fontFamily: FONT_MONO, fontSize: 11.5, wordBreak: 'break-all', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ flex: 1 }}>{proxyUrl}/v1/messages</span>
                <button
                  onClick={() => navigator.clipboard.writeText(`${proxyUrl}/v1/messages`)}
                  style={{ padding: '4px 10px', borderRadius: 4, background: 'var(--brand)', color: '#fff', fontSize: 10, fontWeight: 600, border: 'none', cursor: 'pointer', flexShrink: 0 }}
                >
                  Copy
                </button>
              </div>
              <button onClick={() => setShowHelp(!showHelp)} style={{ fontSize: 11, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: showHelp ? 10 : 20 }}>
                {showHelp ? '▾ Hide help' : '▸ Help me connect'}
              </button>
              {showHelp && (
                <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px', fontSize: 11.5, color: 'var(--tx2)', lineHeight: 1.7, marginBottom: 20 }}>
                  <p>Replace your LLM base URL with the proxy URL above. For example:</p>
                  <pre style={{ fontFamily: FONT_MONO, fontSize: 10.5, background: 'var(--sunk)', padding: 10, borderRadius: 4, overflowX: 'auto', margin: '8px 0' }}>
{`ANTHROPIC_BASE_URL=${proxyUrl}`}
                  </pre>
                  <p>Your API key stays the same — WhiteRoom proxies the call through to the provider.</p>
                </div>
              )}
              <button
                onClick={() => { setPhase('checklist'); startPolling(userId); }}
                style={{ padding: '10px 20px', borderRadius: 6, background: 'var(--brand)', color: '#fff', fontWeight: 600, fontSize: 12, border: 'none', cursor: 'pointer' }}
              >
                I&apos;m connected — start the test
              </button>
            </div>
          )}

          {/* CHECKLIST */}
          {phase === 'checklist' && (
            <div style={{ maxWidth: 520, margin: '20px auto' }}>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 16, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>
                {status?.agents?.length ? 'RUNNING CHECKS' : 'LISTENING FOR CONNECTIONS...'}
              </div>
              <p style={{ color: 'var(--tx2)', fontSize: 12, marginBottom: 20 }}>
                {status?.agents?.length ? 'Your agent is connected. Watching governance events.' : 'Start your agent and point it at the sandbox proxy URL.'}
              </p>

              <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 24 }}>
                {Object.entries(ASSERTION_LABELS).map(([key, { label, hint, required }]) => {
                  const a = assertions[key];
                  const s = a?.status ?? 'waiting';
                  return (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 8, background: 'var(--card)', border: '1px solid var(--line)' }}>
                      <AssertionIcon status={s} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                          {label}
                          {!required && <span style={{ fontSize: 10, color: 'var(--tx3)', marginLeft: 6 }}>optional</span>}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 1 }}>{hint}</div>
                        {s === 'failed' && a?.diagnostic && (
                          <div style={{ fontSize: 11, color: 'var(--bad)', marginTop: 4 }}>{a.diagnostic}</div>
                        )}
                        {s === 'observed' && a?.metric !== undefined && (
                          <div style={{ fontSize: 10, color: 'var(--ok)', marginTop: 2, fontFamily: FONT_MONO }}>{a.metric}% compression</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ fontSize: 11, color: 'var(--tx3)', marginBottom: 20 }}>
                {(() => {
                  const req = Object.entries(assertions).filter(([k]) => ASSERTION_LABELS[k]?.required);
                  const reqPassed = req.filter(([, v]) => v.status === 'observed').length;
                  const opt = Object.entries(assertions).filter(([k]) => !ASSERTION_LABELS[k]?.required);
                  const optPassed = opt.filter(([, v]) => v.status === 'observed').length;
                  return `${reqPassed} of ${req.length} required checks passed · ${optPassed} of ${opt.length} optional`;
                })()}
              </div>

              {/* Controls */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                {status?.agents?.length ? (
                  paused ? (
                    <button onClick={handleResume} disabled={loading} style={{ padding: '8px 16px', borderRadius: 6, background: 'var(--brand)', color: '#fff', fontWeight: 600, fontSize: 12, border: 'none', cursor: 'pointer' }}>Resume</button>
                  ) : (
                    <button onClick={handlePause} disabled={loading} style={{ padding: '8px 16px', borderRadius: 6, background: '#d97706', color: '#fff', fontWeight: 600, fontSize: 12, border: 'none', cursor: 'pointer' }}>Pause</button>
                  )
                ) : null}
                <button onClick={handleStartDemo} disabled={loading || demoRunning} style={{ padding: '8px 16px', borderRadius: 6, background: demoRunning ? 'var(--sunk)' : '#6366f1', color: demoRunning ? 'var(--tx3)' : '#fff', fontWeight: 600, fontSize: 12, border: demoRunning ? '1px solid var(--line2)' : 'none', cursor: demoRunning ? 'not-allowed' : 'pointer' }}>{demoRunning ? 'Demo running...' : 'Run demo agent'}</button>
                <button onClick={handleReset} disabled={loading} style={{ padding: '8px 16px', borderRadius: 6, background: 'var(--sunk)', color: 'var(--tx2)', fontWeight: 600, fontSize: 12, border: '1px solid var(--line2)', cursor: 'pointer' }}>Start over</button>
                <button onClick={handleExportReport} style={{ padding: '8px 16px', borderRadius: 6, background: 'var(--sunk)', color: 'var(--tx2)', fontWeight: 600, fontSize: 12, border: '1px solid var(--line2)', cursor: 'pointer' }}>Export JSON</button>
                <span style={{ flex: 1 }} />
                {requiredPassed && (
                  <button onClick={handleGoLive} style={{ padding: '8px 20px', borderRadius: 6, background: '#22c55e', color: '#fff', fontWeight: 700, fontSize: 12, border: 'none', cursor: 'pointer' }}>Go live →</button>
                )}
              </div>

              <button onClick={handleDestroy} style={{ fontSize: 11, color: 'var(--bad)', background: 'none', border: 'none', cursor: 'pointer' }}>Destroy sandbox</button>
            </div>
          )}

          {/* GO LIVE */}
          {phase === 'go-live' && (
            <div style={{ maxWidth: 600, margin: '40px auto' }}>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 16, fontWeight: 700, letterSpacing: 1, marginBottom: 12, color: '#22c55e' }}>READY FOR PRODUCTION</div>
              <p style={{ color: 'var(--tx2)', fontSize: 12, marginBottom: 20, lineHeight: 1.6 }}>
                All required checks passed. Follow the cutover guide below to switch to production.
              </p>

              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px', marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx3)', marginBottom: 6 }}>Sandbox Summary</div>
                {Object.entries(assertions).map(([key, val]) => (
                  <div key={key} style={{ fontSize: 11, display: 'flex', gap: 6, marginBottom: 2 }}>
                    <AssertionIcon status={val.status} />
                    <span>{ASSERTION_LABELS[key]?.label ?? key}</span>
                    {val.metric !== undefined && <span style={{ fontFamily: FONT_MONO, color: 'var(--tx3)' }}>{val.metric}%</span>}
                  </div>
                ))}
              </div>

              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '16px', marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Cutover Guide</div>
                <ol style={{ paddingLeft: 18, fontSize: 12, color: 'var(--tx2)', lineHeight: 1.8, margin: 0 }}>
                  <li>Replace your sandbox proxy URL with the production URL:
                    <pre style={{ fontFamily: FONT_MONO, fontSize: 10.5, background: 'var(--sunk)', padding: 8, borderRadius: 4, overflowX: 'auto', margin: '6px 0' }}>ANTHROPIC_BASE_URL={PROXY_URL}/sk-wr-YOUR_KEY/v1/messages</pre>
                  </li>
                  <li>Ensure your production API key is stored via the dashboard&apos;s BYOK setup.</li>
                  <li>Deploy your agent. WhiteRoom will auto-register it on first proxied call.</li>
                  <li>Monitor the Fleet page for the first watch cycle to confirm governance is active.</li>
                </ol>
              </div>

              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '16px', marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>First Hour Checklist</div>
                <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.8 }}>
                  {[
                    'Agent appears on Fleet page with "working" status',
                    'First task completes and appears in audit log',
                    'Watch timer counts down correctly',
                    'Handover triggers at watch expiry',
                    'Agent resumes after rest period',
                    'Handover doc is populated with context summary',
                  ].map((item, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <span style={{ color: 'var(--tx3)', fontSize: 11, flexShrink: 0, width: 16, textAlign: 'right' }}>{i + 1}.</span>
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleExportReport} style={{ padding: '8px 16px', borderRadius: 6, background: 'var(--sunk)', color: 'var(--tx2)', fontWeight: 600, fontSize: 12, border: '1px solid var(--line2)', cursor: 'pointer' }}>Export JSON</button>
                <button onClick={handlePrintReport} style={{ padding: '8px 16px', borderRadius: 6, background: 'var(--sunk)', color: 'var(--tx2)', fontWeight: 600, fontSize: 12, border: '1px solid var(--line2)', cursor: 'pointer' }}>Print report</button>
                <button onClick={() => { handleDestroy(); }} style={{ padding: '8px 16px', borderRadius: 6, background: 'var(--sunk)', color: 'var(--tx2)', fontWeight: 600, fontSize: 12, border: '1px solid var(--line2)', cursor: 'pointer' }}>Close sandbox</button>
              </div>
            </div>
          )}

          {/* EXPIRED */}
          {phase === 'expired' && (
            <div style={{ maxWidth: 480, margin: '60px auto', textAlign: 'center' }}>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 700, letterSpacing: 1, marginBottom: 8 }}>SANDBOX EXPIRED</div>
              <p style={{ color: 'var(--tx2)', fontSize: 12, marginBottom: 24 }}>Your sandbox session has ended. You can view your test report or create a new sandbox.</p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button onClick={handleExportReport} style={{ padding: '10px 18px', borderRadius: 6, background: 'var(--brand)', color: '#fff', fontWeight: 600, fontSize: 12, border: 'none', cursor: 'pointer' }}>View report</button>
                <button onClick={() => { setSandbox(null); setStatus(null); setPhase('interstitial'); }} style={{ padding: '10px 18px', borderRadius: 6, background: 'var(--sunk)', color: 'var(--tx2)', fontWeight: 600, fontSize: 12, border: '1px solid var(--line2)', cursor: 'pointer' }}>Create new sandbox</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
