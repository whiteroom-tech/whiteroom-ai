'use client';

import { useState, useEffect } from 'react';
import { addUserFleet } from '@/lib/user-fleets';

interface Props {
  name: string;
  email: string;
  fleetId: string;
  fleetToken: string | null;
  report: Record<string, unknown> | null;
  isNew: boolean;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="ml-2 shrink-0 px-3 py-1.5 text-xs font-mono rounded-md border transition-all"
      style={{
        borderColor: copied ? '#3FE0A0' : '#1B2740',
        color: copied ? '#3FE0A0' : '#A9B8D4',
        background: copied ? 'rgba(63,224,160,.08)' : 'transparent',
        cursor: 'pointer',
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-mono tracking-[.12em] uppercase" style={{ color: '#6B7C9E' }}>{label}</p>
      <div className="flex items-center rounded-lg px-4 py-3" style={{ background: '#070B14', border: '1px solid #15203A' }}>
        <code className="text-sm font-mono flex-1 break-all" style={{ color: '#38E1FF' }}>{code}</code>
        <CopyButton text={code} />
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg p-4" style={{ background: '#070B14', border: '1px solid #15203A' }}>
      <p className="text-[11px] font-mono tracking-[.12em] uppercase" style={{ color: '#6B7C9E' }}>{label}</p>
      <p className="text-2xl font-display font-bold mt-1" style={{ color: '#EAF1FF' }}>{value}</p>
    </div>
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
          <a href="https://whiteroom.tech" className="flex items-center gap-2.5" style={{ textDecoration: 'none' }}>
            <svg className="shrink-0" width="30" height="42" viewBox="0 0 22 30" fill="none"><defs><linearGradient id="wr-lit" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7AECFF"/><stop offset="1" stopColor="#22C8EC"/></linearGradient></defs><rect x=".5" y=".5" width="21" height="29" rx="3" fill="#EAF1FF"/><rect x="3" y="3" width="7" height="11" fill="#0B1018"/><rect x="12" y="3" width="7" height="11" fill="url(#wr-lit)"/><rect x="3" y="16" width="7" height="11" fill="#0B1018"/><rect x="12" y="16" width="7" height="11" fill="#0B1018"/></svg>
            <span className="font-sans font-black text-[32px] leading-none" style={{ letterSpacing: '-.02em' }}>
              <span style={{ color: '#EAF1FF' }}>White</span>
              <span style={{ color: '#38E1FF' }}>Room</span>
            </span>
          </a>
          <div className="flex items-center gap-6">
            <a href="https://whiteroom.tech/#how" className="text-sm transition-colors hover:text-[#EAF1FF]" style={{ color: '#A9B8D4', textDecoration: 'none' }}>How it works</a>
            <a href="https://whiteroom.tech/docs.html" className="text-sm transition-colors hover:text-[#EAF1FF]" style={{ color: '#A9B8D4', textDecoration: 'none' }}>Docs</a>
            <span className="text-sm" style={{ color: '#6B7C9E' }}>{email}</span>
            <a
              href="/auth/sign-out"
              className="inline-flex items-center justify-center h-[38px] px-5 rounded-lg text-sm font-semibold transition-all hover:border-[#38E1FF] hover:text-[#38E1FF]"
              style={{ border: '1px solid #1B2740', color: '#EAF1FF', textDecoration: 'none', fontFamily: "'Chakra Petch', sans-serif" }}
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
                    <p className="text-[11px]" style={{ color: '#4A5B7A' }}>Your key is used only to find your fleet. It is never stored on our servers.</p>
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

          {report && (
            <div className="rounded-xl p-6" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
              <p className="text-[11px] font-mono tracking-[.28em] uppercase font-medium mb-3" style={{ color: '#A9B8D4' }}>Fleet Status</p>
              <div className="grid grid-cols-3 gap-3">
                <StatCard label="Agents" value={(report as Record<string, unknown>).agentCount as number ?? 0} />
                <StatCard label="Tasks" value={((report as Record<string, Record<string, number>>).totals?.tasks) ?? 0} />
                <StatCard label="Tokens" value={`${(((report as Record<string, Record<string, number>>).totals?.tokens ?? 0) / 1000).toFixed(1)}K`} />
              </div>
            </div>
          )}
        </div>

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
