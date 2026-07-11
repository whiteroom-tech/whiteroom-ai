'use client';

import { useState } from 'react';

interface Props {
  name: string;
  email: string;
  apiKey: string;
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
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="ml-2 shrink-0 px-3 py-1.5 text-xs font-mono rounded-md border transition-all cursor-pointer"
      style={{
        borderColor: copied ? '#3FE0A0' : '#1B2740',
        color: copied ? '#3FE0A0' : '#A9B8D4',
        background: copied ? 'rgba(63,224,160,.08)' : 'transparent',
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

export function Onboarding({ name, email, apiKey, fleetId, fleetToken, report, isNew }: Props) {
  const [showKey, setShowKey] = useState(isNew);

  if (typeof window !== 'undefined' && fleetToken) {
    localStorage.setItem('wr_fleet_token', fleetToken);
  }

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

        {/* Live Dashboard + Fleet Status row */}
        <div className={`grid gap-4 ${report ? 'grid-cols-[1fr_1fr]' : ''}`}>
          <a
            href="/fleet"
            className="rounded-xl p-6 flex items-center gap-4 transition-all group"
            style={{ background: '#0A1020', border: '1px solid #1B2740', textDecoration: 'none' }}
          >
            <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(56,225,255,.1)' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#38E1FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </div>
            <div>
              <p className="text-base font-semibold group-hover:text-[#38E1FF] transition-colors" style={{ color: '#EAF1FF' }}>Live Dashboard</p>
              <p className="text-sm mt-0.5" style={{ color: '#6B7C9E' }}>Monitor your agents in real time</p>
            </div>
            <svg className="ml-auto shrink-0 opacity-40 group-hover:opacity-100 transition-opacity" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#38E1FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </a>

          {report && (
            <div className="rounded-xl p-6" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
              <p className="text-[11px] font-mono tracking-[.28em] uppercase font-medium mb-3" style={{ color: '#A9B8D4' }}>Fleet Status</p>
              <div className="grid grid-cols-3 gap-3">
                <StatCard label="Agents" value={(report as Record<string, unknown>).agentCount as number ?? 0} />
                <StatCard label="Tasks" value={((report as Record<string, Record<string, number>>).totals?.tasks) ?? 0} />
                <StatCard
                  label="Tokens"
                  value={`${(((report as Record<string, Record<string, number>>).totals?.tokens ?? 0) / 1000).toFixed(1)}K`}
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
            <CopyButton text={apiKey} />
          </div>
        </section>

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
            { label: 'GitHub', href: 'https://github.com/rashadhaque/whiteroom-ai' },
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
