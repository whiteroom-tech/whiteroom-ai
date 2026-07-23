'use client';

import { useState, useEffect } from 'react';
import { addUserFleet } from '@/lib/user-fleets';

const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL || 'https://proxy.whiteroom.tech';

interface ManagedKey {
  wrKey: string;
  provider: string;
  keyHint: string;
  proxyUrl?: string;
  createdAt?: string;
}

interface Props {
  name: string;
  email: string;
  apiKey: string;
  fleetId: string;
  fleetToken: string | null;
  report: Record<string, unknown> | null;
  isNew: boolean;
  managedKeys: ManagedKey[];
}

function CopyButton({ text, disabled }: { text: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="ml-2 shrink-0 px-3 py-1.5 text-xs font-mono rounded-md border transition-all"
      style={{
        borderColor: copied ? '#3FE0A0' : '#1B2740',
        color: disabled ? '#334155' : copied ? '#3FE0A0' : '#A9B8D4',
        background: copied ? 'rgba(63,224,160,.08)' : 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
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

export function Onboarding({ name, email, apiKey, fleetId, fleetToken, report, isNew, managedKeys: initialKeys }: Props) {
  const [showKey, setShowKey] = useState(isNew);
  const [managedKeys, setManagedKeys] = useState<ManagedKey[]>(initialKeys);
  const [newKeyInput, setNewKeyInput] = useState('');
  const [addingKey, setAddingKey] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [showAddKey, setShowAddKey] = useState(false);

  async function handleAddKey(e: React.FormEvent) {
    e.preventDefault();
    if (!newKeyInput.trim()) return;
    setAddingKey(true);
    setKeyError('');
    try {
      const authKey = fleetToken || apiKey;
      const res = await fetch(`${PROXY_URL}/api/white-room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': authKey },
        body: JSON.stringify({ action: 'store_key', fleet_id: fleetId, api_key: newKeyInput.trim() }),
      });
      const data = await res.json();
      if (data.error) { setKeyError(data.error); return; }
      setManagedKeys(prev => [...prev, { wrKey: data.proxyKey, provider: data.provider, keyHint: data.keyHint, proxyUrl: data.proxyUrl }]);
      setNewKeyInput('');
      setShowAddKey(false);
    } catch { setKeyError('Failed to connect to server.'); }
    finally { setAddingKey(false); }
  }

  useEffect(() => {
    if (fleetToken) {
      localStorage.setItem('wr_fleet_token', fleetToken);
      if (isNew) addUserFleet(fleetToken, fleetId, 'My Fleet');
    }
  }, [fleetToken, fleetId, isNew]);

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
                <StatCard
                  label="Tokens"
                  value={`${(((report as Record<string, Record<string, number>>).totals?.tokens ?? 0) / 1000).toFixed(1)}K`}
                />
              </div>
            </div>
          )}
        </div>

        {/* API Keys */}
        <section className="rounded-xl p-6 space-y-4" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[11px] font-mono tracking-[.28em] uppercase font-medium" style={{ color: '#A9B8D4' }}>Your API Keys</h3>
              <p className="text-xs mt-1" style={{ color: '#4E607F' }}>Register your LLM keys to get a personalized proxy URL. Your actual key is never stored.</p>
            </div>
            {managedKeys.length > 0 && !showAddKey && (
              <button onClick={() => setShowAddKey(true)} className="text-xs font-mono cursor-pointer" style={{ color: '#38E1FF' }}>+ Add key</button>
            )}
          </div>

          {managedKeys.length === 0 && !showAddKey ? (
            <div className="rounded-lg p-5 text-center space-y-3" style={{ background: '#070B14', border: '1px dashed #1B2740' }}>
              <p className="text-sm" style={{ color: '#6B7C9E' }}>Add your Anthropic or OpenAI API key to get started.</p>
              <p className="text-xs" style={{ color: '#4E607F' }}>We only store a secure hash — your actual key is never saved.</p>
              <button onClick={() => setShowAddKey(true)} className="px-5 py-2 rounded-lg text-sm font-semibold cursor-pointer" style={{ background: '#38E1FF', color: '#04222B' }}>
                Add API Key
              </button>
            </div>
          ) : (
            <>
              {managedKeys.map((k, i) => (
                <div key={i} className="flex items-center gap-3 rounded-lg px-4 py-3" style={{ background: '#070B14', border: '1px solid #15203A' }}>
                  <span className="text-[10px] font-mono tracking-wider uppercase px-2 py-0.5 rounded" style={{ background: k.provider === 'anthropic' ? 'rgba(56,225,255,.1)' : 'rgba(99,102,241,.1)', color: k.provider === 'anthropic' ? '#38E1FF' : '#818cf8', border: `1px solid ${k.provider === 'anthropic' ? 'rgba(56,225,255,.2)' : 'rgba(99,102,241,.2)'}` }}>
                    {k.provider}
                  </span>
                  <code className="text-sm font-mono" style={{ color: '#6B7C9E' }}>••••{k.keyHint}</code>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded" style={{ background: 'rgba(34,197,94,.1)', color: '#4ade80', border: '1px solid rgba(34,197,94,.2)' }}>Active</span>
                  <span className="text-[10px] font-mono ml-auto" style={{ color: '#334155' }}>{k.wrKey.length > 14 ? k.wrKey.slice(0, 10) + '...' : k.wrKey}</span>
                </div>
              ))}
            </>
          )}

          {showAddKey && (
            <form onSubmit={handleAddKey} className="space-y-3">
              <input
                type="password"
                value={newKeyInput}
                onChange={(e) => setNewKeyInput(e.target.value)}
                placeholder="sk-ant-... or sk-..."
                className="w-full rounded-lg px-4 py-3 text-sm font-mono outline-none"
                style={{ background: '#070B14', border: '1px solid #1B2740', color: '#EAF1FF' }}
              />
              <div className="flex gap-2">
                <button type="submit" disabled={addingKey || !newKeyInput.trim()} className="px-5 py-2 rounded-lg text-sm font-semibold cursor-pointer disabled:opacity-50" style={{ background: '#38E1FF', color: '#04222B' }}>
                  {addingKey ? 'Adding...' : 'Add Key'}
                </button>
                <button type="button" onClick={() => { setShowAddKey(false); setKeyError(''); setNewKeyInput(''); }} className="px-5 py-2 rounded-lg text-sm cursor-pointer" style={{ color: '#6B7C9E', border: '1px solid #1B2740' }}>
                  Cancel
                </button>
              </div>
              {keyError && <p className="text-xs font-mono" style={{ color: '#FF6B7A' }}>{keyError}</p>}
            </form>
          )}
        </section>

        {/* Getting Started */}
        <section className="rounded-xl p-6 space-y-8" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
          <h3 className="text-[11px] font-mono tracking-[.28em] uppercase font-medium" style={{ color: '#A9B8D4' }}>Get Started in 2 Steps</h3>

          <div className="space-y-8">
            {/* Step 1 */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold" style={{ background: 'rgba(56,225,255,.1)', color: '#38E1FF' }}>1</div>
              <div className="flex-1 space-y-3">
                <div>
                  <p className="text-sm font-semibold" style={{ color: '#EAF1FF' }}>Add one line to your .env file</p>
                  <p className="text-sm mt-1" style={{ color: '#6B7C9E' }}>Your existing API key and code stay exactly the same. WhiteRoom intercepts every call automatically.</p>
                </div>
                {managedKeys.length > 0 ? (
                  <div className="space-y-2">
                    {managedKeys.map((k, i) => (
                      <CodeBlock
                        key={i}
                        label={`Your personalized ${k.provider} proxy URL`}
                        code={`${k.provider === 'anthropic' ? 'ANTHROPIC_BASE_URL' : 'OPENAI_BASE_URL'}=${k.proxyUrl || `https://proxy.whiteroom.tech/${k.wrKey}`}`}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg p-3" style={{ background: '#070B14', border: '1px dashed #1B2740' }}>
                    <p className="text-xs font-mono" style={{ color: '#4E607F' }}>Add an API key above to get your personalized proxy URL</p>
                  </div>
                )}
              </div>
            </div>

            {/* Step 2 */}
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
