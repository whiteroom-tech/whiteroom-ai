'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { rebindFleetKey } from '@/lib/whiteroom/client';
import type { FleetReport } from '@/lib/whiteroom/types';
import { BrandLink, CopyButton, CodeBlock, StatCard, FONT_DISPLAY } from '@whiteroom/ui';

interface Props {
  name: string;
  email: string;
  fleetId: string;
  fleetToken: string | null;
  report: FleetReport | null;
  isNew: boolean;
}

// BYOK: rebind this fleet from the dashboard's placeholder key to the
// customer's real Anthropic key, so real governed agents can run against it.
// The engine stores only a hash of the key — it never leaves the customer's
// control except as a per-request forward to Anthropic (standard BYOK).
function ByokCard({ apiKey, fleetId }: { apiKey: string; fleetId: string }) {
  const [connected, setConnected] = useState(false);
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    createClient().auth.getSession().then(({ data: { session } }) => {
      if (session?.user?.user_metadata?.whiteroom_byok) setConnected(true);
    });
  }, []);

  async function connect() {
    const key = value.trim();
    if (!/^sk-/.test(key) || key.length < 12) { setStatus('error'); setMsg('That does not look like an Anthropic API key (sk-ant-…).'); return; }
    setStatus('saving'); setMsg('');
    try {
      // Authenticate the rebind with the fleet's CURRENT key (this dashboard key).
      const result = await rebindFleetKey(fleetId, key, apiKey);
      if (!result.success) { setStatus('error'); setMsg(result.error || 'Rebind failed.'); return; }
      // Persist only a flag — never the raw provider key — in the account.
      await createClient().auth.updateUser({ data: { whiteroom_byok: true } });
      setConnected(true); setValue('');
    } catch (e) {
      setStatus('error'); setMsg(e instanceof Error ? e.message : 'Network error.');
    }
  }

  return (
    <section className="rounded-xl p-6 space-y-3" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
      <div>
        <h3 className="text-[11px] font-mono tracking-[.28em] uppercase font-medium" style={{ color: '#A9B8D4' }}>Bring Your Own Key</h3>
        <p className="text-xs mt-1" style={{ color: '#4E607F' }}>
          {connected
            ? 'Your fleet is bound to your own Anthropic key — real governed agents can run against it. Use that key as ANTHROPIC_API_KEY when you run agents.'
            : 'Connect your Anthropic key so real agents can run on this fleet. We store only a hash — the key stays yours.'}
        </p>
      </div>
      {connected ? (
        <div className="flex items-center gap-2 rounded-lg px-4 py-3" style={{ background: 'rgba(63,224,160,.06)', border: '1px solid rgba(63,224,160,.2)' }}>
          <span style={{ color: '#3FE0A0' }}>✓</span>
          <span className="text-sm" style={{ color: '#3FE0A0' }}>Provider key connected</span>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={value}
              onChange={(e) => { setValue(e.target.value); setStatus('idle'); }}
              placeholder="sk-ant-…"
              className="flex-1 rounded-lg px-4 py-3 text-sm font-mono"
              style={{ background: '#070B14', border: '1px solid #15203A', color: '#EAF1FF' }}
            />
            <button
              onClick={connect}
              disabled={status === 'saving'}
              className="shrink-0 px-5 py-3 rounded-lg text-sm font-semibold cursor-pointer"
              style={{ background: '#132038', color: '#38E1FF', border: '1px solid #1B2740', opacity: status === 'saving' ? 0.6 : 1 }}
            >
              {status === 'saving' ? 'Connecting…' : 'Connect'}
            </button>
          </div>
          {status === 'error' && <p className="text-xs" style={{ color: '#ef4444' }}>{msg}</p>}
        </>
      )}
    </section>
  );
}

const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL || 'https://proxy.whiteroom.tech';

async function linkFleet(input: string): Promise<{ success: boolean; fleetId?: string; fleetToken?: string; error?: string }> {
  if (input.startsWith('wr_')) {
    const res = await fetch(`${PROXY_URL}/api/white-room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'token_login', fleet_token: input }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) return { success: false, error: data.error || 'Invalid fleet token.' };
    return { success: true, fleetId: data.fleetId, fleetToken: input };
  }
  const res = await fetch(`${PROXY_URL}/api/white-room`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'find_fleet', api_key: input }),
  });
  const data = await res.json();
  if (!res.ok) return { success: false, error: data.error || 'Failed to find fleet.' };
  return { success: true, fleetId: data.fleetId, fleetToken: data.fleetToken };
}

export function Onboarding({ name, email, fleetId, fleetToken, report, isNew }: Props) {
  const [linkInput, setLinkInput] = useState('');
  const [linkStatus, setLinkStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [linkError, setLinkError] = useState('');
  const [showAddFleet, setShowAddFleet] = useState(false);

  useEffect(() => {
    if (fleetToken) {
      localStorage.setItem('wr_fleet_token', fleetToken);
      if (isNew) addUserFleet(fleetToken, fleetId, 'My Fleet');
    }
  }, [fleetToken, fleetId, isNew]);

  const handleLinkFleet = async () => {
    const trimmed = linkInput.trim();
    if (!trimmed) return;
    setLinkStatus('loading');
    setLinkError('');
    const result = await linkFleet(trimmed);
    if (result.success && result.fleetToken && result.fleetId) {
      localStorage.setItem('wr_fleet_token', result.fleetToken);
      await addUserFleet(result.fleetToken, result.fleetId, result.fleetId || 'My Fleet');
      window.location.reload();
    } else {
      setLinkStatus('error');
      setLinkError(result.error || 'Fleet not found. Make sure you\'ve run your agent at least once.');
    }
  };

  return (
    <div className="min-h-screen font-sans" style={{ background: '#070B14', color: '#EAF1FF' }}>
      {/* Header */}
      <header className="sticky top-0 z-50" style={{ background: 'rgba(7,11,20,.74)', backdropFilter: 'blur(16px)', borderBottom: '1px solid #15203A' }}>
        <nav className="max-w-[1200px] mx-auto flex items-center justify-between h-[66px] px-7">
          <BrandLink />
          <div className="flex items-center gap-6">
            <a href="https://whiteroom.tech/#how" className="text-sm transition-colors hover:text-[#EAF1FF]" style={{ color: '#A9B8D4', textDecoration: 'none' }}>How it works</a>
            <a href="https://whiteroom.tech/docs.html" className="text-sm transition-colors hover:text-[#EAF1FF]" style={{ color: '#A9B8D4', textDecoration: 'none' }}>Docs</a>
            <span className="text-sm" style={{ color: '#6B7C9E' }}>{email}</span>
            <a
              href="/auth/sign-out"
              className="inline-flex items-center justify-center h-[38px] px-5 rounded-lg text-sm font-semibold transition-all hover:border-[#38E1FF] hover:text-[#38E1FF]"
              style={{ border: '1px solid #1B2740', color: '#EAF1FF', textDecoration: 'none', fontFamily: FONT_DISPLAY }}
            >
              Sign out
            </a>
          </div>
        </nav>
      </header>

      <main className="max-w-[860px] mx-auto px-7 py-14 space-y-10">
        {/* Welcome banner */}
        {isNew ? (
          <div className="rounded-xl p-6" style={{ border: '1px solid rgba(63,224,160,.2)', background: 'rgba(63,224,160,.04)' }}>
            <h2 className="text-xl font-display font-bold" style={{ color: '#3FE0A0' }}>
              Welcome, {name}
            </h2>
            <p className="text-sm mt-1.5" style={{ color: '#A9B8D4' }}>
              Your account is ready. Follow the steps below to connect your first agent.
            </p>
          </div>
        ) : (
          <div>
            <h2 className="text-xl font-display font-bold">Welcome back, {name}</h2>
          </div>
        )}

        {/* 2-Step Getting Started */}
        <section className="rounded-xl p-6 space-y-8" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
          <h3 className="text-[11px] font-mono tracking-[.28em] uppercase font-medium" style={{ color: '#A9B8D4' }}>Get Started in 3 Steps</h3>

          <div className="space-y-8">
            {/* Step 1: Add .env line */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold" style={{ background: 'rgba(56,225,255,.1)', color: '#38E1FF' }}>1</div>
              <div className="flex-1 space-y-3">
                <div>
                  <p className="text-sm font-semibold" style={{ color: '#EAF1FF' }}>Add one line to your .env file</p>
                  <p className="text-sm mt-1" style={{ color: '#6B7C9E' }}>Your existing API key and code stay exactly the same. WhiteRoom intercepts every call automatically.</p>
                </div>
                <CodeBlock label="Anthropic (Claude)" code="ANTHROPIC_BASE_URL=https://proxy.whiteroom.tech" />
                <CodeBlock label="OpenAI (GPT)" code="OPENAI_BASE_URL=https://proxy.whiteroom.tech/v1" />
              </div>
            </div>

            {/* Step 2: Run your agent */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold" style={{ background: 'rgba(56,225,255,.1)', color: '#38E1FF' }}>2</div>
              <div className="flex-1 space-y-3">
                <div>
                  <p className="text-sm font-semibold" style={{ color: '#EAF1FF' }}>Run your agent</p>
                  <p className="text-sm mt-1" style={{ color: '#6B7C9E' }}>Run your agent exactly as before. WhiteRoom auto-registers and starts governance when your first API call flows through the proxy.</p>
                </div>
                <CodeBlock label="That's it — no CLI commands needed" code="python my_agent.py # or node agent.js, etc." />
              </div>
            </div>

            {/* Step 3: Link your fleet */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold" style={{ background: report ? 'rgba(63,224,160,.15)' : 'rgba(56,225,255,.1)', color: report ? '#3FE0A0' : '#38E1FF' }}>{report ? '✓' : '3'}</div>
              <div className="flex-1 space-y-3">
                <div>
                  <p className="text-sm font-semibold" style={{ color: '#EAF1FF' }}>Link your fleet</p>
                  <p className="text-sm mt-1" style={{ color: '#6B7C9E' }}>
                    {report ? 'Fleet linked successfully.' : 'Enter your API key to connect your agent\'s fleet to this dashboard.'} We never save or store your API key.
                  </p>
                </div>
                {report && !showAddFleet && (
                  <button
                    onClick={() => setShowAddFleet(true)}
                    className="text-xs font-mono transition-colors hover:text-[#38E1FF]"
                    style={{ color: '#6B7C9E', cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}
                  >
                    + Add another fleet
                  </button>
                )}
                {(!report || showAddFleet) && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        value={linkInput}
                        onChange={(e) => { setLinkInput(e.target.value); setLinkStatus('idle'); setLinkError(''); }}
                        onKeyDown={(e) => e.key === 'Enter' && handleLinkFleet()}
                        placeholder="API key or fleet token (wr_...)"
                        className="flex-1 rounded-lg px-4 py-2.5 text-sm font-mono outline-none transition-all"
                        style={{ background: '#070B14', border: '1px solid #1B2740', color: '#38E1FF' }}
                      />
                      <button
                        onClick={handleLinkFleet}
                        disabled={linkStatus === 'loading' || !linkInput.trim()}
                        className="shrink-0 px-5 py-2.5 rounded-lg text-sm font-semibold transition-all"
                        style={{
                          background: linkInput.trim() ? 'rgba(56,225,255,.12)' : 'transparent',
                          border: '1px solid rgba(56,225,255,.4)',
                          color: '#38E1FF',
                          cursor: linkInput.trim() ? 'pointer' : 'default',
                          opacity: linkInput.trim() ? 1 : 0.4,
                        }}
                      >
                        {linkStatus === 'loading' ? 'Linking…' : 'Link'}
                      </button>
                    </div>
                    <p className="text-sm font-medium mt-2" style={{ color: '#38E1FF' }}>🔒 Your key is used once to find your fleet and is never stored.</p>
                    {linkError && (
                      <p className="text-xs" style={{ color: '#FF6B6B' }}>{linkError}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Live Dashboard + Fleet Status */}
        <div className={`grid gap-4 ${report ? 'grid-cols-[1fr_1fr]' : ''}`}>
          {report ? (
          <a
            href="/fleet"
            className="rounded-xl p-6 flex items-center gap-4 transition-all group relative overflow-hidden"
            style={{
              background: 'linear-gradient(135deg, rgba(56,225,255,.12) 0%, rgba(56,225,255,.04) 100%)',
              border: '1.5px solid rgba(56,225,255,.4)',
              textDecoration: 'none',
              boxShadow: '0 0 24px rgba(56,225,255,.08), inset 0 1px 0 rgba(56,225,255,.1)',
            }}
          >
            <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(56,225,255,.15)' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#38E1FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </div>
            <div>
              <p className="text-base font-semibold transition-colors" style={{ color: '#38E1FF' }}>Live Dashboard</p>
              <p className="text-sm mt-0.5" style={{ color: '#A9B8D4' }}>Monitor your agents in real time</p>
            </div>
            <svg className="ml-auto shrink-0 group-hover:translate-x-1 transition-transform" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#38E1FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </a>
          ) : (
          <div
            className="rounded-xl p-6 flex items-center gap-4 relative overflow-hidden"
            style={{
              background: 'linear-gradient(135deg, rgba(107,124,158,.08) 0%, rgba(107,124,158,.03) 100%)',
              border: '1.5px solid rgba(107,124,158,.25)',
              opacity: 0.5,
              cursor: 'not-allowed',
            }}
          >
            <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(107,124,158,.1)' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6B7C9E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </div>
            <div>
              <p className="text-base font-semibold" style={{ color: '#6B7C9E' }}>Live Dashboard</p>
              <p className="text-sm mt-0.5" style={{ color: '#4E607F' }}>Link your fleet first (step 3)</p>
            </div>
          </div>
          )}

          {report && (
            <div className="rounded-xl p-6" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
              <p className="text-[11px] font-mono tracking-[.28em] uppercase font-medium mb-3" style={{ color: '#A9B8D4' }}>Fleet Status</p>
              <div className="grid grid-cols-3 gap-3">
                <StatCard label="Agents" value={report.agentCount ?? 0} />
                <StatCard label="Tasks" value={report.totals?.tasks ?? 0} />
                <StatCard
                  label="Tokens"
                  value={`${((report.totals?.tokens ?? 0) / 1000).toFixed(1)}K`}
                />
              </div>
            </div>
          )}
        </div>

        {/* API Key */}
        <section className="rounded-xl p-6 space-y-3" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[11px] font-mono tracking-[.28em] uppercase font-medium" style={{ color: '#A9B8D4' }}>Your API Key</h3>
              <p className="text-xs mt-1" style={{ color: '#4E607F' }}>Use this key to authenticate all CLI commands and API requests.</p>
            </div>
            <button
              onClick={() => setShowKey(!showKey)}
              className="text-xs font-mono transition-colors cursor-pointer"
              style={{ color: '#6B7C9E' }}
            >
              {showKey ? 'Hide' : 'Reveal'}
            </button>
          </div>
          <div className="flex items-center rounded-lg px-4 py-3" style={{ background: '#070B14', border: '1px solid #15203A' }}>
            <code className="text-sm font-mono flex-1 break-all" style={{ color: '#FFB454' }}>
              {showKey ? apiKey : '•'.repeat(46)}
            </code>
            <CopyButton text={apiKey} disabled={!showKey} />
          </div>
        </section>

        {/* Bring Your Own Key */}
        <ByokCard apiKey={apiKey} fleetId={fleetId} />

        {/* Getting Started */}
        <section className="rounded-xl p-6 space-y-8" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
          <h3 className="text-[11px] font-mono tracking-[.28em] uppercase font-medium" style={{ color: '#A9B8D4' }}>Get Started in 3 Steps</h3>

          <div className="space-y-8">
            {/* Step 1 */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold" style={{ background: 'rgba(56,225,255,.1)', color: '#38E1FF' }}>1</div>
              <div className="flex-1 space-y-3">
                <div>
                  <p className="text-sm font-semibold" style={{ color: '#EAF1FF' }}>Point your agent at WhiteRoom</p>
                  <p className="text-sm mt-1" style={{ color: '#6B7C9E' }}>Change one URL so your agent&apos;s API calls flow through WhiteRoom. No code changes needed — your agent runs exactly as before, but now with governance.</p>
                </div>
                <div className="space-y-2">
                  <CodeBlock label="If you use Anthropic (Claude)" code="export ANTHROPIC_BASE_URL=https://proxy.whiteroom.tech" />
                  <CodeBlock label="If you use OpenAI (GPT)" code="export OPENAI_BASE_URL=https://proxy.whiteroom.tech/v1" />
                </div>
              </div>
            </div>

            {/* Step 2 */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold" style={{ background: 'rgba(56,225,255,.1)', color: '#38E1FF' }}>2</div>
              <div className="flex-1 space-y-3">
                <div>
                  <p className="text-sm font-semibold" style={{ color: '#EAF1FF' }}>Run your agent</p>
                  <p className="text-sm mt-1" style={{ color: '#6B7C9E' }}>Run your agent exactly as before. WhiteRoom auto-registers, auto-pairs, and starts governance automatically when your first API call flows through the proxy.</p>
                </div>
                <CodeBlock label="That's it — no CLI commands needed" code="python my_agent.py # or node agent.js, etc." />
              </div>
            </div>

            {/* Step 3 */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold" style={{ background: 'rgba(56,225,255,.1)', color: '#38E1FF' }}>3</div>
              <div className="flex-1 space-y-3">
                <div>
                  <p className="text-sm font-semibold" style={{ color: '#EAF1FF' }}>View your dashboard</p>
                  <p className="text-sm mt-1" style={{ color: '#6B7C9E' }}>Watch your agents in real time — tasks completed, token savings, handover history, and the full audit trail.</p>
                </div>
                <CodeBlock label="Open in your browser" code="https://app.whiteroom.tech/fleet" />
              </div>
            </div>
          </div>
        </section>

        {/* Footer links */}
        <footer className="flex items-center gap-6 pt-4 pb-8">
          {[
            { label: 'Docs', href: 'https://whiteroom.tech/docs.html' },
            { label: 'SDK', href: 'https://whiteroom.tech/docs.html#sdk' },
            { label: 'OpenAPI', href: 'https://whiteroom.tech/openapi.yaml' },
            { label: 'GitHub', href: 'https://github.com/whiteroom-tech/whiteroom-ai' },
          ].map(link => (
            <a
              key={link.label}
              href={link.href}
              className="text-sm transition-colors hover:text-[#38E1FF]"
              style={{ color: '#6B7C9E' }}
            >
              {link.label}
            </a>
          ))}
        </footer>
      </main>
    </div>
  );
}
